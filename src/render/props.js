import { W, H, HORIZON, SCALE, META } from '../state.js';
import { ditherPattern, fillCircle, clamp, rgb, lerpRGB, hex, makeCanvas } from '../util/pixel.js';
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
// set for real). Aging yellows and curls it, over a year, and the ink stays readable at the end.
function drawNote(ctx, n, u = 1, legible = false) {
  if (n.poster) return drawPosterNote(ctx, n, u, legible);
  const fade = clamp(n.age, 0, 1);
  const paper = lerpRGB(hex(PAPER[n.paper % PAPER.length]), [180, 138, 94], fade * 0.75);
  const hand = handFor(n.text), ink = lerpRGB(hand.ink, [128, 106, 82], fade);
  const x = n.x, y = n.y, w = n.w, h = n.h, s = Math.max(1, Math.round(u));
  const edge = rgb(lerpRGB(paper, [0, 0, 0], 0.18));
  px(ctx, '#5a4030', x + s, y + s, w, h);            // shadow on the cork
  px(ctx, rgb(paper), x, y, w, h);
  px(ctx, edge, x + w - s, y, s, h);
  px(ctx, edge, x, y + h - s, w, s);
  if (legible) drawNoteText(ctx, n.text, x + 4 * s, y + 4 * s, w - 8 * s, h - 8 * s, rgb(ink), u, hand);
  else drawNoteText(ctx, n.text, x + 3, y + 5, w - 6, h - 8, rgb(ink), 1, hand, true);   // the same words, tiny
  // weathering: curled and torn corners, cork showing through
  const c = 3 * s, curl = rgb(lerpRGB(paper, [0, 0, 0], 0.3));
  if (fade > 0.35) { for (let i = 0; i < c; i++) px(ctx, '#8b6a4a', x, y + h - 1 - i, c - i, 1); px(ctx, curl, x + s, y + h - c, 2 * s, s); }
  if (fade > 0.7) { for (let i = 0; i < c; i++) px(ctx, '#8b6a4a', x + w - (c - i), y + i, c - i, 1); }
  // pin
  px(ctx, n.pin, x + (w >> 1) - s, y + s, 3 * s, 3 * s); px(ctx, '#ffd0c0', x + (w >> 1) - s, y + s, s, s);
}

