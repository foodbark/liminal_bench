import { W, H, HORIZON, SX, SY, SCALE } from '../state.js';
import { ditherPattern, fillCircle, clamp, rgb, lerpRGB, hex } from '../util/pixel.js';
import { hash2 } from '../util/noise.js';

// The bench, bulletin board, pay phone and pole are part of the painting (art/concept_art_03.png,
// masked as material PROP by tools/build_backdrop.py). This module only knows where they are, and
// draws what changes on top of them: the notes pinned to the cork, snow caps, shadows, lamp glow.
// Measured on the 1024x768 painting; SX/SY scale them for a bigger version of the same picture.
const X = (v) => Math.round(v * SX), Y = (v) => Math.round(v * SY);
const prop = (x, y, w, h, label, baseY, fp, height, hot) => ({ x: X(x), y: Y(y), w: X(w), h: Y(h), label, baseY: Y(baseY), footprint: [X(fp[0]), X(fp[1])], height: Y(height), hot });
export const PROPS = {
  bench: prop(140, 595, 300, 172, 'park bench', 758, [150, 430], 140, true),
  board: prop(445, 472, 212, 295, 'bulletin board', 760, [468, 632], 285, true),
  phone: prop(700, 480, 114, 287, 'pay phone', 762, [737, 772], 270, true),
  pole:  prop(895, 0, 70, 767, undefined, 764, [905, 958], 250, false),
};
export const HOTSPOTS = Object.entries(PROPS).filter(([, p]) => p.hot).map(([id, p]) => ({ id, ...p }));
export const CORK = { x: X(462), y: Y(490), w: X(178), h: Y(110) };
export const LAMP = { x: X(832), y: Y(150) };

function px(ctx, c, x, y, w = 1, h = 1) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }
const SNOW = '#eef2fb', SNOW_SHADE = '#c4cfe6';
function snowCap(ctx, x, y, w, h = 2) { px(ctx, SNOW, x, y - h, w, h); px(ctx, SNOW_SHADE, x, y - 1, w, 1); }

export function drawProps(ctx, state, sunSide, snow) {
  ctx.clearRect(0, 0, W, H);
  for (const n of state.notes) drawNote(ctx, n);
  if (snow) {
    const cap = (x, y, w, h) => snowCap(ctx, X(x), Y(y), X(w), Math.round(h * SCALE));
    cap(152, 612, 276, 3); cap(150, 691, 280, 3);   // bench back and seat
    cap(450, 479, 200, 4);                          // board frame
    cap(706, 486, 102, 3);                          // phone cabinet
    cap(830, 48, 184, 3); cap(802, 121, 64, 3);     // crossarm, lantern shade
  }
}

const PAPER = ['#e8dcc0', '#f2d27a', '#cfd6df', '#f0c9c9', '#c8d8b0', '#f4f1ea'];
export function makeNote(text, opts = {}) {
  // note positions are given on the 1024x768 painting too
  return { text, x: X(opts.x ?? 470), y: Y(opts.y ?? 498), w: X(opts.w ?? 30), h: Y(opts.h ?? 38), paper: opts.paper ?? 0, age: opts.age ?? 0, pin: opts.pin ?? '#c0392b' };
}
function drawNote(ctx, n) {
  const fade = clamp(n.age, 0, 1);
  const paper = lerpRGB(hex(PAPER[n.paper % PAPER.length]), [180, 138, 94], fade * 0.75);
  const ink = lerpRGB([80, 82, 96], [150, 130, 105], fade);
  const x = n.x, y = n.y, w = n.w, h = n.h;
  px(ctx, '#5a4030', x + 1, y + 1, w, h);            // shadow on the cork
  px(ctx, rgb(paper), x, y, w, h);
  px(ctx, rgb(lerpRGB(paper, [0, 0, 0], 0.18)), x + w - 1, y, 1, h);
  px(ctx, rgb(lerpRGB(paper, [0, 0, 0], 0.18)), x, y + h - 1, w, 1);
  // a heading and scribbled lines of "text"
  ctx.fillStyle = rgb(ink); ctx.fillRect(x + 4, y + 5, Math.max(4, (w >> 1) - (hash2(x, y, 6) * 6 | 0)), 2);
  ctx.fillStyle = ditherPattern(ctx, rgb(ink), fade > 0.6 ? 6 : 12);
  for (let ly = y + 10; ly < y + h - 4; ly += 3) ctx.fillRect(x + 4, ly, w - 8 - (hash2(ly, x, 5) * 10 | 0), 1);
  // weathering: curled and torn corners
  if (fade > 0.35) { px(ctx, '#8b6a4a', x, y + h - 1, 3, 1); px(ctx, '#8b6a4a', x, y + h - 2, 2, 1); px(ctx, '#8b6a4a', x, y + h - 3, 1, 1); px(ctx, rgb(lerpRGB(paper, [0, 0, 0], 0.3)), x + 1, y + h - 3, 2, 1); }
  if (fade > 0.7) { px(ctx, '#8b6a4a', x + w - 3, y, 3, 1); px(ctx, '#8b6a4a', x + w - 2, y + 1, 2, 1); px(ctx, '#8b6a4a', x + w - 1, y + 2, 1, 1); }
  // pin
  px(ctx, n.pin, x + (w >> 1) - 1, y + 1, 3, 3); px(ctx, '#ffd0c0', x + (w >> 1) - 1, y + 1, 1, 1);
}

