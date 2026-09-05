import { W, H, HORIZON } from '../state.js';
import { plotLine, plotWire, ditherPattern, fillCircle, clamp, rgb, lerpRGB, hex } from '../util/pixel.js';
import { hash2 } from '../util/noise.js';

// Screen-space rectangles for the things you can look at, plus what casts shadows. Positions follow
// art/ref_props_960.png (the concept art at scene scale): sign, bench and board on the left, the
// path through the middle, the pay phone booth under the pole on the right.
// All three sit on one ground line (y = 456): board left, bench center, booth right.
export const GROUND = 456;
export const BOARD_DX = -175; // the board is drawn with the concept art's coordinates, shifted left
export const PROPS = {
  board: { x: 322 + BOARD_DX, y: 228, w: 134, h: 230, label: 'bulletin board', baseY: GROUND, footprint: [326 + BOARD_DX, 452 + BOARD_DX], height: 200, hot: true },
  bench: { x: 396, y: 364, w: 166, h: 94, label: 'park bench', baseY: GROUND, footprint: [402, 556], height: 60, hot: true },
  phone: { x: 694, y: 222, w: 98, h: 236, label: 'pay phone', baseY: GROUND, footprint: [700, 770], height: 150, hot: true },
  pole:  { x: 782, y: 0, w: 34, h: 468, baseY: 468, footprint: [784, 816], height: 250, hot: false },
};
export const HOTSPOTS = Object.entries(PROPS).filter(([, p]) => p.hot).map(([id, p]) => ({ id, ...p }));
export const LAMP = { x: 730, y: 143 };

function px(ctx, c, x, y, w = 1, h = 1) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }
// A board seen in slight perspective: a rectangle whose rows step down by `slope` px per px of x.
function slab(ctx, c, x, y, w, h, slope) {
  ctx.fillStyle = c;
  for (let i = 0; i < w; i++) ctx.fillRect(x + i, Math.round(y + slope * i), 1, h);
}

export function drawProps(ctx, state, sunSide, snow) {
  ctx.clearRect(0, 0, W, H);
  drawPole(ctx, snow);
  drawLamp(ctx, snow);
  drawBooth(ctx, snow);
  drawBoard(ctx, state.notes, snow);
  drawBench(ctx, snow);
  drawSquirrel(ctx);
}
const SNOW = '#eef2fb', SNOW_SHADE = '#c4cfe6';
function snowCap(ctx, x, y, w, h = 2) { px(ctx, SNOW, x, y - h, w, h); px(ctx, SNOW_SHADE, x, y - 1, w, 1); }

// 3x5 pixel font for the painted signs.
const FONT = {
  A: ['010', '101', '111', '101', '101'], D: ['110', '101', '101', '101', '110'], E: ['111', '100', '110', '100', '111'],
  H: ['101', '101', '111', '101', '101'], I: ['111', '010', '010', '010', '111'], K: ['101', '101', '110', '101', '101'],
  L: ['100', '100', '100', '100', '111'], N: ['101', '111', '101', '101', '101'], O: ['111', '101', '101', '101', '111'],
  P: ['111', '101', '111', '100', '100'], R: ['111', '101', '111', '110', '101'], T: ['111', '010', '010', '010', '010'],
  Y: ['101', '101', '010', '010', '010'], ' ': ['000', '000', '000', '000', '000'],
};
function drawText(ctx, text, x, y, scale, color, slope = 0) {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (g[r][c] === '1') ctx.fillRect(cx + c * scale, Math.round(y + slope * (cx - x)) + r * scale, scale, scale);
    }
    cx += 4 * scale;
  }
}

