import { W, H, HORIZON, SCALE, META } from '../state.js';
import { ditherPattern, fillCircle, clamp, rgb, lerpRGB, hex, makeCanvas } from '../util/pixel.js';
import { hash2 } from '../util/noise.js';
import { posterImage } from '../notes.js';

// The bench, bulletin board, pay phone and pole are part of the painting (art/concept_art_03.png,
// masked as material PROP by tools/build_backdrop.py). This module only knows where they are, and
// draws what changes on top of them: the notes pinned to the cork, snow caps, shadows, lamp glow.
// Where the painted props are, from the painting's config (see tools/build_backdrop.py).
export const PROPS = META.props;
export const HOTSPOTS = Object.entries(PROPS).filter(([, p]) => p.hot).map(([id, p]) => ({ id, ...p }));
export const CORK = META.cork;
export const LAMP = META.lamp;
// Close-up paintings for the zoomed views (assets/ID_closeup.png, from the config's "closeups"):
// the same prop painted large, black keyed out, with its own cork rectangle for the notes.
export const CLOSEUPS = META.closeups || {};

function px(ctx, c, x, y, w = 1, h = 1) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }
const SNOW = '#eef2fb', SNOW_SHADE = '#c4cfe6';
function snowCap(ctx, x, y, w, h = 2) { px(ctx, SNOW, x, y - h, w, h); px(ctx, SNOW_SHADE, x, y - 1, w, 1); }

export function drawProps(ctx, state, sunSide, snow) {
  ctx.clearRect(0, 0, W, H);
  for (const n of state.notes) drawNote(ctx, n);
  if (snow) for (const [x, y, w, h] of META.snowCaps) snowCap(ctx, x, y, w, Math.max(2, Math.round(h * SCALE)));
}

const PAPER = ['#e8dcc0', '#f2d27a', '#cfd6df', '#f0c9c9', '#c8d8b0', '#f4f1ea'];
export function makeNote(text, opts = {}) {
  return { text, x: opts.x ?? CORK.x + 8, y: opts.y ?? CORK.y + 8, w: opts.w ?? 30, h: opts.h ?? 38, paper: opts.paper ?? 0, age: opts.age ?? 0, pin: opts.pin ?? '#c0392b' };
}
// A note is a scrap of paper at unit `u` (1 on the scene; the close-up's scale, where the text is
// set for real). Aging yellows and curls it.
function drawNote(ctx, n, u = 1, legible = false) {
  if (n.poster) return drawPosterNote(ctx, n, u, legible);
  const fade = clamp(n.age, 0, 1);
  const paper = lerpRGB(hex(PAPER[n.paper % PAPER.length]), [180, 138, 94], fade * 0.75);
  const ink = lerpRGB([80, 82, 96], [150, 130, 105], fade);
  const x = n.x, y = n.y, w = n.w, h = n.h, s = Math.max(1, Math.round(u));
  const edge = rgb(lerpRGB(paper, [0, 0, 0], 0.18));
  px(ctx, '#5a4030', x + s, y + s, w, h);            // shadow on the cork
  px(ctx, rgb(paper), x, y, w, h);
  px(ctx, edge, x + w - s, y, s, h);
  px(ctx, edge, x, y + h - s, w, s);
  if (legible) {
    drawNoteText(ctx, n.text, x + 4 * s, y + 4 * s, w - 8 * s, h - 8 * s, rgb(ink), u);
  } else {
    // a heading and scribbled lines of "text"
    ctx.fillStyle = rgb(ink); ctx.fillRect(x + 4, y + 5, Math.max(4, (w >> 1) - (hash2(x, y, 6) * 6 | 0)), 2);
    ctx.fillStyle = ditherPattern(ctx, rgb(ink), fade > 0.6 ? 6 : 12);
    for (let ly = y + 10; ly < y + h - 4; ly += 3) ctx.fillRect(x + 4, ly, w - 8 - (hash2(ly, x, 5) * 10 | 0), 1);
  }
  // weathering: curled and torn corners, cork showing through
  const c = 3 * s, curl = rgb(lerpRGB(paper, [0, 0, 0], 0.3));
  if (fade > 0.35) { for (let i = 0; i < c; i++) px(ctx, '#8b6a4a', x, y + h - 1 - i, c - i, 1); px(ctx, curl, x + s, y + h - c, 2 * s, s); }
  if (fade > 0.7) { for (let i = 0; i < c; i++) px(ctx, '#8b6a4a', x + w - (c - i), y + i, c - i, 1); }
  // pin
  px(ctx, n.pin, x + (w >> 1) - s, y + s, 3 * s, 3 * s); px(ctx, '#ffd0c0', x + (w >> 1) - s, y + s, s, s);
}