// A poster: the picture with a thin white border, the paper cut to it, centered in its slot.
// On the scene the picture is averaged down to fit (a hard shrink drops rows of its pixels); up
// close it is laid at a whole-number scale so its pixels stay square. The border yellows with age
// and the picture bleaches the way a poster does in the sun, its warm inks going first so it
// cools and pales, over the same year as a note, and stays recognizable at the end.
const BLEACH_STEPS = 8, BLEACH = 0.6, bleached = new Map();   // `id|step` -> the bleached picture
function posterPicture(p, age) {
  const im = posterImage(p);
  const step = Math.round(clamp(age, 0, 1) * BLEACH_STEPS);
  if (!im || !step) return im;
  const key = p.id + '|' + step;
  let c = bleached.get(key);
  if (!c) {
    const [cv, g] = makeCanvas(im.width, im.height);
    g.drawImage(im, 0, 0);
    let img;
    try { img = g.getImageData(0, 0, im.width, im.height); } catch (e) { return im; }   // a picture the canvas may not read stays as it is
    const d = img.data, f = step / BLEACH_STEPS * BLEACH;
    for (let i = 0; i < d.length; i += 4) { d[i] += (216 - d[i]) * f; d[i + 1] += (218 - d[i + 1]) * f * 0.9; d[i + 2] += (224 - d[i + 2]) * f * 0.75; }
    g.putImageData(img, 0, 0);
    c = cv; bleached.set(key, c);
  }
  return c;
}
// A size in screen pixels, as canvas pixels: the canvas is shown scaled by --s (shrunk on most
// screens), and a border sized in canvas pixels came out a hair wide on one machine and gone on
// the next.
function screenPx(px) {
  let css = 1;
  if (typeof document !== 'undefined') css = Number(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 1;
  return Math.max(1, Math.round(px / css));
}
function drawPosterNote(ctx, n, u = 1, legible = false) {
  const im = posterPicture(n.poster, n.age);
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

// Text wrapped to the paper and snapped to hard pixels: the glyphs are set on a scratch canvas
// and their coverage thresholded, so nothing anti-aliases on the cork. Every note is in its own
// hand (the user, 2026-10-28: "more handwritten, or a mix of hand writings"), picked from a hash
// of its words so a note is in the same hand everywhere and forever, with the hand's own ink: a
// blue ballpoint, a black felt-tip, a pencil. A fifth of the notes stay typed, since a real
// board has printed sheets too. On the scene the same words are set tiny in the same hand, not
// readable, as from the bench, but a looping cursive tells from a fat marker from a typed sheet,
// and walking up to the board shows the same lines bigger.
const BLUE = [38, 52, 128], BLACK = [40, 40, 46], PENCIL = [92, 92, 100], TYPED = [80, 82, 96];
// `cw`, `cwU`, `asc`, `desc` are each face's measured mean glyph advance (lowercase, capitals)
// and its tallest ascent and descent, as fractions of the font size, for sizing a scrap to its
// words before the face has loaded. `bold` strokes a thin face a little heavier before the
// threshold, `cut` is its own threshold.
const HANDS = [
  { face: 'VT323', ink: TYPED, size: 1, line: 0.92, cw: 0.4, cwU: 0.4, asc: 0.56, desc: 0.16, mono: true },
  { face: 'Patrick Hand', ink: BLUE, size: 1.05, line: 1, cw: 0.353, cwU: 0.447, asc: 0.72, desc: 0.31 },
  { face: 'Kalam', ink: BLACK, size: 1, line: 1.05, cw: 0.422, cwU: 0.571, asc: 0.8, desc: 0.25 },
  { face: 'Caveat', ink: BLUE, size: 1.2, line: 0.95, cw: 0.329, cwU: 0.474, asc: 0.71, desc: 0.25 },
  { face: 'Shadows Into Light', ink: PENCIL, size: 1.1, line: 1.2, cw: 0.374, cwU: 0.502, asc: 0.9, desc: 0.44 },
  { face: 'Homemade Apple', ink: BLUE, size: 0.9, line: 1.4, cw: 0.544, cwU: 0.702, asc: 0.99, desc: 0.85, bold: 0.05, cut: 80 },
  { face: 'Permanent Marker', ink: BLACK, size: 0.95, line: 1, cw: 0.5, cwU: 0.627, asc: 0.75, desc: 0.06 },
  { face: 'Rock Salt', ink: BLACK, size: 0.72, line: 1.35, cw: 0.62, cwU: 0.84, asc: 1.04, desc: 0.3 },
];
const HAND_PICK = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1];   // VT323 twice in ten
const wordsHash = (t) => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0; return h; };
export function handFor(text) { return HANDS[HAND_PICK[(wordsHash(String(text || '')) >>> 16) % HAND_PICK.length]]; }

// The font size for a scrap `w` wide at unit `u`; tiny is the scene's unreadable setting.
const fontSize = (w, u, hand, tiny) => (tiny ? clamp(w / 8, 5, 9) : clamp(w / 6.5, 6 * u, 14 * u)) * hand.size;
// Words wrapped to a width by a measure; a word wider than the paper breaks where it must.
function wrapLines(text, w, measure) {
  const fits = (t) => measure(t) <= w, lines = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    if (!word) continue;
    if (fits(line ? line + ' ' + word : word)) { line = line ? line + ' ' + word : word; continue; }
    if (line) lines.push(line);
    line = word;
    while (!fits(line) && line.length > 1) {
      let k = line.length - 1;
      while (k > 1 && !fits(line.slice(0, k))) k--;
      lines.push(line.slice(0, k)); line = line.slice(k);
    }
  }
  if (line) lines.push(line);
  return lines;
}
// A scrap sized to its words (the user, 2026-10-28: short notes on less paper, and not all the
// same size): the width grows with the length of the note, with a little of the hash in it, and
// the height is what the words wrap to in the note's hand, estimated from the face's measured
// glyph widths so it is known before the face has loaded, the same everywhere and forever.
const SCRAP_MIN = 34, SCRAP_MAX = 88, MARGIN = 4;
export function scrapFor(text) {
  const t = String(text || ''), hand = handFor(t), hh = wordsHash(t);
  const j = (k) => ((hh >>> (k * 5)) & 31) / 31;
  const est = (s, fs) => { let x = 0; for (const ch of s) x += (ch >= 'A' && ch <= 'Z' ? hand.cwU : hand.cw) * fs; return x; };
  let w = Math.round(clamp(30 + Math.sqrt(t.length) * 5.4 + (j(1) - 0.5) * 16, SCRAP_MIN, SCRAP_MAX));
  let fs = fontSize(w, 1, hand, false), inner = w - 2 * MARGIN;
  for (let k = 0; k < 4; k++) {   // widen for a word wider than the paper, if there is room
    const longest = Math.max(0, ...t.split(' ').map((s) => est(s, fs)));
    if (longest <= inner || w >= SCRAP_MAX) break;
    w = Math.min(SCRAP_MAX, Math.ceil(longest + 2 * MARGIN + 2)); fs = fontSize(w, 1, hand, false); inner = w - 2 * MARGIN;
  }
  const lines = wrapLines(t, inner, (s) => est(s, fs)).length, lineH = Math.round(fs * hand.line);
  const h = Math.round(2 * MARGIN + fs * hand.asc + (lines - 1) * lineH + fs * hand.desc + 2 + j(2) * 6);
  return { w, h: clamp(h, 20, CORK.h - 4), paper: (hh >>> 8) % 6 };
}

