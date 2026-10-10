// A picture someone brings to the board, turned into shaded pixel art in the browser: the same
// steps as tools/pixelate.py (box-average onto the art grid, pop the light to plain daylight,
// flatten texture inside shapes with an edge-keeping blur, find the photo's own hue families and
// lay each out as a short ramp, snap every pixel to that palette, ink the dark side of strong
// edges), so a poster gets the look the mountains got, and the original never leaves the browser.
// No model, no generated pixels: every output pixel is an average of the picture's own pixels.
const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]].map((r) => r.map((v) => (v + 0.5) / 16));
export const PRESETS = {
  mountain: { flatten: 2, hues: 6, steps: 5, shift: 1.0, ink: 0.0, dither: 0.3, rim: false },
  trees: { flatten: 3, hues: 4, steps: 5, shift: 1.0, ink: 0.0, dither: 0.0, rim: true },
  prop: { flatten: 1, hues: 8, steps: 4, shift: 0.5, ink: 1.0, dither: 0.0, rim: true },
  photo: { flatten: 0, hues: 0, steps: 0, shift: 0.0, ink: 0.0, dither: 0.4, rim: false, colors: 48 },
};
// Posters are a fixed few sizes in art pixels (crop to the nearest, never stretch): tall, wide,
// or square. Small enough to store beside the notes, big enough that lettering survives.
export const POSTER_SIZES = [[160, 212], [212, 160], [176, 176]];

const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
function toOklab(r, g, b, out, o) {
  r = lin(r); g = lin(g); b = lin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}
function fromOklab(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const c = (v) => srgb(Math.min(1, Math.max(0, v)));
  return [c(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), c(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), c(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
}

// Stretch the lightness to the full range, lift a dim picture to a daylight middle, a gentle
// S-curve, deeper chroma. Hue untouched.
function pop(lab, solid, n, k) {
  if (k <= 0) return;
  const Ls = []; for (let i = 0; i < n; i++) if (solid[i]) Ls.push(lab[i * 3]);
  Ls.sort((x, y) => x - y);
  const q = (p) => Ls[Math.min(Ls.length - 1, Math.max(0, Math.round(p * (Ls.length - 1))))];
  const lo = q(0.005), hi = q(0.995), span = Math.max(hi - lo, 1e-6);
  const ts = Ls.map((L) => Math.min(1, Math.max(0, (L - lo) / span)));
  const med = ts[ts.length >> 1];
  const gamma = med > 0 && med < 0.45 ? Math.log(0.45) / Math.log(med) : 1;
  for (let i = 0; i < n; i++) {
    if (!solid[i]) continue;
    const L = lab[i * 3];
    let t = Math.min(1, Math.max(0, (L - lo) / span));
    if (gamma !== 1) t = t ** gamma;
    t = t + 0.25 * k * (t * t * (3 - 2 * t) - t);
    lab[i * 3] = L + Math.min(k, 1) * ((0.16 + t * 0.81) - L);
    lab[i * 3 + 1] *= 1 + 0.35 * k; lab[i * 3 + 2] *= 1 + 0.35 * k;
  }
}

// Bilateral blur: each art pixel moves toward the neighbors that already look like it.
function flatten(lab, solid, W, H, passes, r = 2, tol = 0.025) {
  const n = W * H;
  for (let p = 0; p < passes; p++) {
    const acc = Float64Array.from(lab), wsum = new Float64Array(n).fill(1);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (!dx && !dy) continue;
      const wd = (dx * dx + dy * dy) / (2 * r * r);
      for (let y = 0; y < H; y++) {
        const ny = y + dy; if (ny < 0 || ny >= H) continue;
        for (let x = 0; x < W; x++) {
          const nx = x + dx; if (nx < 0 || nx >= W) continue;
          const j = ny * W + nx; if (!solid[j]) continue;
          const i = y * W + x, i3 = i * 3, j3 = j * 3;
          const d0 = lab[j3] - lab[i3], d1 = lab[j3 + 1] - lab[i3 + 1], d2 = lab[j3 + 2] - lab[i3 + 2];
          const w = Math.exp(-(d0 * d0 + d1 * d1 + d2 * d2) / (2 * tol * tol) - wd);
          acc[i3] += lab[j3] * w; acc[i3 + 1] += lab[j3 + 1] * w; acc[i3 + 2] += lab[j3 + 2] * w; wsum[i] += w;
        }
      }
    }
    for (let i = 0; i < n; i++) { lab[i * 3] = acc[i * 3] / wsum[i]; lab[i * 3 + 1] = acc[i * 3 + 1] / wsum[i]; lab[i * 3 + 2] = acc[i * 3 + 2] / wsum[i]; }
  }
}

// Per pixel: how far its most different 4-neighbor is, whether it is the darker of the two, and
// whether it sits on the frame's edge (the silhouette line, for a cut-out or a poster's border).
function edges(lab, solid, W, H) {
  const n = W * H, far = new Float64Array(n), darker = new Uint8Array(n), rim = new Uint8Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, i3 = i * 3;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H || !solid[ny * W + nx]) { if (solid[i]) rim[i] = 1; continue; }
      const j3 = (ny * W + nx) * 3;
      const d0 = lab[j3] - lab[i3], d1 = lab[j3 + 1] - lab[i3 + 1], d2 = lab[j3 + 2] - lab[i3 + 2];
      const d = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
      if (d > far[i]) { far[i] = d; darker[i] = lab[i3] < lab[j3] ? 1 : 0; }
    }
  }
  return { far, darker, rim };
}