// A poster: the picture with a thin white border, the paper cut to it, centered in its slot.
// On the scene the picture is averaged down to fit (a hard shrink drops rows of its pixels); up
// close it is laid at a whole-number scale so its pixels stay square. The border yellows with age.
// A size in screen pixels, as canvas pixels: the canvas is shown scaled by --s (shrunk on most
// screens), and a border sized in canvas pixels came out a hair wide on one machine and gone on
// the next.
function screenPx(px) {
  let css = 1;
  if (typeof document !== 'undefined') css = Number(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 1;
  return Math.max(1, Math.round(px / css));
}
function drawPosterNote(ctx, n, u = 1, legible = false) {
  const im = posterImage(n.poster);
  const s = Math.max(1, Math.round(u)), b = n.border ?? screenPx(legible ? 2 : 1.5);
  const pw = n.poster.w || (im && im.width) || 160, ph = n.poster.h || (im && im.height) || 212;
  let dw, dh;
  if (legible) { const k = n.k || Math.max(1, Math.floor(Math.min((n.w - 2 * b) / pw, (n.h - 2 * b) / ph))); dw = Math.round(pw * k); dh = Math.round(ph * k); }   // its own size (a half on the half-size build), or what the box allows
  else { const k = Math.min((n.w - 2 * b) / pw, (n.h - 2 * b) / ph); dw = Math.max(1, Math.round(pw * k)); dh = Math.max(1, Math.round(ph * k)); }
  const w = dw + 2 * b, h = dh + 2 * b, x = n.x + ((n.w - w) >> 1), y = n.y + ((n.h - h) >> 1);
  const paper = lerpRGB([248, 246, 240], [180, 138, 94], clamp(n.age, 0, 1) * 0.75);
  px(ctx, '#5a4030', x + s, y + s, w, h);            // shadow on the cork
  px(ctx, rgb(paper), x, y, w, h);
  if (im) { ctx.imageSmoothingEnabled = !legible; ctx.drawImage(im, x + b, y + b, dw, dh); ctx.imageSmoothingEnabled = false; }
  px(ctx, n.pin, x + (w >> 1) - s, y + s, 3 * s, 3 * s); px(ctx, '#ffd0c0', x + (w >> 1) - s, y + s, s, s);
}

// One poster held up to look at: the frame dimmed by a dither, the picture centered at a
// whole-number scale that fills most of the height, its thin border and its pin.
export function drawPosterView(ctx, n) {
  ctx.fillStyle = ditherPattern(ctx, '#000', 8);
  ctx.fillRect(0, 0, W, H);
  const im = posterImage(n.poster);
  const pw = n.poster.w || (im && im.width) || 160, ph = n.poster.h || (im && im.height) || 212;
  const s = Math.max(1, Math.round(SCALE)), b = screenPx(3), k = Math.max(1, Math.floor((H * 0.8 - 2 * b) / ph));
  const w = pw * k + 2 * b, h = ph * k + 2 * b;
  drawPosterNote(ctx, { ...n, x: (W - w) >> 1, y: (H - h) >> 1, w, h, border: b, k }, s, true);
}

// Text in the page's font, wrapped to the paper and snapped to hard pixels: the glyphs are set on
// a scratch canvas and their coverage thresholded, so nothing anti-aliases on the cork.
const NOTE_FONT = 'VT323';
let fontAsked = false;
export function noteFontReady() {
  if (typeof document === 'undefined' || !document.fonts) return true;
  if (!fontAsked) { fontAsked = true; document.fonts.load(`24px "${NOTE_FONT}"`).catch(() => {}); }
  return document.fonts.check(`24px "${NOTE_FONT}"`);
}
function drawNoteText(ctx, text, x, y, w, h, color, u) {
  const size = Math.round(clamp(w / 6.5, 6 * u, 14 * u)), lineH = Math.round(size * 0.92);
  if (size < 6 || w < 8 || h < lineH) return;
  const [c, g] = makeCanvas(w, h);
  g.font = `${size}px "${NOTE_FONT}", "Courier New", monospace`;
  g.textBaseline = 'top'; g.fillStyle = color;
  const fits = (t) => g.measureText(t).width <= w;
  const lines = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    if (!word) continue;
    if (fits(line ? line + ' ' + word : word)) { line = line ? line + ' ' + word : word; continue; }
    if (line) lines.push(line);
    line = word;
    while (!fits(line) && line.length > 1) {   // a word wider than the paper breaks where it must
      let k = line.length - 1;
      while (k > 1 && !fits(line.slice(0, k))) k--;
      lines.push(line.slice(0, k)); line = line.slice(k);
    }
  }
  if (line) lines.push(line);
  const max = Math.floor(h / lineH);
  lines.slice(0, max).forEach((t, i) => g.fillText(t, 0, i * lineH));
  const img = g.getImageData(0, 0, w, h), d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] > 110 ? 255 : 0;
  g.putImageData(img, 0, 0);
  ctx.drawImage(c, x, y);
}

