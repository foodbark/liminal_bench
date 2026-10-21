// The aircraft in the sky (src/flights.js for the feed and the geometry). By day a speck and a
// contrail: the speck cheated big the way the moon and the paragliders are, since a true-scale
// airliner at 35,000 ft is nothing, and the contrail laid along the aircraft's own path and
// left to drift on the wind up there, fading on the schedule the upper air sets (a few seconds
// in dry air, a streak across the sky in moist), catching the hour's cloud tones, so a sunset
// contrail goes ember like the cloud tops. By night the lights only, the way the beacons on
// Dean Stone are drawn: a white strobe about once a second, a slow red beacon, a faint steady
// pixel between so the eye can follow it across the stars; each aircraft on its own clock.
// The renderer draws them after the sheets and the stars and before the cumulus (an airliner is
// behind a cumulus, and the user wanted it so to start, 2026-10-21), and then lays the terrain
// back over them, so a low one on the approach drops behind Sentinel like a star setting. A
// deck in front dims them the way it dims the stars; fog hides them.
import { W, H, SCALE, HORIZON } from '../state.js';
import { skyXY } from './sky.js';
import { cloudTones } from './clouds.js';
import { lerpRGB, clamp } from '../util/pixel.js';
import { reckon, lookAt, contrailLife, upperWind, flightLabel, STALE_MS } from '../flights.js';

export let flightSpots = [];   // [{ x, y, label }] for the hover caption, canvas pixels

const M_PER_DEG = 111195;
const CONTRAIL_FT = 26000;   // below this the air is too warm for a contrail (and most traffic is cruising well above)
const MAX_POINTS = 700;
const GAP_M = 450;   // the contrail starts this far behind the aircraft

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

export class Flights {
  constructor() {
    this.list = [];       // tracked aircraft: { src, hex, pos, look, xy, trail: [{ lat, lon, alt, t }], clock }
    this.feedAt = 0;
    this.label = '';
  }

