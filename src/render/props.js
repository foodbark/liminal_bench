import { W, H, HORIZON } from '../state.js';
import { plotLine, plotWire, ditherPattern, fillCircle, clamp, rgb, lerpRGB, hex } from '../util/pixel.js';
import { hash2, mulberry32 } from '../util/noise.js';

// Screen-space rectangles for the things you can look at, plus what casts shadows.
export const PROPS = {
  board: { x: 122, y: 290, w: 166, h: 182, label: 'bulletin board', baseY: 470, footprint: [136, 274], height: 170, hot: true },
  bench: { x: 418, y: 414, w: 188, h: 66, label: 'park bench', baseY: 478, footprint: [426, 598], height: 34, hot: true },
  phone: { x: 720, y: 286, w: 50, h: 90, label: 'pay phone', baseY: 475, footprint: [754, 766], height: 0, hot: true },
  pole:  { x: 752, y: 66, w: 16, h: 410, baseY: 475, footprint: [754, 766], height: 400, hot: false },
};
export const HOTSPOTS = Object.entries(PROPS).filter(([, p]) => p.hot).map(([id, p]) => ({ id, ...p }));
export const LAMP = { x: 745, y: 297 };

function px(ctx, c, x, y, w = 1, h = 1) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }

export function drawProps(ctx, state, sunSide, snow) {
  ctx.clearRect(0, 0, W, H);
  drawMidPines(ctx, sunSide, snow);
  drawPole(ctx, snow);
  drawPayphone(ctx, snow);
  drawBoard(ctx, state.notes, snow);
  drawBench(ctx, snow);
}
const SNOW = '#eef2fb', SNOW_SHADE = '#c4cfe6';
function snowCap(ctx, x, y, w, h = 2) { px(ctx, SNOW, x, y - h, w, h); px(ctx, SNOW_SHADE, x, y - 1, w, 1); }

function drawPine(ctx, x, baseY, th, sunSide, seed, snow) {
  const rnd = mulberry32(seed);
  const wob = 0.85 + rnd() * 0.4;
  for (let i = 0; i < th; i++) {
    const y = baseY - th + i;
    const tier = i % 5;
    const hw = Math.max(0, Math.floor(i * 0.42 * wob) - (tier === 0 ? 2 : tier === 1 ? 1 : 0));
    for (let dx = -hw; dx <= hw; dx++) {
      const side = dx * sunSide;
      const edge = Math.abs(dx) > hw - 2;
      const c = side < -hw * 0.3 ? '#1b3b2b' : side > hw * 0.35 && edge ? '#4f8a4a' : (hash2(x + dx, y, 8) > 0.82 ? '#2c5a3a' : '#25503a');
      px(ctx, c, x + dx, y);
      if (snow && (tier === 0 || (tier === 1 && Math.abs(dx) > hw - 2)) && hash2(x + dx, y, 9) > 0.25) px(ctx, Math.abs(dx) > hw - 1 ? SNOW_SHADE : SNOW, x + dx, y);
    }
  }
  px(ctx, '#3a2a1e', x - 1, baseY, 3, 4);
  px(ctx, '#2a1e14', x + 1, baseY, 1, 4);
}
function drawMidPines(ctx, sunSide, snow) {
  drawPine(ctx, 42, 392, 66, sunSide, 1, snow);
  drawPine(ctx, 78, 386, 48, sunSide, 2, snow);
  drawPine(ctx, 18, 384, 44, sunSide, 5, snow);
  drawPine(ctx, 902, 390, 74, sunSide, 3, snow);
  drawPine(ctx, 936, 396, 56, sunSide, 4, snow);
  drawPine(ctx, 866, 382, 40, sunSide, 6, snow);
}

function drawPole(ctx, snow) {
  const x = 754, top = 70, bottom = 475;
  px(ctx, '#7a5a3a', x, top, 12, bottom - top);
  px(ctx, '#9a7650', x, top, 2, bottom - top);
  px(ctx, '#553b24', x + 9, top, 3, bottom - top);
  for (let y = top; y < bottom; y++) if (hash2(0, y, 12) > 0.8) px(ctx, '#5e4228', x + 2 + Math.floor(hash2(1, y, 13) * 7), y, 2, 1);
  px(ctx, '#4a3320', x - 2, top - 4, 16, 4); px(ctx, '#6b4a2c', x - 2, top - 4, 16, 1);
  // crossarm
  px(ctx, '#6e4f33', 712, 96, 96, 7); px(ctx, '#8c6a45', 712, 96, 96, 1); px(ctx, '#4a3320', 712, 102, 96, 1);
  ctx.fillStyle = '#4a3320';
  plotLine(ctx, 753, 122, 726, 103); plotLine(ctx, 753, 123, 726, 104);
  plotLine(ctx, 766, 122, 793, 103); plotLine(ctx, 766, 123, 793, 104);
  // insulators + wires
  for (const ix of [718, 742, 778, 802]) {
    px(ctx, '#8fa9be', ix, 88, 5, 8); px(ctx, '#d7e3ea', ix + 1, 87, 3, 1); px(ctx, '#5f7386', ix, 94, 5, 2); px(ctx, '#b7c9d6', ix + 1, 89, 1, 4);
  }
  ctx.fillStyle = '#15131a';
  plotWire(ctx, 718, 88, -1, 42, 26); plotWire(ctx, 742, 88, -1, 56, 30);
  plotWire(ctx, 782, 88, W, 46, 24); plotWire(ctx, 806, 88, W, 60, 28);
  if (snow) { snowCap(ctx, 712, 96, 96, 3); snowCap(ctx, 752, 66, 16, 3); }
}