// The picture's distinct colors and a weight each (count^0.6: a small accent holds its place).
function distinct(lab, solid, n) {
  const sums = new Map();
  for (let i = 0; i < n; i++) {
    if (!solid[i]) continue;
    const [r, g, b] = fromOklab(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
    const key = (Math.round(r * 31) << 10) | (Math.round(g * 31) << 5) | Math.round(b * 31);
    let s = sums.get(key); if (!s) { s = [0, 0, 0, 0]; sums.set(key, s); }
    s[0] += lab[i * 3]; s[1] += lab[i * 3 + 1]; s[2] += lab[i * 3 + 2]; s[3]++;
  }
  const pts = [], wt = [];
  for (const s of sums.values()) { pts.push([s[0] / s[3], s[1] / s[3], s[2] / s[3]]); wt.push(s[3] ** 0.6); }
  return { pts, wt };
}

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const dist2 = (p, q) => { let s = 0; for (let k = 0; k < p.length; k++) { const d = p[k] - q[k]; s += d * d; } return s; };
function kmeans(pts, wt, k) {
  k = Math.min(k, pts.length);
  const rand = rng(9);
  let best = 0; for (let i = 1; i < pts.length; i++) if (wt[i] > wt[best]) best = i;
  const cen = [pts[best].slice()];
  let d = pts.map((p) => dist2(p, cen[0]));
  for (let c = 1; c < k; c++) {   // k-means++ seeding
    let tot = 0; for (let i = 0; i < pts.length; i++) tot += d[i] * wt[i];
    if (!(tot > 0)) break;
    let r = rand() * tot, pick = pts.length - 1;
    for (let i = 0; i < pts.length; i++) { r -= d[i] * wt[i]; if (r <= 0) { pick = i; break; } }
    cen.push(pts[pick].slice());
    for (let i = 0; i < pts.length; i++) d[i] = Math.min(d[i], dist2(pts[i], cen[c]));
  }
  let near = new Int32Array(pts.length);
  for (let it = 0; it < 24; it++) {
    for (let i = 0; i < pts.length; i++) { let b = 0, bd = Infinity; for (let j = 0; j < cen.length; j++) { const dd = dist2(pts[i], cen[j]); if (dd < bd) { bd = dd; b = j; } } near[i] = b; }
    for (let j = 0; j < cen.length; j++) {
      const acc = new Float64Array(pts[0].length); let ws = 0;
      for (let i = 0; i < pts.length; i++) if (near[i] === j) { for (let q = 0; q < acc.length; q++) acc[q] += pts[i][q] * wt[i]; ws += wt[i]; }
      if (ws > 0) cen[j] = Array.from(acc, (v) => v / ws);
    }
  }
  return { cen, near };
}

// Hue families from the picture, each a ramp of `steps` tones between its own darkest and
// lightest, with an ink (the darkest tone deepened) at the head of each row.
function rampPalette(lab, solid, n, hues, steps, shift) {
  const { pts, wt } = distinct(lab, solid, n);
  const feat = pts.map((p) => { const c = Math.max(Math.hypot(p[1], p[2]), 1e-4); return [p[1] / Math.sqrt(c), p[2] / Math.sqrt(c)]; });
  const { near, cen } = kmeans(feat, wt, hues);
  const rows = [];
  for (let f = 0; f < cen.length; f++) {
    const idx = []; for (let i = 0; i < pts.length; i++) if (near[i] === f) idx.push(i);
    if (!idx.length) continue;
    idx.sort((a, b) => pts[a][0] - pts[b][0]);
    let tot = 0; for (const i of idx) tot += wt[i];
    let cw = 0, lo = null, hi = null;
    for (const i of idx) { cw += wt[i] / tot; if (lo === null && cw >= 0.03) lo = pts[i][0]; if (hi === null && cw >= 0.97) hi = pts[i][0]; }
    if (lo === null) lo = pts[idx[0]][0]; if (hi === null) hi = pts[idx[idx.length - 1]][0];
    let ma = 0, mb = 0; for (const i of idx) { ma += pts[i][1] * wt[i]; mb += pts[i][2] * wt[i]; } ma /= tot; mb /= tot;
    const ramp = [];
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps, L = lo + (hi - lo) * t, tol = Math.max((hi - lo) / steps, 0.02);
      let a = 0, b = 0, w = 0;
      for (const i of idx) if (Math.abs(pts[i][0] - L) <= tol) { a += pts[i][1] * wt[i]; b += pts[i][2] * wt[i]; w += wt[i]; }
      if (w > 0) { a /= w; b /= w; } else { a = ma; b = mb; }
      ramp.push([L, a + shift * (t - 0.5) * 0.012, b + shift * (t - 0.5) * 0.035]);   // lights toward warm, shadows toward blue
    }
    const ink = [ramp[0][0] * 0.62, ramp[0][1] * 0.9, ramp[0][2] * 0.9 - 0.01 * shift];
    rows.push([ink, ...ramp]);
  }
  return rows;
}