// --- pole and lamp -------------------------------------------------------------------------
function drawPole(ctx, snow) {
  const x = 782, w = 34, top = 0, bottom = 468;
  px(ctx, '#5a4a3e', x, top, w, bottom - top);
  px(ctx, '#7a6a5c', x, top, 6, bottom - top);
  px(ctx, '#6a5a4c', x + 6, top, 4, bottom - top);
  px(ctx, '#4a3a30', x + 22, top, 4, bottom - top);
  px(ctx, '#3e3028', x + 26, top, 8, bottom - top);
  for (let y = top; y < bottom; y++) {
    if (hash2(0, y, 12) > 0.75) px(ctx, '#4e3e32', x + 8 + Math.floor(hash2(1, y, 13) * 14), y, 2 + Math.floor(hash2(2, y, 14) * 3), 1);
    if (hash2(3, y, 15) > 0.9) px(ctx, '#6e5e50', x + 10 + Math.floor(hash2(4, y, 16) * 10), y, 1, 1);
  }
  px(ctx, '#3a2c22', x, bottom - 6, w, 6); // weathered foot
  if (snow) px(ctx, SNOW_SHADE, x, bottom - 8, 6, 2);
}
function drawLamp(ctx, snow) {
  // bracket from the pole, diagonal strut above it
  px(ctx, '#686058', 722, 88, 60, 8); px(ctx, '#8a8078', 722, 88, 60, 1); px(ctx, '#4a443e', 722, 95, 60, 1);
  ctx.fillStyle = '#686058';
  for (let t = 0; t < 3; t++) plotLine(ctx, 782, 40 + t, 726, 88 + t);
  px(ctx, '#8a8078', 780, 38, 4, 3);
  // cap and neck
  px(ctx, '#6a6058', 724, 96, 12, 18); px(ctx, '#8a8078', 724, 96, 3, 18); px(ctx, '#4a443e', 733, 96, 3, 18);
  px(ctx, '#7a7068', 720, 108, 20, 3);
  // hood: a shallow cone, dark on top, warm underneath
  for (let y = 114; y <= 130; y++) {
    const hw = Math.round(7 + (y - 114) * (23 / 16));
    px(ctx, y < 126 ? '#7a5a3a' : '#c99a5a', 730 - hw, y, hw * 2 + 1, 1);
    px(ctx, '#9d7145', 730 - hw, y, 2, 1); px(ctx, '#4e3820', 730 + hw - 1, y, 2, 1);
  }
  px(ctx, '#f1bd75', 700, 131, 61, 2); px(ctx, '#9d7145', 700, 133, 61, 1);
  // bulb
  ctx.fillStyle = '#f5d8a4'; fillCircle(ctx, 730, 142, 7);
  ctx.fillStyle = '#fff4d8'; fillCircle(ctx, 730, 141, 4);
  px(ctx, '#e0b878', 727, 134, 7, 2);
  if (snow) { snowCap(ctx, 704, 118, 52, 3); snowCap(ctx, 722, 88, 60, 3); }
}

// --- pay phone booth ------------------------------------------------------------------------
function drawBooth(ctx, snow) {
  const L = 695, R = 772, T = 223, B = 378;
  const FRAME = '#85868c', FRAME_D = '#3d3f42', FRAME_L = '#b4b6bc';
  // side panel (in front of the pole) first
  px(ctx, '#6b6d72', 772, T, 19, B - T); px(ctx, FRAME_D, 788, T, 3, B - T);
  ctx.clearRect(776, 246, 10, 125);
  ctx.fillStyle = ditherPattern(ctx, '#9db6d0', 3); ctx.fillRect(776, 246, 10, 125);
  px(ctx, '#557aa9', 775, 227, 12, 16); px(ctx, FRAME_D, 772, 243, 19, 3); px(ctx, FRAME_D, 772, 371, 19, 7);
  handsetIcon(ctx, 778, 288, 5, 30);
  // front frame
  px(ctx, FRAME, L, T, R - L, B - T);
  px(ctx, FRAME_L, L, T, R - L, 2); px(ctx, FRAME_L, L, T, 2, B - T); px(ctx, FRAME_D, R - 3, T, 3, B - T);
  px(ctx, FRAME_D, L, B - 7, R - L, 7); px(ctx, FRAME_L, L, B - 7, R - L, 1);
  // sign band
  px(ctx, FRAME_D, 697, 225, 72, 21);
  px(ctx, '#557aa9', 698, 227, 70, 17); px(ctx, '#7a9ccb', 698, 227, 70, 1); px(ctx, '#3f5f8c', 698, 243, 70, 1);
  drawText(ctx, 'PAY PHONE', 704, 231, 2, '#e8eef5');
  // glass: transparent so the painting shows through, with a faint dithered tint and glare
  ctx.clearRect(699, 248, 69, 121);
  ctx.fillStyle = ditherPattern(ctx, '#c4d6ea', 2); ctx.fillRect(699, 248, 69, 121);
  px(ctx, FRAME_D, 729, 248, 4, 121); px(ctx, FRAME, 730, 248, 1, 121); // mullion
  px(ctx, FRAME_D, 699, 248, 69, 1); px(ctx, FRAME_D, 699, 368, 69, 1);
  ctx.fillStyle = '#dfe9f5';
  plotLine(ctx, 701, 268, 713, 252); plotLine(ctx, 703, 276, 717, 258);
  plotLine(ctx, 736, 262, 748, 250); plotLine(ctx, 738, 272, 752, 256);
  handsetIcon(ctx, 706, 284, 8, 42);
  // the phone on the back wall, seen through the right pane
  px(ctx, '#2e343c', 735, 277, 29, 67); px(ctx, '#4a515d', 736, 278, 27, 65); px(ctx, '#6a7380', 737, 279, 25, 2);
  px(ctx, '#2f6fbf', 738, 283, 23, 7); px(ctx, '#d05a30', 738, 283, 4, 4); px(ctx, '#dfe6ec', 748, 284, 10, 2);
  px(ctx, '#7d8794', 738, 292, 23, 48);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) { px(ctx, '#dfe6ec', 748 + c * 4, 296 + r * 4, 3, 3); px(ctx, '#9aa5ad', 748 + c * 4, 298 + r * 4, 3, 1); }
  px(ctx, '#1c1e22', 739, 292, 7, 32); px(ctx, '#3a3f46', 739, 292, 1, 32);
  px(ctx, '#1c1e22', 737, 289, 10, 5); px(ctx, '#1c1e22', 737, 322, 10, 5);
  px(ctx, '#1c1e22', 749, 318, 11, 5); px(ctx, '#8b9aa8', 750, 319, 9, 1);
  px(ctx, '#1c2024', 750, 330, 10, 8); px(ctx, '#8b9aa8', 752, 332, 6, 2);
  ctx.fillStyle = '#c8ccd2'; plotWire(ctx, 742, 326, 752, 340, 14);
  // pedestal and base
  px(ctx, '#58503d', 745, B, 26, GROUND - B); px(ctx, '#7a7050', 745, B, 4, GROUND - B); px(ctx, '#3a3428', 763, B, 8, GROUND - B);
  px(ctx, '#645636', 741, GROUND - 5, 34, 6); px(ctx, '#3a3428', 741, GROUND, 34, 1);
  if (snow) { snowCap(ctx, L, T, R - L + 19, 3); }
}
function handsetIcon(ctx, x, y, w, h) {
  const b = '#3f7fd0', o = '#9ec3ea';
  px(ctx, o, x - 1, y - 1, w + 2, h + 2); px(ctx, b, x, y, w, h);
  px(ctx, o, x - 3, y - 3, w + 4, 6); px(ctx, b, x - 2, y - 2, w + 2, 4);
  px(ctx, o, x - 3, y + h - 3, w + 4, 6); px(ctx, b, x - 2, y + h - 2, w + 2, 4);
}

