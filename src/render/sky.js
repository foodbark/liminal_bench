import { W, H, HORIZON, SCALE, LAT } from '../state.js';
import { planetPositions } from '../util/planets.js';
import { starAltAz, altAzToRaDec, galacticLat } from '../util/solar.js';
import { bayer, lerpRGB, quant, clamp, rgb, fillCircle, ditherPattern, makeCanvas, lerp, smooth } from '../util/pixel.js';
import { mulberry32, hash2, valueNoise2D as valueNoise2DSky } from '../util/noise.js';

const SKY_BOTTOM = HORIZON + 24;

// Where a sky object at (azimuth, altitude) lands on screen. The scene faces south.
// Where a sun or moon at (azimuth, altitude) lands on screen. The scene faces south: azimuth
// 90..270 runs left to right. Vertically, the ridge line (about half the horizon height) stands
// for RIDGE_DEG of altitude, the way Missoula's hills sit about 8 degrees up from the valley,
// and the top of the frame is about 58 degrees; anything lower than the ridge is behind it.
const RIDGE_Y = Math.round(HORIZON * 0.5), RIDGE_DEG = 8;
export const PX_PER_DEG = RIDGE_Y / 50;   // scene pixels per degree of altitude, for anything sized in sky degrees
export function skyXY(az, alt) {
  return { x: Math.round(W * ((az - 90) / 180)), y: Math.round(RIDGE_Y - (alt - RIDGE_DEG) * PX_PER_DEG) };
}

const mwNoise = valueNoise2DSky(4321);
export function renderSkyGradient(img, env) {
  const { top, horizon, sunColor } = env.pal;
  const data = img.data;
  // the Milky Way shows on dark clear nights, washed out by a bright moon
  const nightK = clamp((-env.sun.altitude - 6) / 8, 0, 1) * (1 - env.cond.cover);
  const moonWash = env.moon.altitude > 0 ? (1 - Math.abs(env.moon.phase - 0.5) * 2) * 0.8 : 0;
  const mw = nightK * (1 - moonWash);
  let mwCell = 0;
  const sun = skyXY(env.sun.azimuth, env.sun.altitude);
  const alt = env.sun.altitude;
  const glowOn = alt > -9;
  const glowStrength = alt < 0 ? clamp((alt + 9) / 9, 0, 1) : 1 - clamp(alt / 40, 0, 0.55);
  const glowK = (1 - (env.cond.shade ?? env.cond.cover) * 0.85) * glowStrength;
  const glowW = alt < 4 ? 0.5 : 0.32;
  for (let y = 0; y < SKY_BOTTOM; y++) {
    const t = Math.pow(y / SKY_BOTTOM, 1.45);
    const base = lerpRGB(top, horizon, t);
    for (let x = 0; x < W; x++) {
      let c = base;
      if (glowOn) {
        const dx = (x - sun.x) / (W * glowW), dy = (y - sun.y) / (H * 0.26);
        const g = Math.exp(-(dx * dx + dy * dy) * 2.2) * glowK;
        if (g > 0.01) c = lerpRGB(base, sunColor, g * 0.75);
      }
      const d = bayer(x, y);
      const i = (y * W + x) * 4;
      if (mw > 0 && (x & 1) === 0) {
        // the Milky Way: galactic latitude of this bit of sky, sampled every 2 px; a soft band
        // about 12 degrees wide with gentle brightness variation along it
        const azP = 90 + 180 * x / W, altP = RIDGE_DEG + (RIDGE_Y - y) / PX_PER_DEG;
        const eq = altAzToRaDec(azP, altP, env.lst, LAT);
        const b = galacticLat(eq.ra, eq.dec);
        // mottled along its length, with dark rifts, like the real thing
        const m1 = mwNoise(eq.ra * 0.06, eq.dec * 0.09), m2 = mwNoise(eq.ra * 0.2 + 7, eq.dec * 0.3 + 3);
        // and thinning toward the ridge, the way haze eats it near the horizon; no hard cut,
        // since the painted ridges sit well below the nominal ridge line in places
        const ext = smooth(clamp((altP + 6) / 20, 0, 1));
        mwCell = Math.exp(-(b * b) / 110) * (0.35 + 0.65 * m1) * (0.6 + 0.4 * m2) * mw * 1.3 * ext;
      }
      if (mwCell > 0.02 && d < mwCell * 0.45) c = lerpRGB(c, [188, 198, 228], 0.22 + 0.2 * mwCell);
      data[i] = quant(c[0], 9, d); data[i + 1] = quant(c[1], 9, d); data[i + 2] = quant(c[2], 9, d); data[i + 3] = 255;
    }
  }
}

