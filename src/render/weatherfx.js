import { W, H, HORIZON, SCALE } from '../state.js';
import { fillCircle, ditherPattern, rgb, mulRGB, lerpRGB, scaleRGB, clamp, plotLine, makeCanvas } from '../util/pixel.js';
import { mulberry32 } from '../util/noise.js';
import { layoutCloud, cloudTones, cloudSprite } from './clouds.js';
import { starAltAz } from '../util/solar.js';
import { skyXY } from './sky.js';
import { LAT } from '../state.js';

const RAD = Math.PI / 180;

// The year's meteor showers: peak (month 0-11, day), width in days, radiant (ra, dec), and how
// many times the sporadic rate they bring at peak.
const SHOWERS = [
  { name: 'Quadrantids', m: 0, d: 3, w: 1.5, ra: 230, dec: 49, k: 6 },
  { name: 'Lyrids', m: 3, d: 22, w: 2, ra: 271, dec: 34, k: 3 },
  { name: 'Eta Aquariids', m: 4, d: 6, w: 4, ra: 338, dec: -1, k: 3 },
  { name: 'Perseids', m: 7, d: 12, w: 4, ra: 48, dec: 58, k: 7 },
  { name: 'Orionids', m: 9, d: 21, w: 3, ra: 95, dec: 16, k: 3 },
  { name: 'Leonids', m: 10, d: 17, w: 2, ra: 152, dec: 22, k: 3 },
  { name: 'Geminids', m: 11, d: 14, w: 3, ra: 112, dec: 33, k: 7 },
];
function showerWeight(sh, now) {
  const peak = new Date(now.getFullYear(), sh.m, sh.d, 12);
  const days = Math.abs(now - peak) / 86400000;
  return Math.exp(-(days * days) / (2 * sh.w * sh.w));
}
function activeShower(now) {
  let best = null, bw = 0.15;
  for (const sh of SHOWERS) { const w = showerWeight(sh, now); if (w > bw) { bw = w; best = sh; } }
  return best;
}
function showerRate(now) {
  let k = 1;
  for (const sh of SHOWERS) k += (sh.k - 1) * showerWeight(sh, now);
  return k;
}
const patCtx = makeCanvas(1, 1)[1];
const ctx_pattern = (cv) => ({ cv });

export class WeatherFX {
  constructor() {
    this.clouds = []; this.rnd = mulberry32(99);
    this.rain = { t: 0, tiles: null, key: '' }; this.snow = { t: 0, tiles: null, key: '' };
    this.flash = 0; this.nextFlash = 4;
    this.meteors = []; this.nextMeteor = 20 + Math.random() * 60;
    this.t = 0;
  }