// Nearest palette color per pixel, the lightness pushed by the Bayer threshold where the picture
// is calm so an in-between tone becomes a pattern of both; edges stay undithered.
function snap(lab, n, W, pal, dither, calm) {
  let spread = 0;
  if (dither > 0 && pal.length > 1) {
    const mins = pal.map((p, i) => { let m = Infinity; pal.forEach((q, j) => { if (i !== j) m = Math.min(m, Math.sqrt(dist2(p, q))); }); return m; }).sort((a, b) => a - b);
    spread = mins[mins.length >> 1];
  }
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const th = dither > 0 ? (BAYER4[((i / W) | 0) & 3][i % W & 3] - 0.5) * spread * dither * 2 * calm[i] : 0;
    const L = lab[i * 3] + th, a = lab[i * 3 + 1], b = lab[i * 3 + 2];
    let best = 0, bd = Infinity;
    for (let j = 0; j < pal.length; j++) { const d0 = pal[j][0] - L, d1 = pal[j][1] - a, d2 = pal[j][2] - b; const d = d0 * d0 + d1 * d1 + d2 * d2; if (d < bd) { bd = d; best = j; } }
    out[i] = best;
  }
  return out;
}

// Box-average the picture (or its crop) onto the art grid: halve until it is close, then one
// smooth draw, which keeps the browser's resampler in its honest range.
function downsample(src, sx, sy, sw, sh, gw, gh) {
  let cur = src, cx = sx, cy = sy, cw = sw, ch = sh;
  while (cw >= gw * 2 && ch >= gh * 2) {
    const c = document.createElement('canvas'); c.width = Math.ceil(cw / 2); c.height = Math.ceil(ch / 2);
    const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(cur, cx, cy, cw, ch, 0, 0, c.width, c.height);
    cur = c; cx = 0; cy = 0; cw = c.width; ch = c.height;
  }
  const c = document.createElement('canvas'); c.width = gw; c.height = gh;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(cur, cx, cy, cw, ch, 0, 0, gw, gh);
  return g.getImageData(0, 0, gw, gh);
}

