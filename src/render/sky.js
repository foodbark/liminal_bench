import { W, H, HORIZON } from '../state.js';
import { bayer, lerpRGB, quant, clamp, rgb, fillCircle, ditherPattern, makeCanvas, lerp } from '../util/pixel.js';
import { mulberry32 } from '../util/noise.js';

const SKY_BOTTOM = HORIZON + 24;

// Where a sky object at (azimuth, altitude) lands on screen. The scene faces south.
export function skyXY(az, alt) {
  return { x: Math.round(W * ((az - 90) / 180)), y: Math.round(HORIZON - alt * 7) };
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
  for (let i = 0; i < 420; i++) s.push({ x: Math.floor(rnd() * W), y: Math.floor(rnd() * (HORIZON - 10)), b: rnd(), tw: rnd() * 6.28, big: rnd() > 0.93 });
  return s;
})();

export function drawStars(ctx, env, t) {
  const nf = clamp((-env.sun.altitude - 3) / 9, 0, 1) * (1 - env.cond.cover) * (env.cond.fog ? 0.4 : 1);
  if (nf <= 0.02) return;
  for (const s of STARS) {
    const tw = 0.7 + 0.3 * Math.sin(t * 1.7 + s.tw);
    const b = s.b * nf * tw;
    if (b < 0.15) continue;
    const v = Math.round(120 + 135 * b);
    ctx.fillStyle = `rgb(${v},${v},${Math.min(255, v + 15)})`;
    if (s.big && b > 0.6) { ctx.fillRect(s.x - 1, s.y, 3, 1); ctx.fillRect(s.x, s.y - 1, 1, 3); }
    else ctx.fillRect(s.x, s.y, 1, 1);
  }
}

let moonCanvas = null, moonKey = '';
function moonSprite(phase) {
  const key = phase.toFixed(2);
  if (moonKey === key) return moonCanvas;
  const r = 9; const [c, g] = makeCanvas(2 * r + 3, 2 * r + 3);
  const f = Math.cos(phase * 2 * Math.PI);
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.sqrt(r * r - dy * dy);
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r + 0.5) continue;
      const tx = f * w;
      const lit = phase < 0.5 ? dx > tx : dx < -tx;
      const crater = ((dx * 7 + dy * 13) % 5 === 0 && (dx + dy) % 3 === 0);
      if (!lit) continue; // the dark side stays transparent so it never shows as a gray disc by day
      g.fillStyle = crater ? '#c9cbc0' : '#f1f0e4';
      g.fillRect(dx + r + 1, dy + r + 1, 1, 1);
    }
  }
  moonCanvas = c; moonKey = key; return c;
}

export function drawMoon(ctx, env) {
  const m = env.moon;
  if (m.altitude < -1) return;
  const p = skyXY(m.azimuth, m.altitude);
  const nf = clamp((-env.sun.altitude + 2) / 10, 0, 1);
  const vis = (0.25 + 0.75 * nf) * (1 - env.cond.cover * 0.9);
  if (vis < 0.05) return;
  const spr = moonSprite(m.phase);
  ctx.globalAlpha = vis;
  ctx.drawImage(spr, p.x - 10, p.y - 10);
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
  if (dim > 0.05) {
    ctx.fillStyle = ditherPattern(ctx, col, Math.round(4 * dim)); fillCircle(ctx, p.x, p.y, 18);
    ctx.fillStyle = ditherPattern(ctx, col, Math.round(8 * dim)); fillCircle(ctx, p.x, p.y, 13);
  }
  ctx.fillStyle = ditherPattern(ctx, bright, Math.round(lerp(4, 16, dim))); fillCircle(ctx, p.x, p.y, 9);
}