  update(env, dt) {
    this.t += dt;
    const cover = env.sky ? env.sky.cumulus : env.cond.cover;
    const target = Math.round(cover * 18 + (cover > 0.02 ? 1 : 0));
    while (this.clouds.length < target) this.clouds.push(this.makeCloud(true));
    while (this.clouds.length > target) this.clouds.pop();
    // a storm has one cumulonimbus, kept apart from the fair-weather field
    const wantCb = !!(env.sky && env.sky.cb);
    if (wantCb && !this.cb) this.cb = this.makeCumulonimbus(env);
    if (!wantCb) this.cb = null;
    const sign = Math.sin(env.wind.dir * RAD) >= 0 ? 1 : -1;
    const speed = (1.5 + env.wind.speed * 0.4) * sign * SCALE;
    for (const c of this.clouds) {
      c.x += speed * c.depth * dt;
      if (c.x > W + 40) c.x = -c.w - 40; else if (c.x < -c.w - 40) c.x = W + 40;
    }
    if (this.cb) { this.cb.x += speed * 2.2 * dt; if (this.cb.x > W + 60) this.cb.x = -this.cb.w - 60; else if (this.cb.x < -this.cb.w - 60) this.cb.x = W + 60; }   // valley storms move fast
    // precipitation scrolls as tiled layers; only the phase advances here
    const p = env.cond.precip;
    if (p.type === 'rain') this.rain.t += dt; else this.rain.t = 0;
    if (p.type === 'snow') this.snow.t += dt; else this.snow.t = 0;
    // lightning
    if (env.cond.storm) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) { this.strike(); this.nextFlash = 4 + Math.random() * 10; }
    }
    if (this.flash > 0 && !this.holdBolt) this.flash -= dt;
    // shooting stars: on dark clear nights, one every minute or two, many more during a shower
    const dark = clamp((-env.sun.altitude - 6) / 6, 0, 1) * (1 - env.cond.cover);
    if (dark > 0.2) {
      this.nextMeteor -= dt * showerRate(env.now);
      if (this.nextMeteor <= 0) { this.meteor(env); this.nextMeteor = 45 + Math.random() * 90; }
    }
    for (const m of this.meteors) if (!m.hold) m.t += dt;   // hold: frozen for screenshots
    this.meteors = this.meteors.filter((m) => m.t < m.life);
  }

  makeCloud(anywhere) {
    const r = this.rnd;
    // a third of the clouds are far rows near the cloud horizon, small and flat; the rest ride
    // high and large; a storm gets one cumulonimbus
    const far = r() < 0.35;
    const depth = far ? 0.18 + r() * 0.22 : 0.45 + r() * 0.95;
    const c = layoutCloud(r, depth, { tower: !far });
    // far rows sit above where the mountains hide the cloud horizon
    c.y = far ? Math.floor(HORIZON * (0.34 + r() * 0.14) - c.h) : Math.floor((30 + (1.4 - depth) * 200 + r() * 80) * SCALE);
    c.x = anywhere ? r() * (W + c.w) - c.w : -c.w;
    c.depth = depth;
    return c;
  }

  // A meteor: a streak from near the shower's radiant (or anywhere, for a sporadic), lasting
  // under a second, with a bright head and a tail that thins out through the dither.
  meteor(env) {
    const sh = activeShower(env.now);
    let x0, y0, dx, dy;
    const r = sh ? starAltAz(sh.ra, sh.dec, env.lst, LAT) : null;
    if (r && r.altitude > -10 && r.azimuth > 70 && r.azimuth < 290) {
      // radiate away from the radiant, starting some way out from it
      const rp = skyXY(r.azimuth, r.altitude);
      const a = Math.random() * Math.PI * 2;
      const d0 = (60 + Math.random() * 300) * SCALE;
      x0 = rp.x + Math.cos(a) * d0; y0 = rp.y + Math.sin(a) * d0;
      dx = Math.cos(a); dy = Math.sin(a);
      if (y0 < 0 || y0 > HORIZON * 0.45 || x0 < 0 || x0 > W) { x0 = Math.random() * W; y0 = Math.random() * HORIZON * 0.35; }
    } else {
      x0 = Math.random() * W; y0 = Math.random() * HORIZON * 0.35;
      const a = (Math.random() < 0.5 ? 0.35 : 2.8) + (Math.random() - 0.5) * 0.6;   // down-right or down-left
      dx = Math.cos(a); dy = Math.abs(Math.sin(a));
    }
    const n = Math.hypot(dx, dy) || 1;
    this.meteors.push({ x: x0, y: y0, dx: dx / n, dy: dy / n, v: (700 + Math.random() * 600) * SCALE, len: (90 + Math.random() * 160) * SCALE, t: 0, life: 0.45 + Math.random() * 0.35, bright: Math.random() < 0.15 });
  }

  // A lightning strike: the whole-frame flash plus a jagged bolt with a couple of branches
  // from the storm cell's base down toward the ridge. strike(true) holds it, for screenshots.
  strike(hold) {
    this.flash = 0.16 + Math.random() * 0.12; this.holdBolt = !!hold;
    const cb = this.cb;
    const x0 = cb ? cb.x + cb.w * (0.35 + Math.random() * 0.3) : Math.random() * W;
    const y0 = cb ? cb.y + cb.h - 6 * SCALE : HORIZON * 0.25;
    const y1 = HORIZON * (0.52 + Math.random() * 0.12);   // down to the ridge line
    const walk = (x, y, yEnd, spread) => {
      const pts = [[x, y]];
      while (y < yEnd) {
        y += (10 + Math.random() * 12) * SCALE;
        x += (Math.random() - 0.5) * spread * SCALE;
        pts.push([x, y]);
      }
      return pts;
    };
    const main = walk(x0, y0, y1, 22);
    const branches = [];
    for (let b = 0; b < 2 + Math.floor(Math.random() * 2); b++) {
      const at = main[1 + Math.floor(Math.random() * Math.max(1, main.length - 3))];
      branches.push(walk(at[0], at[1], at[1] + (y1 - at[1]) * (0.3 + Math.random() * 0.4), 34));
    }
    this.bolt = { main, branches };
  }

  makeCumulonimbus(env) {
    const r = mulberry32(1234 + Math.floor(env.wind.dir));
    const dir = Math.sin(env.wind.dir * RAD) >= 0 ? 1 : -1;   // the anvil streams downwind
    const c = layoutCloud(r, 1.75, { tower: true, anvil: true, anvilDir: dir });
    c.depth = 1.3; c.cb = true;
    c.x = Math.floor(W * (dir > 0 ? 0.08 : 0.4) + r() * W * 0.15);
    c.y = Math.floor(HORIZON * 0.36 - c.h);   // its dark base hangs over the ranges, with room for bolts beneath
    return c;
  }

  drawClouds(ctx, env) {
    const cover = env.sky ? env.sky.cumulus : env.cond.cover;
    if (cover <= 0.02 && !(env.sky && env.sky.cb)) return;
    // by day the sun lights the clouds; at night, a moon that is up does, from where it stands
    const moonLit = env.sun.altitude < -6 && env.moon.altitude > 0;
    const src = moonLit ? env.moon : env.sun;
    const onLeft = src.azimuth < 180;
    const altK = clamp(src.altitude / 60, 0, 1);
    const lightX = (onLeft ? -1 : 1) * (1.0 - 0.5 * altK), lightY = -(0.35 + 0.65 * altK);
    const moonP = moonLit ? skyXY(env.moon.azimuth, env.moon.altitude) : null;
    const sorted = [...this.clouds].sort((a, b) => a.depth - b.depth);
    if (this.cb) sorted.push(this.cb);
    for (const c of sorted) {
      // how close this cloud is to the moon: its edges catch the light
      let near = 0;
      if (moonP) {
        const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
        const dist = Math.hypot(cx - moonP.x, cy - moonP.y);
        near = clamp(1 - dist / (Math.max(c.w, c.h) * 1.2 + 120 * SCALE), 0, 1);
      }
      const { tones, key } = cloudTones(env, c.depth, near);
      const sprite = cloudSprite(c, tones, key, lightX, lightY);
      ctx.drawImage(sprite, Math.round(c.x), c.y);
    }
  }

  drawFog(ctx, env) {
    if (!env.cond.fog) return;
    const col = rgb(mulRGB([214, 219, 230], env.pal.ambient));
    const bands = [[-110, -70, 2], [-70, -40, 5], [-40, -10, 8], [-10, 30, 10], [30, 80, 7], [80, 140, 4], [140, 200, 2]];
    for (const [a, b, lv] of bands) { ctx.fillStyle = ditherPattern(ctx, col, lv); ctx.fillRect(0, Math.round(HORIZON + a * SCALE), W, Math.round((b - a) * SCALE)); }
  }

  // A repeating tile of streaks or flakes; two layers scroll at different speeds for depth.
  precipTiles(kind, color, slant, intensity) {
    const T = Math.round(384 * SCALE);
    const tiles = [];
    const rnd = mulberry32(kind === 'rain' ? 7 : 8);
    for (let layer = 0; layer < 2; layer++) {
      const [cv, g] = makeCanvas(T, T);
      g.fillStyle = color;
      const perTile = (kind === 'rain' ? 420 : 380) / (1024 * 572) * T * T;   // the old particle density per area
      const n = Math.round(perTile * intensity * (layer ? 0.5 : 0.65));
      for (let i = 0; i < n; i++) {
        const x = Math.floor(rnd() * T), y = Math.floor(rnd() * T);
        if (kind === 'rain') {
          const len = Math.round((5 + Math.floor(rnd() * 3) * 2.5) * SCALE * (layer ? 0.7 : 1));
          const dx = Math.round(slant * len);
          // draw the streak twice (wrapped) so it tiles seamlessly at the edges
          for (const [ox, oy] of [[0, 0], [-T, 0], [T, 0], [0, -T], [0, T]]) plotLine(g, x + ox, y + oy, x + ox + dx, y + oy + len);
        } else {
          const sz = Math.max(1, Math.round((rnd() > 0.7 ? 2 : 1) * SCALE * (layer ? 0.7 : 1)));
          for (const [ox, oy] of [[0, 0], [-T, 0], [0, -T]]) g.fillRect(x + ox, y + oy, sz, sz);
        }
      }
      tiles.push(ctx_pattern(cv));
    }
    return { T, tiles };
  }

  drawPrecip(ctx, env) {
    // stamp a tile across the frame at the scroll offset
    const tileOver = (c, cv, T, ox, oy) => {
      for (let ty = oy - T; ty < H; ty += T) for (let tx = ox - T; tx < W; tx += T) c.drawImage(cv, tx, ty);
    };
    const amb = env.pal.ambient;
    const p = env.cond.precip;
    const sign = Math.sin(env.wind.dir * RAD) >= 0 ? 1 : -1;
    if (p.type === 'rain' && p.intensity > 0) {
      const color = rgb(lerpRGB(mulRGB([188, 198, 222], amb), [160, 170, 195], 0.3));
      const slant = env.wind.speed * 0.012 * sign;
      const key = `${color}|${slant.toFixed(2)}|${p.intensity.toFixed(1)}`;
      if (this.rain.key !== key) { this.rain.tiles = this.precipTiles('rain', color, slant, p.intensity); this.rain.key = key; }
      const { T, tiles } = this.rain.tiles;
      const vy = 520 * SCALE, vx = env.wind.speed * 3.5 * sign * SCALE;
      for (let layer = 0; layer < 2; layer++) {
        const k = layer ? 0.55 : 1;
        const oy = ((this.rain.t * vy * k) % T + T) % T, ox = ((this.rain.t * vx * k) % T + T) % T;
        tileOver(ctx, tiles[layer].cv, T, ox, oy);
      }
    }
    if (p.type === 'snow' && p.intensity > 0) {
      const k = Math.max(amb[0], 0.55);
      const color = `rgb(${(238 * k) | 0},${(241 * k) | 0},${(252 * k) | 0})`;
      const key = `${color}|${p.intensity.toFixed(1)}`;
      if (this.snow.key !== key) { this.snow.tiles = this.precipTiles('snow', color, 0, p.intensity); this.snow.key = key; }
      const { T, tiles } = this.snow.tiles;
      const vy = 42 * SCALE, drift = env.wind.speed * 1.2 * sign * SCALE;
      for (let layer = 0; layer < 2; layer++) {
        const kk = layer ? 0.6 : 1;
        const oy = ((this.snow.t * vy * kk) % T + T) % T;
        const ox = ((this.snow.t * drift * kk + Math.sin(this.snow.t * (layer ? 0.9 : 1.3)) * 14 * SCALE) % T + T) % T;
        tileOver(ctx, tiles[layer].cv, T, ox, oy);
      }
    }
    for (const m of this.meteors) {
      const fade = 1 - m.t / m.life;
      const hx = m.x + m.dx * m.v * m.t, hy = m.y + m.dy * m.v * m.t;
      const L = m.len * Math.min(1, m.t * 4) * (0.5 + 0.5 * fade);
      const segs = [[0.0, 0.25, m.bright ? '#ffffff' : '#f4f6ff', 16], [0.25, 0.6, '#dfe6ff', 8], [0.6, 1.0, '#b8c4ee', 3]];
      for (const [a, b, color, level] of segs) {
        ctx.fillStyle = level < 16 ? ditherPattern(ctx, color, Math.max(1, Math.round(level * fade))) : color;
        plotLine(ctx, hx - m.dx * L * a, hy - m.dy * L * a, hx - m.dx * L * b, hy - m.dy * L * b);
        if (m.bright && a === 0) plotLine(ctx, hx - m.dx * L * a + 1, hy - m.dy * L * a, hx - m.dx * L * b + 1, hy - m.dy * L * b);
      }
      const u = Math.max(1, Math.round(SCALE * 0.6));
      ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.round(hx) - (u >> 1), Math.round(hy) - (u >> 1), u + (m.bright ? 1 : 0), u + (m.bright ? 1 : 0));
    }
    if (this.flash > 0) {
      ctx.fillStyle = ditherPattern(ctx, '#e8ecff', this.flash > 0.1 ? 3 : 1); ctx.fillRect(0, 0, W, H);
      if (this.bolt) {
        const strokes = [['#9fb4ff', 6, 3], ['#dfe8ff', 16, 1], ['#ffffff', 16, 0]];   // glow, body, core
        const draw = (pts, thin) => {
          for (const [color, level, spread] of strokes) {
            if (thin && spread === 0) continue;
            ctx.fillStyle = level < 16 ? ditherPattern(ctx, color, level) : color;
            const k = Math.max(0, Math.round(spread * SCALE));
            for (let o = -k; o <= k; o++) for (let i = 1; i < pts.length; i++) plotLine(ctx, pts[i - 1][0] + o, pts[i - 1][1], pts[i][0] + o, pts[i][1]);
          }
        };
        for (const b of this.bolt.branches) draw(b, true);
        draw(this.bolt.main, false);
      }
    }
  }
}