// --- bulletin board ------------------------------------------------------------------------
function drawBoard(ctx, notes, snow) {
  ctx.save(); ctx.translate(BOARD_DX, 0);
  // posts (frame sides run to the ground)
  const ph = GROUND - 244;
  for (const x of [325, 438]) { px(ctx, '#6e5236', x, 244, 15, ph); px(ctx, '#886741', x, 244, 3, ph); px(ctx, '#4a3320', x + 11, 244, 4, ph); }
  // roof
  px(ctx, '#452e26', 322, 230, 132, 14); px(ctx, '#675441', 322, 230, 132, 2); px(ctx, '#2e1e18', 322, 242, 132, 2);
  for (let x = 324; x < 454; x += 5) px(ctx, '#3a2620', x, 233, 1, 8);
  px(ctx, '#2e1e18', 322, 244, 132, 3); // eave shadow
  // top rail, cork, bottom rail
  px(ctx, '#5a3d22', 325, 247, 128, 5); px(ctx, '#7a5a3a', 325, 247, 128, 1);
  px(ctx, '#806048', 340, 252, 98, 92);
  ctx.fillStyle = ditherPattern(ctx, '#6e5040', 5); ctx.fillRect(340, 252, 98, 92);
  ctx.fillStyle = ditherPattern(ctx, '#927058', 3); ctx.fillRect(341, 253, 96, 90);
  px(ctx, '#4a3320', 340, 252, 98, 1); px(ctx, '#4a3320', 340, 252, 1, 92);
  px(ctx, '#5a3d22', 325, 344, 128, 10); px(ctx, '#7a5a3a', 325, 344, 128, 1); px(ctx, '#3a2818', 325, 353, 128, 1);
  if (snow) { snowCap(ctx, 322, 230, 132, 4); snowCap(ctx, 340, 344, 98, 2); }
  ctx.restore();
  for (const n of notes) drawNote(ctx, n);
}

const PAPER = ['#efe6c8', '#f2d27a', '#cfe2f0', '#f0c9c9', '#c8d8b0', '#f7f2e8'];
export function makeNote(text, opts = {}) {
  return { text, x: opts.x ?? 177, y: opts.y ?? 258, w: opts.w ?? 24, h: opts.h ?? 30, paper: opts.paper ?? 0, age: opts.age ?? 0, pin: opts.pin ?? '#c0392b' };
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
  // scribbled lines of "text"
  ctx.fillStyle = ditherPattern(ctx, rgb(ink), fade > 0.6 ? 6 : 12);
  for (let ly = y + 5; ly < y + h - 3; ly += 3) ctx.fillRect(x + 3, ly, w - 6 - (hash2(ly, x, 5) * 8 | 0), 1);
  // weathering: curled and torn corners
  if (fade > 0.35) { px(ctx, '#806048', x, y + h - 1, 3, 1); px(ctx, '#806048', x, y + h - 2, 2, 1); px(ctx, '#806048', x, y + h - 3, 1, 1); px(ctx, rgb(lerpRGB(paper, [0, 0, 0], 0.3)), x + 1, y + h - 3, 2, 1); }
  if (fade > 0.7) { px(ctx, '#806048', x + w - 3, y, 3, 1); px(ctx, '#806048', x + w - 2, y + 1, 2, 1); px(ctx, '#806048', x + w - 1, y + 2, 1, 1); }
  // pin
  px(ctx, n.pin, x + (w >> 1) - 1, y + 1, 3, 3); px(ctx, '#ffd0c0', x + (w >> 1) - 1, y + 1, 1, 1);
}

