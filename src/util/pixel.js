// Pixel-art helpers: ordered dithering, crisp primitives, color math.
export const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
export const bayer = (x, y) => (BAYER4[y & 3][x & 3] + 0.5) / 16;
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smooth = (t) => t * t * (3 - 2 * t);
export const lerpRGB = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const mulRGB = (c, m) => [c[0] * m[0], c[1] * m[1], c[2] * m[2]];
export const scaleRGB = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
export const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
export function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
// Ordered-dither quantization of one channel to a given step size.
export const quant = (v, step, d) => clamp(Math.floor(v / step + d) * step, 0, 255);
export function quantRGB(c, step, d) { return [quant(c[0], step, d), quant(c[1], step, d), quant(c[2], step, d)]; }

export function fillCircle(ctx, cx, cy, r) {
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.floor(Math.sqrt(r * r - dy * dy));
    ctx.fillRect(cx - w, cy + dy, 2 * w + 1, 1);
  }
}
// Plot a 1px line without anti-aliasing.
export function plotLine(ctx, x0, y0, x1, y1) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
// Sagging wire between two points (quadratic), plotted pixel by pixel.
export function plotWire(ctx, x0, y0, x1, y1, sag) {
  const steps = Math.abs(x1 - x0);
  let px = x0, py = y0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(lerp(x0, x1, t));
    const y = Math.round(lerp(y0, y1, t) + sag * 4 * t * (1 - t));
    plotLine(ctx, px, py, x, y);
    px = x; py = y;
  }
}

const patCache = new Map();
// A repeating 4x4 Bayer pattern with `level`/16 of pixels filled in `color`.
export function ditherPattern(ctx, color, level) {
  level = clamp(Math.round(level), 0, 16);
  const key = color + '|' + level;
  let p = patCache.get(key);
  if (!p) {
    const c = document.createElement('canvas'); c.width = 4; c.height = 4;
    const g = c.getContext('2d'); g.fillStyle = color;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (BAYER4[y][x] < level) g.fillRect(x, y, 1, 1);
    p = ctx.createPattern(c, 'repeat'); patCache.set(key, p);
  }
  return p;
}
export function makeCanvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  return [c, g];
}