// The real sky: the Bright Star Catalog down to magnitude 5.2 (assets/stars.json: ra, dec, mag,
// spectral class), projected for Missoula by sidereal time, so Orion stands in the south on a
// winter evening and the summer Milky Way core sits over the ridge. Loaded on the page; the
// worker never needs it. Stars are drawn into their own layer about ten times a second.
let CATALOG = null;
// The named stars, for the hover caption: J2000 ra and dec in degrees, matched to the catalog
// by position when it loads. Some never rise at Missoula (Canopus, Alpha Centauri, Achernar,
// Hadar, Acrux) and Polaris is behind a viewer facing south; they are listed all the same.
const NAMED = [
  ['Sirius', 101.287, -16.716], ['Canopus', 95.988, -52.696], ['Alpha Centauri', 219.902, -60.834], ['Arcturus', 213.915, 19.182],
  ['Vega', 279.235, 38.784], ['Capella', 79.172, 45.998], ['Rigel', 78.634, -8.202], ['Procyon', 114.825, 5.225],
  ['Achernar', 24.429, -57.237], ['Betelgeuse', 88.793, 7.407], ['Hadar', 210.956, -60.373], ['Altair', 297.696, 8.868],
  ['Acrux', 186.650, -63.099], ['Aldebaran', 68.980, 16.509], ['Antares', 247.352, -26.432], ['Spica', 201.298, -11.161],
  ['Pollux', 116.329, 28.026], ['Fomalhaut', 344.413, -29.622], ['Deneb', 310.358, 45.280], ['Regulus', 152.093, 11.967],
  ['Polaris', 37.955, 89.264], ['Castor', 113.650, 31.888], ['Bellatrix', 81.283, 6.350], ['Alnilam', 84.053, -1.202],
  ['Alnitak', 85.190, -1.943], ['Mintaka', 83.002, -0.299], ['Saiph', 86.939, -9.670],
];
let NAMES = null;   // catalog index -> name
if (typeof window !== 'undefined') {
  fetch(new URL('../../assets/stars.json', import.meta.url)).then((r) => r.json()).then((j) => {
    CATALOG = j; NAMES = new Map();
    for (const [name, ra, dec] of NAMED) {
      let best = -1, bd = 0.5;
      for (let i = 0; i < j.length; i++) {
        const dra = Math.abs(((j[i][0] - ra) % 360 + 540) % 360 - 180) * Math.cos(dec * Math.PI / 180), ddec = j[i][1] - dec;
        const d = Math.hypot(dra, ddec);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) NAMES.set(best, name);
    }
  }).catch(() => {});
}
// the named stars on screen right now, for the hover caption: { x, y, label }
export let starSpots = [];
const STAR_TINT = [[190, 210, 255], [205, 220, 255], [235, 240, 255], [255, 250, 235], [255, 240, 205], [255, 215, 170], [255, 190, 150]];
let terrainMask = null;
export function setStarMask(mask) { terrainMask = mask; }
let starLayer = null, starCtx = null, starStamp = -1, starKey = '';
// the planets on screen right now, for the hover caption: { x, y, label }
export let planetSpots = [];
export function drawStars(ctx, env, t) {
  const nf = clamp((-env.sun.altitude - 3) / 9, 0, 1) * (1 - env.cond.cover) * (env.cond.fog ? 0.4 : 1);
  if (nf <= 0.02 || !CATALOG) return;
  if (!starLayer) { [starLayer, starCtx] = makeCanvas(W, HORIZON); }
  const stamp = Math.floor(t * 10);
  const key = nf.toFixed(2) + '|' + Math.round(env.lst * 4);
  if (stamp !== starStamp || key !== starKey) {
    starStamp = stamp; starKey = key;
    const g = starCtx;
    g.clearRect(0, 0, W, HORIZON);
    // moonlight washes the faint ones out
    const moonUp = env.moon.altitude > 0 ? 1 - Math.abs(env.moon.phase - 0.5) * 2 : 0;
    const limit = 5.2 - moonUp * 1.6;
    const buckets = [], named = [];
    for (let i = 0; i < CATALOG.length; i++) {
      const st = CATALOG[i];
      if (st[2] > limit) break;   // sorted by magnitude
      const pos = starAltAz(st[0], st[1], env.lst, LAT);
      // the scene faces south; the terrain mask hides what is behind the ridges, and the painted
      // ridges run well below the nominal 8 degree line, so stars go down to -8 degrees
      if (pos.azimuth < 92 || pos.azimuth > 268 || pos.altitude < -8) continue;
      const p = skyXY(pos.azimuth, pos.altitude);
      if (p.y < 0 || p.y >= HORIZON || p.x < 0 || p.x >= W) continue;
      if (terrainMask && terrainMask[(p.y * W + p.x) * 4] !== 0) continue;
      const ext = pos.altitude < 10 ? clamp((pos.altitude + 8) / 18, 0.25, 1) : 1;   // haze dims them near the ridge
      const b0 = (0.22 + 0.78 * clamp((5.2 - st[2]) / 6.2, 0, 1)) * nf * ext;   // magnitude 5 faint .. Sirius bright
      // whether a star shows is decided before the twinkle: at dusk the first stars sit right on
      // the cutoff, and a twinkle that could carry them across it blinked them on and off ten
      // times a second. Twinkle is brightness, never existence.
      if (b0 < 0.1) continue;
      // Scintillation: fast and random (a new throw every redraw, ten a second) over a slow
      // swell, strong near the ridge where the air is thick and faint overhead, the way it
      // looks outside. A bright star also flicks between its cross and a plain point.
      const low = clamp(1 - (pos.altitude - 5) / 40, 0.25, 1);
      const amp = 0.3 + 0.4 * low;                  // swing: under half overhead, more near the ridge
      const slow = 0.5 + 0.5 * Math.sin(t * (1.3 + (i % 7) * 0.2) + i);
      // a new throw five times a second (long enough to register), leaning bright: the floor
      // keeps a star from ever dropping to its dimmest, so it sits bright most of the time
      const f = 0.25 + 0.75 * (slow * 0.3 + hash2(i, stamp >> 1, 3) * 0.7);
      const b = b0 * (1 - amp * (1 - f));
      const lvl = Math.min(7, (b * 8) | 0), tint = st[3];
      (buckets[lvl * 8 + tint] ||= []).push(p.x, p.y, st[2], f);
      if (NAMES && NAMES.has(i)) named.push({ x: p.x, y: p.y, label: NAMES.get(i) });
    }
    // The planets: steady (they do not twinkle, which is how people tell them apart), sized by
    // brightness, Venus and Jupiter bigger than any star. Hidden by the ridges and the sheets
    // like the stars, dimmed by the twilight like them, never by the moon.
    const spots = [];
    for (const pl of planetPositions(env.now)) {
      const pos = starAltAz(pl.ra, pl.dec, env.lst, LAT);
      if (pos.azimuth < 92 || pos.azimuth > 268 || pos.altitude < -8) continue;
      const p = skyXY(pos.azimuth, pos.altitude);
      if (p.y < 0 || p.y >= HORIZON || p.x < 0 || p.x >= W) continue;
      if (terrainMask && terrainMask[(p.y * W + p.x) * 4] !== 0) continue;
      const ext = pos.altitude < 10 ? clamp((pos.altitude + 8) / 18, 0.25, 1) : 1;
      const b = (0.22 + 0.78 * clamp((5.2 - pl.mag) / 6.2, 0, 1)) * nf * ext;
      if (b < 0.1) continue;
      const v = clamp(b, 0, 1);
      g.fillStyle = `rgb(${(pl.tint[0] * (0.62 + 0.38 * v)) | 0},${(pl.tint[1] * (0.62 + 0.38 * v)) | 0},${(pl.tint[2] * (0.62 + 0.38 * v)) | 0})`;
      const u = Math.max(1, Math.round(SCALE * 0.6)), x = p.x, y = p.y;
      if (pl.mag < -1.8) { g.fillRect(x - 3 * u, y, 6 * u + 1, u); g.fillRect(x, y - 3 * u, u, 6 * u + 1); g.fillRect(x - u, y - u, 2 * u + 1, 2 * u + 1); g.fillRect(x - (u >> 1), y - (u >> 1), u + 1, u + 1); }
      else if (pl.mag < 0.9) { g.fillRect(x - 2 * u, y, 4 * u + 1, u); g.fillRect(x, y - 2 * u, u, 4 * u + 1); g.fillRect(x - u, y - u, 2 * u + 1, 2 * u + 1); }
      else if (pl.mag < 2.5) g.fillRect(x - (u >> 1), y - (u >> 1), u + 1, u + 1);
      else g.fillRect(x, y, u, u);
      spots.push({ x, y, label: pl.label, mag: pl.mag, altitude: pos.altitude, azimuth: pos.azimuth });
    }
    planetSpots = spots; starSpots = named;
    for (let k = 0; k < buckets.length; k++) {
      const list = buckets[k]; if (!list) continue;
      const lvl = (k / 8) | 0, tint = STAR_TINT[k % 8] || STAR_TINT[3];
      const v = (lvl + 0.5) / 8;
      g.fillStyle = `rgb(${(tint[0] * (0.3 + 0.7 * v)) | 0},${(tint[1] * (0.3 + 0.7 * v)) | 0},${(tint[2] * (0.3 + 0.7 * v)) | 0})`;
      // sizes in scene pixels so the stars survive being shown at half size
      const u = Math.max(1, Math.round(SCALE * 0.6));
      for (let i = 0; i < list.length; i += 4) {
        const x = list[i], y = list[i + 1], mag = list[i + 2], f = list[i + 3];
        // every star changes size as well as tone: the eye reads a twinkle from the size
        if (mag < 1.5) { if (f > 0.4) { g.fillRect(x - 2 * u, y, 4 * u + 1, u); g.fillRect(x, y - 2 * u, u, 4 * u + 1); } g.fillRect(x - u, y - u, 2 * u + 1, 2 * u + 1); }   // the brightest: a cross, its arms flickering
        else if (mag < 3.0) { if (f > 0.35) g.fillRect(x - (u >> 1), y - (u >> 1), u + 1, u + 1); else g.fillRect(x, y, u, u); }
        else if (mag < 4.3) { if (f > 0.3) g.fillRect(x, y, u, u); else g.fillRect(x, y, 1, 1); }
        else g.fillRect(x, y, 1, 1);
      }
    }
  }
  ctx.drawImage(starLayer, 0, 0);
}