function drawPayphone(ctx, snow) {
  // hood and lamp
  px(ctx, '#3a3f46', 722, 288, 46, 8); px(ctx, '#5a606a', 722, 288, 46, 1); px(ctx, '#23272c', 722, 295, 46, 1);
  px(ctx, '#f5e6b0', 739, 296, 12, 2); px(ctx, '#d9c48a', 739, 298, 12, 1);
  // box
  px(ctx, '#3e4a55', 724, 300, 40, 64);
  px(ctx, '#6d7d8c', 726, 302, 36, 60);
  px(ctx, '#8b9aa8', 726, 302, 2, 60); px(ctx, '#2f3840', 726, 360, 36, 2); px(ctx, '#556470', 760, 302, 2, 60);
  // sign band
  px(ctx, '#1f4fa0', 728, 304, 32, 10); px(ctx, '#3c6fd0', 728, 304, 32, 1);
  for (const [sx, sw] of [[731, 3], [736, 2], [740, 4], [746, 3], [751, 4]]) px(ctx, '#e9eef5', sx, 307, sw, 3);
  px(ctx, '#e9eef5', 731, 310, 1, 1); px(ctx, '#e9eef5', 741, 310, 1, 1);
  // face panel
  px(ctx, '#3e4a55', 736, 317, 24, 41); px(ctx, '#5a6a78', 737, 318, 22, 39);
  px(ctx, '#2d353d', 739, 321, 18, 21);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
    px(ctx, '#dfe6ec', 741 + c * 6, 323 + r * 5, 3, 3); px(ctx, '#9aa5ad', 741 + c * 6, 325 + r * 5, 3, 1);
  }
  px(ctx, '#1c2024', 740, 345, 6, 2); px(ctx, '#8b9aa8', 740, 347, 6, 1);
  px(ctx, '#1c2024', 748, 350, 9, 5); px(ctx, '#8b9aa8', 749, 351, 7, 1);
  // handset on the left
  px(ctx, '#3e4a55', 724, 318, 10, 4); px(ctx, '#3e4a55', 724, 342, 10, 4);
  px(ctx, '#1d2024', 726, 314, 7, 36); px(ctx, '#3a3f46', 726, 314, 1, 36);
  px(ctx, '#1d2024', 724, 311, 11, 6); px(ctx, '#3a3f46', 724, 311, 11, 1);
  px(ctx, '#1d2024', 724, 346, 11, 6); px(ctx, '#3a3f46', 724, 346, 1, 6);
  ctx.fillStyle = '#1d2024';
  plotWire(ctx, 729, 352, 750, 364, 20);
  if (snow) snowCap(ctx, 722, 288, 46, 3);
}

function drawBench(ctx, snow) {
  const wood = (x, y, w, h) => { px(ctx, '#a06a33', x, y, w, h); px(ctx, '#c58a4a', x, y, w, 1); px(ctx, '#6a4220', x, y + h - 1, w, 1); px(ctx, '#7f5228', x + w - 1, y, 1, h); };
  const iron = (x, y, w, h) => { px(ctx, '#2b2b30', x, y, w, h); px(ctx, '#4a4b55', x, y, 1, h); };
  // back posts + arm rests
  iron(428, 414, 4, 36); iron(592, 414, 4, 36);
  iron(422, 434, 12, 3); iron(590, 434, 12, 3);
  iron(422, 437, 2, 12); iron(600, 437, 2, 12);
  // back slats
  wood(426, 418, 172, 5); wood(426, 425, 172, 5); wood(426, 432, 172, 5);
  px(ctx, '#3a2414', 426, 423, 172, 2); px(ctx, '#3a2414', 426, 430, 172, 2);
  // seat slats
  wood(420, 448, 184, 3); wood(420, 452, 184, 3); wood(420, 456, 184, 3);
  px(ctx, '#3a2414', 420, 451, 184, 1); px(ctx, '#3a2414', 420, 455, 184, 1);
  px(ctx, '#5a381a', 420, 459, 184, 2);
  // legs, stretcher, feet
  iron(430, 461, 4, 17); iron(590, 461, 4, 17); iron(509, 461, 4, 17);
  iron(434, 468, 156, 2);
  iron(427, 476, 10, 2); iron(587, 476, 10, 2); iron(506, 476, 10, 2);
  if (snow) { snowCap(ctx, 420, 448, 184, 3); snowCap(ctx, 426, 418, 172, 2); snowCap(ctx, 422, 434, 12, 2); snowCap(ctx, 590, 434, 12, 2); }
}