// --- bench ---------------------------------------------------------------------------------
function drawBench(ctx, snow) {
  const x = 400, w = 158;
  const slat = (y, h) => {
    px(ctx, '#7c5f47', x, y, w, h); px(ctx, '#a08060', x, y, w, 2); px(ctx, '#5a4433', x, y + h - 1, w, 1);
    for (const sx of [6, w - 8]) px(ctx, '#8fb4c8', x + sx, y + 3, 2, 1);
  };
  // uprights behind the slats
  for (const ux of [402, 550]) { px(ctx, '#5a4a30', ux, 366, 7, GROUND - 366); px(ctx, '#3e3222', ux + 5, 366, 2, GROUND - 366); }
  // back slats
  slat(368, 8); slat(379, 8); slat(390, 8);
  // seat: two boards on a dark underside
  px(ctx, '#4a3828', x - 2, 414, w + 4, 16);
  slat(415, 6); slat(422, 6);
  px(ctx, '#5a4433', x - 2, 428, w + 4, 3);
  // front legs and stretcher
  for (const lx of [408, 544]) { px(ctx, '#5a4a30', lx, 431, 6, GROUND - 431); px(ctx, '#3e3222', lx + 4, 431, 2, GROUND - 431); }
  px(ctx, '#4a3c28', 412, 446, 134, 3);
  if (snow) { snowCap(ctx, x, 368, w, 3); snowCap(ctx, x, 415, w, 3); }
}

// --- a squirrel on the boulder at the right --------------------------------------------------
function drawSquirrel(ctx) {
  const B = '#704020', D = '#4e2c14', L = '#a08060';
  ctx.fillStyle = B; fillCircle(ctx, 846, 442, 9);          // body
  px(ctx, L, 842, 440, 6, 8);                                 // belly
  ctx.fillStyle = B; fillCircle(ctx, 838, 431, 5);            // head
  px(ctx, B, 834, 425, 2, 3); px(ctx, B, 840, 425, 2, 3);     // ears
  px(ctx, '#1a0c04', 836, 430, 1, 1);                         // eye
  ctx.fillStyle = D; fillCircle(ctx, 858, 432, 6); fillCircle(ctx, 860, 424, 5); fillCircle(ctx, 857, 440, 5); // tail
  ctx.fillStyle = B; fillCircle(ctx, 859, 431, 4); fillCircle(ctx, 861, 424, 3);
  px(ctx, D, 840, 449, 4, 2); px(ctx, D, 850, 450, 4, 2);     // feet
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
// After dark the lamp lights up: a halo around the bulb and a warm pool on the ground below.
export function drawLampGlow(ctx, env) {
  const nf = clamp((-env.sun.altitude + 1) / 8, 0, 1) * (env.cond.fog ? 1.4 : 1);
  if (nf < 0.05) return;
  ctx.globalCompositeOperation = 'lighter';
  const c = (a) => `rgb(${(56 * a) | 0},${(42 * a) | 0},${(18 * a) | 0})`;
  ctx.fillStyle = ditherPattern(ctx, c(nf), 3); fillCircle(ctx, LAMP.x, LAMP.y, 26);
  ctx.fillStyle = ditherPattern(ctx, c(nf), 6); fillCircle(ctx, LAMP.x, LAMP.y, 16);
  ctx.fillStyle = ditherPattern(ctx, c(nf), 10); fillCircle(ctx, LAMP.x, LAMP.y, 9);
  ctx.fillStyle = ditherPattern(ctx, c(nf * 0.8), 3); fillEllipse(ctx, LAMP.x + 8, 458, 96, 24);
  ctx.fillStyle = ditherPattern(ctx, c(nf * 0.8), 6); fillEllipse(ctx, LAMP.x + 8, 458, 62, 15);
  ctx.fillStyle = ditherPattern(ctx, c(nf * 0.8), 9); fillEllipse(ctx, LAMP.x + 8, 458, 32, 8);
  ctx.fillStyle = `rgb(${(150 * nf) | 0},${(120 * nf) | 0},${(60 * nf) | 0})`; fillCircle(ctx, LAMP.x, LAMP.y - 1, 5);
  ctx.globalCompositeOperation = 'source-over';
}