// The moon is the user's painted disc (assets/moon.png), scaled to the scene, with the unlit
// part of the phase cut away. It swells near the horizon the way a rising moon looks (the moon
// illusion, kept on purpose), and carries a soft dithered halo at night.
let moonImg = null, moonCanvas = null, moonKey = '';
if (typeof Image !== 'undefined') {
  const im = new Image();
  im.onload = () => { moonImg = im; };
  im.src = new URL('../../assets/moon.png', import.meta.url).href;
}
function moonRadius(alt) {
  const swell = smooth(clamp(1 - (alt - RIDGE_DEG) / 20, 0, 1));   // 1x high up, 1.4x just over the ridge
  return Math.max(6, Math.round(12 * SCALE * (1 + 0.4 * swell)));
}
function moonSprite(phase, r) {
  const key = phase.toFixed(2) + '|' + r;
  if (moonKey === key) return moonCanvas;
  const D = 2 * r + 2, [c, g] = makeCanvas(D, D);
  if (moonImg) { g.imageSmoothingEnabled = true; g.drawImage(moonImg, 1, 1, 2 * r, 2 * r); }
  else { g.fillStyle = '#f1f0e4'; fillCircle(g, r + 1, r + 1, r); }
  // carve the phase: the dark side goes transparent so it never shows as a gray disc by day
  const img = g.getImageData(0, 0, D, D), d = img.data;
  const f = Math.cos(phase * 2 * Math.PI);
  for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
    const dx = x - (r + 1), dy = y - (r + 1);
    if (dx * dx + dy * dy > (r + 0.5) * (r + 0.5)) { d[(y * D + x) * 4 + 3] = 0; continue; }
    const w = Math.sqrt(Math.max(0, r * r - dy * dy));
    const tx = f * w;
    const lit = phase < 0.5 ? dx > tx : dx < -tx;
    const i = (y * D + x) * 4;
    if (!lit) { d[i + 3] = 0; continue; }
    // keep the painting's pattern, drop its color: sunlight on rock, maria light gray, highlands white
    const L = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    const v = Math.round(128 + 127 * Math.pow(L, 0.85));
    d[i] = v; d[i + 1] = v; d[i + 2] = Math.min(255, v + 4);
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  moonCanvas = c; moonKey = key; return c;
}