const PAPER = ['#efe6c8', '#f2d27a', '#cfe2f0', '#f0c9c9', '#e6f0d0', '#f7f2e8'];
export function makeNote(text, opts = {}) {
  return { text, x: opts.x ?? 140, y: opts.y ?? 320, w: opts.w ?? 30, h: opts.h ?? 22, paper: opts.paper ?? 0, age: opts.age ?? 0, pin: opts.pin ?? '#c0392b' };
}
function drawBoard(ctx, notes, snow) {
  // posts
  for (const x of [136, 266]) { px(ctx, '#6b4a2c', x, 306, 8, 164); px(ctx, '#8a6540', x, 306, 2, 164); px(ctx, '#4a3320', x + 6, 306, 2, 164); }
  // roof
  px(ctx, '#5a4028', 122, 292, 166, 8); px(ctx, '#8c6a45', 122, 292, 166, 1); px(ctx, '#3a2818', 122, 299, 166, 1);
  for (let x = 124; x < 288; x += 6) px(ctx, '#4a3320', x, 295, 1, 4);
  // frame + cork
  px(ctx, '#5a3d22', 128, 300, 154, 112); px(ctx, '#7a5a3a', 128, 300, 154, 1);
  px(ctx, '#b48a5e', 132, 304, 146, 104);
  ctx.fillStyle = ditherPattern(ctx, '#9c7448', 5); ctx.fillRect(132, 304, 146, 104);
  ctx.fillStyle = ditherPattern(ctx, '#c9a070', 2); ctx.fillRect(133, 305, 144, 102);
  px(ctx, '#7a5a3a', 132, 304, 146, 1); px(ctx, '#7a5a3a', 132, 304, 1, 104);
  // shelf rail
  px(ctx, '#4a3320', 126, 412, 158, 4); px(ctx, '#6b4a2c', 126, 412, 158, 1);
  for (const n of notes) drawNote(ctx, n);
  if (snow) { snowCap(ctx, 122, 292, 166, 4); snowCap(ctx, 126, 412, 158, 2); }
}
function drawNote(ctx, n) {
  const fade = clamp(n.age, 0, 1);
  const paper = lerpRGB(hex(PAPER[n.paper % PAPER.length]), [180, 138, 94], fade * 0.75);
  const ink = lerpRGB([80, 82, 96], [150, 130, 105], fade);
  const x = n.x, y = n.y, w = n.w, h = n.h;
  px(ctx, '#7a5636', x + 1, y + 1, w, h);            // shadow on the cork
  px(ctx, rgb(paper), x, y, w, h);
  px(ctx, rgb(lerpRGB(paper, [0, 0, 0], 0.18)), x + w - 1, y, 1, h);
  px(ctx, rgb(lerpRGB(paper, [0, 0, 0], 0.18)), x, y + h - 1, w, 1);
  // scribbled lines of "text"
  ctx.fillStyle = ditherPattern(ctx, rgb(ink), fade > 0.6 ? 6 : 12);
  for (let ly = y + 5; ly < y + h - 3; ly += 3) ctx.fillRect(x + 3, ly, w - 6 - (hash2(ly, x, 5) * 8 | 0), 1);
  // weathering: curled and torn corners
  if (fade > 0.35) { px(ctx, '#b48a5e', x, y + h - 1, 3, 1); px(ctx, '#b48a5e', x, y + h - 2, 2, 1); px(ctx, '#b48a5e', x, y + h - 3, 1, 1); px(ctx, rgb(lerpRGB(paper, [0, 0, 0], 0.3)), x + 1, y + h - 3, 2, 1); }
  if (fade > 0.7) { px(ctx, '#b48a5e', x + w - 3, y, 3, 1); px(ctx, '#b48a5e', x + w - 2, y + 1, 2, 1); px(ctx, '#b48a5e', x + w - 1, y + 2, 1, 1); }
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

// Warm pool of light under the pay phone hood after dark.
export function drawLampGlow(ctx, env) {
  const nf = clamp((-env.sun.altitude + 1) / 8, 0, 1) * (env.cond.fog ? 1.4 : 1);
  if (nf < 0.05) return;
  ctx.globalCompositeOperation = 'lighter';
  const c = (a) => `rgb(${(56 * a) | 0},${(42 * a) | 0},${(18 * a) | 0})`;
  ctx.fillStyle = ditherPattern(ctx, c(nf), 4); fillCircle(ctx, LAMP.x, LAMP.y + 8, 46);
  ctx.fillStyle = ditherPattern(ctx, c(nf), 8); fillCircle(ctx, LAMP.x, LAMP.y + 6, 30);
  ctx.fillStyle = ditherPattern(ctx, c(nf), 12); fillCircle(ctx, LAMP.x, LAMP.y + 3, 16);
  ctx.fillStyle = `rgb(${(120 * nf) | 0},${(100 * nf) | 0},${(50 * nf) | 0})`; ctx.fillRect(739, 296, 12, 2);
  ctx.globalCompositeOperation = 'source-over';
}