// The notes on a close-up's cork: the scene's slots stretched onto the bigger cork, the paper
// scaled uniformly, the text legible.
export function closeupNotes(state, cu) {
  const kx = cu.cork.w / CORK.w, ky = cu.cork.h / CORK.h, u = Math.min(kx, ky);
  return state.notes.map((n) => ({ ...n, x: Math.round(cu.cork.x + (n.x - CORK.x) * kx), y: Math.round(cu.cork.y + (n.y - CORK.y) * ky), w: Math.round(n.w * u), h: Math.round(n.h * u), u, note: n }));
}
export function drawCloseupNotes(ctx, state, cu) {
  for (const big of closeupNotes(state, cu)) drawNote(ctx, big, big.u, true);
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
// Both are dithered additive sprites, rebuilt only when the night factor changes.
// Switched off for now (2026-09-28): the glow did not look right; revisit when the lamp gets a proper pass.
export const LAMP_GLOW = false;
let glowKey = '', halo = null, pool = null;
export function drawLampGlow(ctx, env) {
  if (!LAMP_GLOW) return;
  const nf = Math.round(clamp((-env.sun.altitude + 1) / 8, 0, 1) * (env.cond.fog ? 1.4 : 1) * 50) / 50;
  if (nf < 0.05) return;
  const r = (v) => Math.round(v * SCALE), gy = META.lampPoolY;
  if (glowKey !== String(nf)) {
    glowKey = String(nf);
    const c = (a) => `rgb(${(56 * a) | 0},${(42 * a) | 0},${(18 * a) | 0})`;
    const hr = r(34) + 2, pw = r(130) + 2, ph = r(28) + 2;
    let g;
    [halo, g] = makeCanvas(hr * 2 + 1, hr * 2 + 1);
    g.fillStyle = ditherPattern(g, c(nf), 3); fillCircle(g, hr, hr, r(34));
    g.fillStyle = ditherPattern(g, c(nf), 6); fillCircle(g, hr, hr, r(22));
    g.fillStyle = ditherPattern(g, c(nf), 10); fillCircle(g, hr, hr, r(12));
    g.fillStyle = `rgb(${(150 * nf) | 0},${(120 * nf) | 0},${(60 * nf) | 0})`; fillCircle(g, hr, hr, r(6));
    [pool, g] = makeCanvas(pw * 2 + 1, ph * 2 + 1);
    g.fillStyle = ditherPattern(g, c(nf * 0.8), 3); fillEllipse(g, pw, ph, r(130), r(28));
    g.fillStyle = ditherPattern(g, c(nf * 0.8), 6); fillEllipse(g, pw, ph, r(84), r(18));
    g.fillStyle = ditherPattern(g, c(nf * 0.8), 9); fillEllipse(g, pw, ph, r(42), r(10));
  }
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(halo, LAMP.x - (halo.width >> 1), LAMP.y - (halo.height >> 1));
  ctx.drawImage(pool, LAMP.x - (pool.width >> 1), gy - (pool.height >> 1));
  ctx.globalCompositeOperation = 'source-over';
}
