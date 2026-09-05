import { makeCanvas, bayer, clamp, lerpRGB, mulRGB, scaleRGB } from '../util/pixel.js';

// Cumulus built the way the concept art paints them: a cauliflower of overlapping rounded puffs
// in a handful of flat tones, lit from the sun's side, bright on top, blue-gray underneath, with
// hard stepped edges and dither only where one tone meets the next. Each cloud is laid out once
// (seeded) as a list of puffs, turned into a height field, and rendered into a sprite that is
// rebuilt only when the palette changes.

const MAX_W = 420, MAX_H = 300;

// Lay out the puffs: base blobs along a flat bottom, a taller tower on one side, then smaller
// puffs stacked on the upper arcs of their parents, twice.
export function layoutCloud(rnd, depth) {
  const span = Math.floor((100 + rnd() * 200) * depth);   // nominal width of the base
  const puffs = [];
  const n0 = 3 + Math.floor(rnd() * 3);
  const towerAt = Math.floor(rnd() * n0);
  const roots = [];
  const r0 = span / (n0 + 0.5) * 0.8;
  for (let i = 0; i < n0; i++) {
    const r = r0 * (0.75 + rnd() * 0.5);
    const cx = r0 * 1.2 * i + (rnd() - 0.5) * r0 * 0.4;
    const p = { x: cx, y: -r * 0.55, r };
    puffs.push(p); roots.push(p);
    if (i === towerAt) {
      const t1 = { x: cx + (rnd() - 0.5) * r * 0.5, y: p.y - r * 0.9, r: r * 0.85 };
      const t2 = { x: t1.x + (rnd() - 0.5) * r * 0.4, y: t1.y - t1.r * 0.9, r: r * 0.65 };
      puffs.push(t1, t2); roots.push(t1, t2);
    }
  }
  const grow = (parent, count, scale, out) => {
    for (let k = 0; k < count; k++) {
      const a = (-165 + (140 / Math.max(count - 1, 1)) * k + (rnd() - 0.5) * 30) * Math.PI / 180;
      const r = parent.r * scale * (0.8 + rnd() * 0.4);
      out.push({ x: parent.x + Math.cos(a) * parent.r * 0.8, y: parent.y + Math.sin(a) * parent.r * 0.8, r });
    }
  };
  const kids = [];
  for (const p of roots) grow(p, 3 + Math.floor(rnd() * 3), 0.55, kids);
  const grand = [];
  for (const p of kids) grow(p, 2 + Math.floor(rnd() * 2), 0.55, grand);
  puffs.push(...kids, ...grand);
  // size the sprite to the puffs (y = 0 is the flat base) and shift into it
  let minX = Infinity, maxX = -Infinity, minY = Infinity;
  for (const p of puffs) { p.r = Math.max(2, p.r); minX = Math.min(minX, p.x - p.r); maxX = Math.max(maxX, p.x + p.r); minY = Math.min(minY, p.y - p.r); }
  const w = Math.min(MAX_W, Math.ceil(maxX - minX) + 4), h = Math.min(MAX_H, Math.ceil(-minY) + 6);
  const baseY = h - 3;
  for (const p of puffs) { p.x = p.x - minX + 2; p.y = p.y + baseY; }
  const wave = rnd() * 6.28;
  return { w, h, baseY, puffs, wave, field: null, sprite: null, spriteKey: '' };
}

// Height field: the max of hemispheres, so lobes stay distinct, cut flat at the base.
function buildField(c) {
  const { w, h, puffs } = c;
  const f = new Float32Array(w * h), who = new Int16Array(w * h).fill(-1);
  for (let pi = 0; pi < puffs.length; pi++) {
    const p = puffs[pi];
    const x0 = Math.max(0, Math.floor(p.x - p.r)), x1 = Math.min(w - 1, Math.ceil(p.x + p.r));
    const y0 = Math.max(0, Math.floor(p.y - p.r)), y1 = Math.min(h - 1, Math.ceil(p.y + p.r));
    const r2 = p.r * p.r;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x - p.x, dy = y - p.y, d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      const v = Math.sqrt(r2 - d2) * 0.7;
      const i = y * w + x;
      if (v > f[i]) { f[i] = v; who[i] = pi; }
    }
  }
  for (let x = 0; x < w; x++) {
    const cut = c.baseY + Math.round(Math.sin(x * 0.11 + c.wave) * 1.5);
    for (let y = Math.max(0, cut); y < h; y++) f[y * w + x] = 0;
  }
  c.field = f; c.who = who;
}