  // sync with the latest feed, move everything to `now` (ms), lay and age the contrails
  update(env, dt, feed, now) {
    if (feed && feed.at !== this.feedAt) {
      this.feedAt = feed.at;
      const byHex = new Map(this.list.map((f) => [f.hex, f]));
      for (const a of feed.list) {
        const f = byHex.get(a.hex);
        if (f) { f.src = a; byHex.delete(a.hex); }
        else this.list.push({ src: a, hex: a.hex, pos: null, look: null, xy: null, trail: [], clock: hash(a.hex) });
      }
      // gone from the feed: kept a while on dead reckoning, then dropped
      for (const f of byHex.values()) if (now - f.src.at > STALE_MS) this.list.splice(this.list.indexOf(f), 1);
    }
    const life = contrailLife(env.upper);
    const wind = upperWind(env.upper);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i];
      if (now - f.src.at > STALE_MS * 3) { this.list.splice(i, 1); continue; }
      f.pos = reckon(f.src, now);
      f.look = lookAt(f.pos.lat, f.pos.lon, f.pos.altFt);
      // in the south-facing frame and above the ground: east to west across the sky, anything
      // behind the bench is never seen; the sky projection puts the rest, and the terrain hides
      // what is below the ridges
      const inFrame = f.look.az > 88 && f.look.az < 272 && f.look.el > -1;
      f.xy = inFrame ? skyXY(f.look.az, f.look.el) : null;
      // the contrail: a point every so often along the path, each point then carried on the
      // upper wind and let go when it is older than the air allows
      const tr = f.trail;
      if (f.pos.altFt >= CONTRAIL_FT && f.src.gs > 150) {
        const last = tr[tr.length - 1];
        const far = !last || Math.hypot((f.pos.lat - last.lat) * M_PER_DEG, (f.pos.lon - last.lon) * M_PER_DEG * 0.68) > 220 || now - last.t > 1500;
        if (far) tr.push({ lat: f.pos.lat, lon: f.pos.lon, lat0: f.pos.lat, lon0: f.pos.lon, alt: f.pos.altFt, t: now });   // lat0/lon0: where it was laid, before the wind
      }
      if (tr.length) {
        const dlat = wind.n * dt / M_PER_DEG, dlon = wind.e * dt / (M_PER_DEG * Math.cos(f.pos.lat * Math.PI / 180));
        for (const p of tr) { p.lat += dlat; p.lon += dlon; }
        let drop = 0;
        while (drop < tr.length && now - tr[drop].t > life * 1000) drop++;
        if (drop) tr.splice(0, drop);
        if (tr.length > MAX_POINTS) tr.splice(0, tr.length - MAX_POINTS);
      }
    }
  }

  // how much of an aircraft shows through what is in front of it: a deck hides it, a veil
  // dims it, fog takes it; the cumulus do their own hiding by being drawn in front
  static visibility(env) {
    const sk = env.sky;
    const hide = sk ? Math.min(1, (sk.veilHigh || 0) * 0.3 + (sk.veilMid || 0) * 0.7 + (sk.strato || 0) * 0.9 + (sk.stratus || 0) + (sk.nimbo || 0)) : env.cond.cover * 0.9;
    return env.cond.fog ? 0 : clamp(1 - hide, 0, 1);
  }

  draw(c, env, t) {
    flightSpots = [];
    if (!this.list.length) return;
    const vis = Flights.visibility(env);
    if (vis < 0.12) return;
    const now = Date.now();
    const sun = env.sun.altitude;
    const nightK = clamp((-sun - 2) / 6, 0, 1);   // the lights come up through dusk
    const { tones } = cloudTones(env, 1);
    // the sky's own colour at a height, to fade into: the top colour up high, the horizon's
    // down at the ridge (a trail faded toward the top's blue went blue against a pink morning)
    const top = env.pal.top || env.pal.horizon, hz = env.pal.horizon;
    const skyAt = (y) => lerpRGB(top, hz, clamp(y / HORIZON, 0, 1) ** 1.5);
    let lit = lerpRGB(tones[0], [255, 255, 255], 0.25);
    // the sunset ember: a contrail ten kilometres up is lit from below while the sun is on
    // the horizon, and keeps the sun past the ground's sunset (3.3 degrees below for a trail at
    // 10 km), so it takes the ember the cloud undersides get, strongest just after the sun is
    // down for the meadow
    const emberK = clamp(1 - Math.abs(sun + 0.8) / 4.5, 0, 1) * (1 - (env.cond.shade ?? env.cond.cover) * 0.5);
    if (emberK > 0) lit = lerpRGB(lit, lerpRGB(env.pal.sunColor, [255, 120, 70], 0.45), emberK * 0.9);
    const life = contrailLife(env.upper) * 1000;
    const th = Math.max(1, Math.round(SCALE * 0.6));   // the fresh trail's thickness in pixels
    const sp = Math.max(2, Math.round(SCALE));          // the speck
    const rgb = (k) => `rgb(${k[0] | 0},${k[1] | 0},${k[2] | 0})`;
    // the trail's tones by age and height, mixed toward the sky as it thins, and dimmed by what is in front
    const toneCache = new Map();
    const trailTone = (b, y) => {
      const band = Math.min(5, Math.floor(y / HORIZON * 6)), key = b * 8 + band;
      let c = toneCache.get(key);
      if (!c) { const sky = skyAt((band + 0.5) / 6 * HORIZON); c = rgb(lerpRGB(lerpRGB(lit, sky, 0.1 + 0.75 * (b + 0.5) / 8), sky, 1 - vis)); toneCache.set(key, c); }
      return c;
    };
    for (const f of this.list) {
      // The contrail first, so the speck sits on its head. The sky mapping lays azimuth and
      // elevation out on a grid, so a straight flight path bows across it the way a great
      // circle bows on a map, and to the eye a contrail is dead straight (the user, 2026-10-21:
      // "too much curve"; and with only the trail straightened tail to head, the plane "still
      // following the curve", veering off its own trail). So the plane keeps its true place and
      // the trail is laid straight along the plane's direction of travel on the screen, each
      // point at its true on-screen distance behind the head (the length the grid path would
      // have had), so the two always agree; the wind's sideways drift is an offset across the
      // line. The far end of a long trail sits off the grid, which is where the bow was.
      const tr = f.trail;
      if (tr.length > 1 && nightK < 1 && f.xy) {
        const tg = tangent(f);
        if (tg) {
          const cosL = Math.cos(f.pos.lat * Math.PI / 180);
          let prev = f.xy, prevGrid = f.xy, L = 0, prevOut = null;
          for (let i = tr.length - 1; i >= 0; i--) {
            const p = tr[i];
            const lk = lookAt(p.lat0, p.lon0, p.alt);
            if (lk.az <= 88 || lk.az >= 272 || lk.el < -1) break;   // the path ran out of the frame
            const grid = skyXY(lk.az, lk.el);
            L += Math.hypot(grid.x - prevGrid.x, grid.y - prevGrid.y);
            prevGrid = grid;
            // the wind's drift since the point was laid, its part across the track
            const dn = (p.lat - p.lat0) * M_PER_DEG, de = (p.lon - p.lon0) * M_PER_DEG * cosL;
            const w = de * tg.uy - dn * tg.ux;
            const x = Math.round(f.xy.x - tg.dx * L + tg.sx * w), y = Math.round(f.xy.y - tg.dy * L + tg.sy * w);
            // the trail forms a little way behind the aircraft, not at it: the vapour takes a
            // few hundred metres to condense (the user, 2026-10-21)
            const behind = ((f.pos.lat - p.lat0) * M_PER_DEG) * tg.uy + ((f.pos.lon - p.lon0) * M_PER_DEG * cosL) * tg.ux;
            if (prevOut && behind > GAP_M && y > -4 && prevOut.y > -4 && y < H && prevOut.y < H) {
              const age = clamp((now - p.t) / life, 0, 1);
              const bk = Math.min(7, Math.floor(age * 8));
              // the trail spreads as it ages into a soft band: a wide faint sheath and a core
              const core = th + (age > 0.25 ? 1 : 0);
              const wide = core + Math.round(age * 3 * SCALE);
              if (wide > core) { c.fillStyle = trailTone(Math.min(7, bk + 2), (y + prevOut.y) / 2); segment(c, prevOut.x, prevOut.y, x, y, wide); }
              c.fillStyle = trailTone(bk, (y + prevOut.y) / 2);
              segment(c, prevOut.x, prevOut.y, x, y, core);
            }
            prevOut = behind > GAP_M ? { x, y } : prevOut;
            void prev;
          }
        }
      }
      if (!f.xy) continue;
      const { x, y } = f.xy;
      if (y < -sp || y > H || x < -sp || x > W + sp) continue;
      const label = flightLabel(f.src, f.pos.altFt, f.look.km);
      flightSpots.push({ x, y, label });
      // by day the speck, through dusk fading as the lights come up
      const sky = skyAt(y);
      if (nightK < 1) {
        const k = (1 - nightK) * vis;
        c.fillStyle = rgb(lerpRGB(sky, lit, k));
        c.fillRect(x - (sp >> 1), y, sp, Math.max(1, Math.round(sp * 0.6)));
      }
      if (nightK > 0) {
        const ph = (t + f.clock * 7) % 1;                // the strobe's second, on this aircraft's clock
        const bph = ((t + f.clock * 11) / 1.3) % 1;      // the beacon's
        const k = nightK * vis;
        // a faint steady pixel so the eye can follow it between flashes
        c.fillStyle = rgb(lerpRGB(sky, [200, 204, 214], 0.45 * k));
        c.fillRect(x, y, 1, 1);
        // the red anti-collision beacon, a slow blink
        if (bph < 0.28) { c.fillStyle = rgb(lerpRGB(sky, [255, 48, 40], k)); c.fillRect(x - (sp >> 2), y, Math.max(1, sp >> 1), Math.max(1, sp >> 1)); }
        // the white strobe: a double flash about once a second
        if (ph < 0.06 || (ph > 0.13 && ph < 0.19)) { c.fillStyle = rgb(lerpRGB(sky, [255, 255, 255], k)); c.fillRect(x - (sp >> 1), y - (sp >> 2), sp, Math.max(1, sp - 1)); }
      }
    }
  }

  hit(p) {
    const r = 10 * (W / 1024);
    for (const s of flightSpots) if (Math.abs(p.x - s.x) < r && Math.abs(p.y - s.y) < r) { this.label = s.label; return true; }
    return false;
  }
}

