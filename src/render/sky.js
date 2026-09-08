import { W, H, HORIZON, SCALE } from '../state.js';
import { bayer, lerpRGB, quant, clamp, rgb, fillCircle, ditherPattern, makeCanvas, lerp, smooth } from '../util/pixel.js';
import { mulberry32 } from '../util/noise.js';

const SKY_BOTTOM = HORIZON + 24;

// Where a sky object at (azimuth, altitude) lands on screen. The scene faces south.
// Where a sun or moon at (azimuth, altitude) lands on screen. The scene faces south: azimuth
// 90..270 runs left to right. Vertically, the ridge line (about half the horizon height) stands
// for RIDGE_DEG of altitude, the way Missoula's hills sit about 8 degrees up from the valley,
// and the top of the frame is about 58 degrees; anything lower than the ridge is behind it.
const RIDGE_Y = Math.round(HORIZON * 0.5), RIDGE_DEG = 8, PX_PER_DEG = RIDGE_Y / 50;
export function skyXY(az, alt) {
  return { x: Math.round(W * ((az - 90) / 180)), y: Math.round(RIDGE_Y - (alt - RIDGE_DEG) * PX_PER_DEG) };
}

export function renderSkyGradient(img, env) {
  const { top, horizon, sunColor } = env.pal;
  const data = img.data;
  const sun = skyXY(env.sun.azimuth, env.sun.altitude);
  const alt = env.sun.altitude;
  const glowOn = alt > -9;
  const glowStrength = alt < 0 ? clamp((alt + 9) / 9, 0, 1) : 1 - clamp(alt / 40, 0, 0.55);
  const glowK = (1 - env.cond.cover * 0.85) * glowStrength;
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
      data[i] = quant(c[0], 9, d); data[i + 1] = quant(c[1], 9, d); data[i + 2] = quant(c[2], 9, d); data[i + 3] = 255;
    }
  }
}

// Fixed star field.
const STARS = (() => {
  const rnd = mulberry32(4242); const s = [];
  for (let i = 0; i < Math.round(420 * SCALE * SCALE); i++) s.push({ x: Math.floor(rnd() * W), y: Math.floor(rnd() * (HORIZON - 10)), b: rnd(), tw: rnd() * 6.28, big: rnd() > 0.93 });
  return s;
})();
let skyStars = null;
// Only stars over open sky: filtered once against the terrain mask when it is known.
export function setStarMask(mask) {
  skyStars = STARS.filter((s) => mask[(s.y * W + s.x) * 4] === 0);
}

// Stars twinkle slowly, so they are drawn into their own layer about ten times a second and
// that layer is stamped each frame (thousands of 1px rects per frame add up on a big canvas).
let starLayer = null, starCtx = null, starStamp = -1, starKey = '';
export function drawStars(ctx, env, t) {
  const nf = clamp((-env.sun.altitude - 3) / 9, 0, 1) * (1 - env.cond.cover) * (env.cond.fog ? 0.4 : 1);
  if (nf <= 0.02) return;
  if (!starLayer) { [starLayer, starCtx] = makeCanvas(W, HORIZON); }
  const stamp = Math.floor(t * 10);
  const key = nf.toFixed(2);
  if (stamp !== starStamp || key !== starKey) {
    starStamp = stamp; starKey = key;
    const g = starCtx;
    g.clearRect(0, 0, W, HORIZON);
    // group by brightness so the fill color changes a few times, not once per star
    const buckets = new Array(8).fill(null).map(() => []);
    for (const s of (skyStars || STARS)) {
      const tw = 0.7 + 0.3 * Math.sin(t * 1.7 + s.tw);
      const b = s.b * nf * tw;
      if (b < 0.15) continue;
      buckets[Math.min(7, (b * 8) | 0)].push(s, b);
    }
    for (let k = 0; k < 8; k++) {
      const list = buckets[k];
      if (!list.length) continue;
      const v = Math.round(120 + 135 * ((k + 0.5) / 8));
      g.fillStyle = `rgb(${v},${v},${Math.min(255, v + 15)})`;
      for (let i = 0; i < list.length; i += 2) {
        const s = list[i], b = list[i + 1];
        if (s.big && b > 0.6) { g.fillRect(s.x - 1, s.y, 3, 1); g.fillRect(s.x, s.y - 1, 1, 3); }
        else g.fillRect(s.x, s.y, 1, 1);
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
    const v = Math.round(150 + 105 * Math.pow(L, 0.8));
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
  const vis = (0.25 + 0.75 * nf) * (1 - env.cond.cover * 0.9);
  if (vis < 0.05) return;
  const r = moonRadius(m.altitude);
  const bright = 1 - Math.abs(m.phase - 0.5) * 2;
  // a halo only when there is something in the air to make one: ice in a high veil, an
  // altostratus veil, or fog; and then faint. Clear nights get the bare disc.
  const sk = env.sky || {};
  const haloK = Math.min(1, (sk.veilHigh || 0) * 1.0 + (sk.veilMid || 0) * 0.6 + (env.cond.fog ? 0.7 : 0));
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
  const cover = env.cond.cover;
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