export function drawMoon(ctx, env) {
  const m = env.moon;
  if (m.altitude < -1) return;
  const p = skyXY(m.azimuth, m.altitude);
  const nf = clamp((-env.sun.altitude + 2) / 10, 0, 1);
  // veils dim it, sheets hide it; cumulus are drawn in front and simply cover it
  const sk = env.sky;
  const sheet = sk ? Math.min(1, (sk.veilHigh || 0) * 0.45 + (sk.veilMid || 0) * 0.75 + (sk.strato || 0) * 0.9 + (sk.stratus || 0) + (sk.nimbo || 0)) : env.cond.cover * 0.9;
  const vis = (0.25 + 0.75 * nf) * (1 - sheet);
  if (vis < 0.05) return;
  const r = moonRadius(m.altitude);
  const bright = 1 - Math.abs(m.phase - 0.5) * 2;
  // a halo only when there is something in the air to make one: ice in a high veil, an
  // altostratus veil, or fog; and then faint. Clear nights get the bare disc.
  const haloK = Math.min(1, ((sk && sk.veilHigh) || 0) * 1.0 + ((sk && sk.veilMid) || 0) * 0.6 + (env.cond.fog ? 0.7 : 0));
  if (nf > 0.3 && bright > 0.3 && haloK > 0.15) {
    ctx.fillStyle = ditherPattern(ctx, '#b9c4e0', haloK > 0.6 ? 2 : 1); fillCircle(ctx, p.x, p.y, Math.round(r * 2.4));
    ctx.fillStyle = ditherPattern(ctx, '#cfd7ee', haloK > 0.6 ? 3 : 2); fillCircle(ctx, p.x, p.y, Math.round(r * 1.5));
  }
  const spr = moonSprite(m.phase, r);
  // opaque at night so nothing shows through the disc; it only fades in daylight
  ctx.globalAlpha = nf > 0.4 ? 1 : vis;
  ctx.drawImage(spr, p.x - (spr.width >> 1), p.y - (spr.height >> 1));
  ctx.globalAlpha = 1;
}