// Sun shadows on the ground, drawn as crisp dithered scanlines.
export function drawShadows(ctx, env) {
  const alt = env.sun.altitude;
  if (alt <= 0.5) return;
  const k = clamp(1 - (env.cond.cover - 0.45) / 0.4, 0, 1) * clamp(alt / 6, 0, 1) * (env.cond.fog ? 0.15 : 1);
  if (k < 0.05) return;
  const az = env.sun.azimuth * Math.PI / 180;
  const level = Math.round(1 + 4 * k);
  ctx.fillStyle = ditherPattern(ctx, env.groundSnow ? '#6d7aa0' : '#0e1216', level);
  for (const p of Object.values(PROPS)) {
    if (!p.height) continue;
    const L = clamp(p.height / Math.max(Math.tan(alt * Math.PI / 180), 0.12), 0, p.height * 2.4);
    const dx = L * 0.42 * Math.sin(az), dy = L * 0.13 * -Math.cos(az);
    const rows = Math.max(3, Math.abs(dy) | 0);
    const [x0, x1] = p.footprint;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const xs = x0 + dx * t, xe = x1 + dx * t;
      const y = Math.round(p.baseY + dy * t);
      if (y < HORIZON + 2 || y >= H) continue;
      ctx.fillRect(Math.round(Math.min(xs, xe)), y, Math.round(Math.abs(xe - xs)) + 3, 1);
    }
  }
}

function fillEllipse(ctx, cx, cy, rx, ry) {
  for (let dy = -ry; dy <= ry; dy++) {
    const w = Math.floor(rx * Math.sqrt(1 - (dy * dy) / (ry * ry)));
    ctx.fillRect(cx - w, cy + dy, 2 * w + 1, 1);
  }
}
// After dark the lantern lights up: a halo around the glass and a warm pool on the ground below.
export function drawLampGlow(ctx, env) {
  const nf = clamp((-env.sun.altitude + 1) / 8, 0, 1) * (env.cond.fog ? 1.4 : 1);
  if (nf < 0.05) return;
  ctx.globalCompositeOperation = 'lighter';
  const c = (a) => `rgb(${(56 * a) | 0},${(42 * a) | 0},${(18 * a) | 0})`;
  const r = (v) => Math.round(v * SCALE), gy = Y(738);
  ctx.fillStyle = ditherPattern(ctx, c(nf), 3); fillCircle(ctx, LAMP.x, LAMP.y, r(34));
  ctx.fillStyle = ditherPattern(ctx, c(nf), 6); fillCircle(ctx, LAMP.x, LAMP.y, r(22));
  ctx.fillStyle = ditherPattern(ctx, c(nf), 10); fillCircle(ctx, LAMP.x, LAMP.y, r(12));
  ctx.fillStyle = ditherPattern(ctx, c(nf * 0.8), 3); fillEllipse(ctx, LAMP.x, gy, r(130), r(28));
  ctx.fillStyle = ditherPattern(ctx, c(nf * 0.8), 6); fillEllipse(ctx, LAMP.x, gy, r(84), r(18));
  ctx.fillStyle = ditherPattern(ctx, c(nf * 0.8), 9); fillEllipse(ctx, LAMP.x, gy, r(42), r(10));
  ctx.fillStyle = `rgb(${(150 * nf) | 0},${(120 * nf) | 0},${(60 * nf) | 0})`; fillCircle(ctx, LAMP.x, LAMP.y, r(6));
  ctx.globalCompositeOperation = 'source-over';
}