// Which faces have arrived. The key goes into the props and close-up keys so both redraw as the
// faces land; a face is counted only when the browser says its file loaded (`check` says yes for
// a face it has never heard of, which drew a fallback once).
const loaded = new Set();
let handsAsked = false, handsKeyStr = '';
export function handsKey() {
  if (typeof document === 'undefined' || !document.fonts) return 'all';
  if (!handsAsked) {
    handsAsked = true;
    const ask = (face, again) => document.fonts.load(`24px "${face}"`).then((fs) => {
      if (fs.length) { loaded.add(face); handsKeyStr = [...loaded].join(','); }
      else if (again) setTimeout(() => ask(face, false), 2500);   // the stylesheet was not in yet
    }).catch(() => {});
    for (const h of HANDS) ask(h.face, true);
  }
  return handsKeyStr;
}
export function noteFontReady() { return handsKey().includes('VT323'); }
// The words set on the paper: wrapped in the hand, the first baseline set down by the face's
// real ascent (set at the top, a tall hand's ascenders were cut off by the paper's edge), and
// the size stepped down until the lines fit, since the scrap was sized by an estimate.
function drawNoteText(ctx, text, x, y, w, h, color, u, hand = HANDS[0], tiny = false) {
  let size = Math.round(fontSize(w, u, hand, tiny));
  if (size < 4 || w < 8 || h < 4) return;
  const [c, g] = makeCanvas(w, h);
  g.textBaseline = 'alphabetic'; g.fillStyle = color; g.strokeStyle = color; g.lineJoin = 'round';
  for (let k = 0; ; k++) {
    g.font = `${size}px "${hand.face}", ${hand.mono ? '"Courier New", monospace' : 'cursive'}`;
    const lines = wrapLines(text, w, (t) => g.measureText(t).width);
    const m = g.measureText('Hbdfghjklpqy'), asc = Math.ceil(m.actualBoundingBoxAscent), desc = Math.ceil(m.actualBoundingBoxDescent);
    const lineH = Math.round(size * hand.line), max = Math.max(1, 1 + Math.floor((h - asc - desc) / lineH));
    if (lines.length > max && k < 4 && size > 4) { size = Math.max(4, Math.round(size * 0.88)); continue; }
    if (hand.bold && !tiny) g.lineWidth = size * hand.bold;
    lines.slice(0, max).forEach((t, i) => { g.fillText(t, 0, asc + i * lineH); if (hand.bold && !tiny) g.strokeText(t, 0, asc + i * lineH); });
    break;
  }
  const img = g.getImageData(0, 0, w, h), d = img.data, cut = tiny ? 70 : (hand.cut ?? 110);   // a thin stroke at 6 px keeps its pixels
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] > cut ? 255 : 0;
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
// The paper being placed, carried over the cork under the pointer: drawn on its own small
// canvas and lit by the same ambient as the close-up, so at night it is no brighter than the
// board it is about to go on.
export function drawGhostNote(ctx, note, cu, ambient) {
  const [big] = closeupNotes({ notes: [note] }, cu);
  const s = Math.max(1, Math.round(big.u)), pad = 2 * s + 2;
  const [c, g] = makeCanvas(big.w + 2 * pad + 2 * s, big.h + 2 * pad + 2 * s);
  const [m, mg] = makeCanvas(c.width, c.height);
  drawNote(g, { ...big, x: pad, y: pad }, big.u, true);
  mg.drawImage(c, 0, 0);
  g.globalCompositeOperation = 'multiply'; g.fillStyle = rgb(ambient); g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in'; g.drawImage(m, 0, 0);
  ctx.drawImage(c, big.x - pad, big.y - pad);
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