export function drawSun(ctx, env) {
  const alt = env.sun.altitude;
  if (alt < -1.5) return;
  const p = skyXY(env.sun.azimuth, alt);
  const cover = env.cond.shade ?? env.cond.cover;   // the sheets in front do the hiding; a veil leaves a pale disc
  const col = rgb(env.pal.sunColor);
  const bright = rgb(lerpRGB(env.pal.sunColor, [255, 255, 245], clamp(alt / 12, 0, 0.8)));
  const dim = clamp(1 - cover * 1.1, 0, 1);
  const swell = 1 + 0.45 * smooth(clamp(1 - (alt - RIDGE_DEG) / 14, 0, 1));   // a fat sun just over the ridge
  const r = (v) => Math.max(1, Math.round(v * SCALE * swell));
  // a solid disc; only the corona is graded, in rings that thin out through the dither
  if (dim > 0.05) {
    const rings = [[32, 2], [26, 4], [20, 7], [16, 10]];
    for (const [rad, lv] of rings) {
      const level = Math.round(lv * dim);
      if (level < 1) continue;
      ctx.fillStyle = ditherPattern(ctx, col, level); fillCircle(ctx, p.x, p.y, r(rad));
    }
  }
  // the disc itself is always solid; cloud sheets in front of it do the hiding
  ctx.fillStyle = col; fillCircle(ctx, p.x, p.y, r(13));
  ctx.fillStyle = bright; fillCircle(ctx, p.x, p.y, r(11));
}