// Five tones from the palette: white tops down to a blue-gray base, hazed toward the horizon for
// distant clouds and tinted by sunset color when the sun is low.
export function cloudTones(env, depth) {
  const { ambient, horizon, sunColor } = env.pal;
  const base = [[250, 251, 255], [224, 231, 244], [166, 185, 214], [116, 142, 186], [84, 108, 154]];
  const sunset = clamp(1 - Math.abs(env.sun.altitude - 2) / 7, 0, 1) * (1 - env.cond.cover * 0.6);
  const haze = clamp((1.2 - depth) * 0.35, 0, 0.45);
  const tones = base.map((t, i) => {
    let c = mulRGB(t, ambient);
    const k = i / 4;
    c = lerpRGB(c, horizon, 0.08 + k * 0.12 + haze);
    if (sunset > 0) c = lerpRGB(c, i < 2 ? sunColor : scaleRGB(sunColor, 0.8), sunset * (i < 2 ? 0.25 : 0.6));
    if (env.cond.storm) c = scaleRGB(c, i < 2 ? 0.75 : 0.62);
    return c;
  });
  const key = tones.map((c) => c.map((v) => v >> 3).join('.')).join('|');
  return { tones, key };
}

export function cloudSprite(c, tones, key, lightX, lightY) {
  const spriteKey = key + '|' + lightX.toFixed(2) + '|' + lightY.toFixed(2);
  if (c.sprite && c.spriteKey === spriteKey) return c.sprite;
  if (!c.field) buildField(c);
  const { w, h, field } = c;
  if (!c.sprite) { const [cv, g] = makeCanvas(w, h); c.sprite = cv; c.spriteCtx = g; c.img = g.createImageData(w, h); }
  const data = c.img.data; data.fill(0);
  const lz = 0.55, ln = Math.hypot(lightX, lightY, lz);
  const Lx = lightX / ln, Ly = lightY / ln, Lz = lz / ln;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : field[y * w + x];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = field[y * w + x];
    if (v <= 0) continue;
    const gx = (at(x + 2, y) - at(x - 2, y)) * 0.25, gy = (at(x, y + 2) - at(x, y - 2)) * 0.25;
    const nn = Math.hypot(gx, gy, 1);
    const ndl = (-gx * Lx - gy * Ly + Lz) / nn;
    let b = 0.34 + 0.66 * clamp(ndl, 0, 1);
    // undersides darken toward the flat base
    const ao = clamp((c.baseY - y) / (c.h * 0.4), 0, 1);
    b *= 0.5 + 0.5 * ao;
    // thin fringes at the silhouette pick up light; creases between lobes fall into shade
    if (v < 3) b += 0.08;
    const me = c.who[y * w + x];
    if ((x > 0 && field[y * w + x - 1] > 0 && c.who[y * w + x - 1] !== me) || (y > 0 && field[(y - 1) * w + x] > 0 && c.who[(y - 1) * w + x] !== me)) b -= 0.14;
    const d = bayer(x, y);
    const q = b + (d - 0.5) * 0.09;
    const tone = q > 0.8 ? 0 : q > 0.62 ? 1 : q > 0.45 ? 2 : q > 0.3 ? 3 : 4;
    const col = tones[tone];
    const i = (y * w + x) * 4;
    data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; data[i + 3] = 255;
  }
  c.spriteCtx.putImageData(c.img, 0, 0);
  c.spriteKey = spriteKey;
  return c.sprite;
}