// The poster size that fits the picture's shape: tall, wide or square.
export function posterSize(w, h) {
  const r = w / h;
  if (r > 1.18) return POSTER_SIZES[1];
  if (r < 0.85) return POSTER_SIZES[0];
  return POSTER_SIZES[2];
}

// `source` is anything drawImage takes (an Image, a bitmap, a canvas) with width and height.
// Returns an ImageData of the art pixels, w by h.
export function pixelate(source, opts = {}) {
  const kind = opts.kind || 'prop', o = { ...PRESETS[kind], ...opts };
  const sw0 = source.naturalWidth || source.width, sh0 = source.naturalHeight || source.height;
  const [W, H] = opts.size || posterSize(sw0, sh0);
  const k = Math.min(sw0 / W, sh0 / H);                 // crop to the aspect, never stretch
  const cw = Math.round(W * k), ch = Math.round(H * k);
  const img = downsample(source, Math.round((sw0 - cw) / 2), Math.round((sh0 - ch) / 2), cw, ch, W, H);
  const n = W * H, d = img.data, lab = new Float64Array(n * 3), solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255; solid[i] = a >= 0.5 ? 1 : 0;
    toOklab(d[i * 4] / 255, d[i * 4 + 1] / 255, d[i * 4 + 2] / 255, lab, i * 3);
  }
  pop(lab, solid, n, opts.pop ?? 1);
  flatten(lab, solid, W, H, o.flatten);
  const { far, darker, rim } = edges(lab, solid, W, H);
  const calm = new Float64Array(n); for (let i = 0; i < n; i++) calm[i] = 1 - Math.min(1, Math.max(0, (far[i] - 0.02) / 0.04));
  let pal, idx;
  if (o.hues) {
    const rows = rampPalette(lab, solid, n, o.hues, o.steps, o.shift);
    const m = rows[0].length;                          // ink + steps
    const tones = rows.flatMap((r) => r.slice(1));
    const t = snap(lab, n, W, tones, o.dither, calm);
    idx = new Int32Array(n); pal = rows.flat();
    for (let i = 0; i < n; i++) {
      const fam = (t[i] / (m - 1)) | 0, step = t[i] % (m - 1);
      let line = o.rim && rim[i];
      if (o.ink > 0 && darker[i] && far[i] > 0.09 / o.ink) line = true;
      idx[i] = fam * m + (line ? 0 : step + 1);
    }
  } else {
    const { pts, wt } = distinct(lab, solid, n);
    pal = kmeans(pts, wt, o.colors || 48).cen;
    idx = snap(lab, n, W, pal, o.dither, calm);
  }
  const rgbPal = pal.map((p) => fromOklab(p[0], p[1], p[2]).map((v) => Math.round(v * 255)));
  const out = new ImageData(W, H), od = out.data;
  let used = new Set();
  for (let i = 0; i < n; i++) {
    const c = solid[i] ? rgbPal[idx[i]] : [0, 0, 0];
    od[i * 4] = c[0]; od[i * 4 + 1] = c[1]; od[i * 4 + 2] = c[2]; od[i * 4 + 3] = solid[i] ? 255 : 0;
    if (solid[i]) used.add(idx[i]);
  }
  out.colors = used.size;
  return out;
}