// The plane's direction of travel on the screen (a unit vector), from its grid positions a
// little ahead and behind along its track, and the screen offset of a metre sideways to the
// track, by a numerical step; null when the step leaves the frame.
function tangent(f) {
  const th = f.src.track * Math.PI / 180, ux = Math.sin(th), uy = Math.cos(th);
  const cosL = Math.cos(f.pos.lat * Math.PI / 180), alt = f.pos.altFt;
  const at = (d, side) => {
    const lat = f.pos.lat + (d * uy - side * ux) / M_PER_DEG, lon = f.pos.lon + (d * ux + side * uy) / (M_PER_DEG * cosL);
    const lk = lookAt(lat, lon, alt);
    return lk.az > 88 && lk.az < 272 && lk.el > -1 ? skyXY(lk.az, lk.el) : null;
  };
  const a = at(-2000, 0), b = at(2000, 0), o = at(0, 0), q = at(0, 1000);
  if (!a || !b || !o || !q) return null;
  const dx = b.x - a.x, dy = b.y - a.y, n = Math.hypot(dx, dy);
  if (n < 0.5) return null;
  return { ux, uy, dx: dx / n, dy: dy / n, sx: (q.x - o.x) / 1000, sy: (q.y - o.y) / 1000 };
}

// a line `w` pixels thick, plotted pixel by pixel (no canvas strokes: they anti-alias)
function segment(ctx, x0, y0, x1, y1, w) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  const steep = -dy > dx;   // thicken across the line's main direction
  const off = -(w >> 1);
  let err = dx + dy;
  for (;;) {
    if (steep) ctx.fillRect(x0 + off, y0, w, 1); else ctx.fillRect(x0, y0 + off, 1, w);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
