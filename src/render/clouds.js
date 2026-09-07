import { makeCanvas, bayer, clamp, lerpRGB, mulRGB, scaleRGB } from '../util/pixel.js';
import { SCALE } from '../state.js';

// Cumulus the way the reference paintings have them: a big soft mass with a scalloped outline of
// many small lobes, a flat cream top and lavender-purple shade, peach and ember at sunset, and
// almost no dither. Each cloud is laid out once (seeded) as a list of puffs; the max of their
// hemispheres gives the silhouette, a blurred copy gives the shading normals (so the joins between
// big lobes soften into one body), and small puffs get a bright cap, a shadow crease and a lit lip.
// The sprite is rebuilt only when the palette or light direction changes.

const MAX_W = Math.round(900 * SCALE), MAX_H = Math.round(700 * SCALE);

// Lay out the puffs: base blobs along a flat bottom, a taller tower on one side, then smaller
// puffs stacked on the upper arcs of their parents, twice.
export function layoutCloud(rnd, depth, opts = {}) {
  const span = Math.floor((120 + rnd() * 220) * depth * SCALE);   // nominal width of the base
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
    if (i === towerAt && opts.tower !== false) {
      // a tower: three lobes stacked and leaning, the way cumulus builds; a cumulonimbus
      // stacks six and spreads an anvil downwind from the top
      let prev = p;
      const levels = opts.anvil ? 6 : 3;
      for (let t = 0; t < levels; t++) {
        const tr = prev.r * (opts.anvil ? 0.94 - t * 0.02 : 0.82 - t * 0.05);
        const tp = { x: prev.x + (rnd() - 0.5) * prev.r * 0.5 + (opts.anvil ? (opts.anvilDir || 1) * prev.r * 0.12 : 0), y: prev.y - prev.r * 0.78, r: tr };
        puffs.push(tp); roots.push(tp); prev = tp;
      }
      if (opts.anvil) {
        const dir = opts.anvilDir || 1;
        for (let a = 1; a <= 5; a++) {
          const ar = prev.r * (0.75 - a * 0.08);
          const ap = { x: prev.x + dir * prev.r * 0.9 * a, y: prev.y + prev.r * (0.05 + a * 0.06), r: ar };
          puffs.push(ap); roots.push(ap);
        }
        const back = { x: prev.x - dir * prev.r * 0.8, y: prev.y + prev.r * 0.15, r: prev.r * 0.6 };
        puffs.push(back); roots.push(back);
      }
    }
  }
  // three generations of smaller lobes on the upper arcs; the last is what scallops the edge
  const grow = (parent, count, scale, out) => {
    for (let k = 0; k < count; k++) {
      const a = (-170 + (150 / Math.max(count - 1, 1)) * k + (rnd() - 0.5) * 24) * Math.PI / 180;
      const r = parent.r * scale * (0.75 + rnd() * 0.5);
      out.push({ x: parent.x + Math.cos(a) * parent.r * 0.82, y: parent.y + Math.sin(a) * parent.r * 0.82, r });
    }
  };
  const kids = [];
  for (const p of roots) grow(p, 4 + Math.floor(rnd() * 3), 0.5, kids);
  const grand = [];
  for (const p of kids) grow(p, 3 + Math.floor(rnd() * 2), 0.5, grand);
  const great = [];
  for (const p of grand) if (p.r * 0.55 >= 2 * SCALE) grow(p, 2 + Math.floor(rnd() * 3), 0.55, great);
  puffs.push(...kids, ...grand, ...great);
  // size the sprite to the puffs (y = 0 is the flat base) and shift into it
  let minX = Infinity, maxX = -Infinity, minY = Infinity;
  for (const p of puffs) { p.r = Math.max(2, p.r); minX = Math.min(minX, p.x - p.r); maxX = Math.max(maxX, p.x + p.r); minY = Math.min(minY, p.y - p.r); }
  const w = Math.min(MAX_W, Math.ceil(maxX - minX) + 4), h = Math.min(MAX_H, Math.ceil(-minY) + 6);
  const baseY = h - 3;
  for (const p of puffs) { p.x = p.x - minX + 2; p.y = p.y + baseY; }
  const wave = rnd() * 6.28;
  return { w, h, baseY, puffs, wave, field: null, sprite: null, spriteKey: '' };
}

// Height field: the max of hemispheres, so the big form reads as one mass; the small lobes only
// show where they stand proud of it, which is at the silhouette (scallops) and as creases.
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
      const v = Math.sqrt(r2 - d2) * 0.8;
      const i = y * w + x;
      if (v > f[i]) { f[i] = v; who[i] = pi; }
    }
  }
  for (let x = 0; x < w; x++) {
    const cut = c.baseY + Math.round(Math.sin(x * 0.11 + c.wave) * 1.5);
    for (let y = Math.max(0, cut); y < h; y++) f[y * w + x] = 0;
  }
  c.field = f; c.who = who;
  // a blurred copy for the shading normals: the joins between big lobes soften into one mass
  // while the raw field keeps the scalloped silhouette
  const k = Math.max(3, Math.round(9 * SCALE));
  const tmp = new Float32Array(w * h), fs = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -k; x < w; x++) {
      if (x + k < w) acc += f[y * w + x + k];
      if (x - k - 1 >= 0) acc -= f[y * w + x - k - 1];
      if (x >= 0) tmp[y * w + x] = acc / (2 * k + 1);
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -k; y < h; y++) {
      if (y + k < h) acc += tmp[(y + k) * w + x];
      if (y - k - 1 >= 0) acc -= tmp[(y - k - 1) * w + x];
      if (y >= 0) fs[y * w + x] = acc / (2 * k + 1);
    }
  }
  c.smooth = fs;
  let maxR = 0; for (const p of puffs) maxR = Math.max(maxR, p.r);
  c.maxR = maxR;
}

// Five tones from the palette: white tops down to a blue-gray base, hazed toward the horizon for
// distant clouds and tinted by sunset color when the sun is low.
export function cloudTones(env, depth) {
  const { ambient, horizon, sunColor } = env.pal;
  const alt = env.sun.altitude;
  // cream tops through a warm mid to lavender and purple shadow, like the concept clouds
  const base = [[255, 250, 242], [240, 226, 220], [196, 182, 216], [158, 146, 200], [118, 110, 168]];
  const cover = env.cond.cover;
  // Low sun: tops take the sun color, undersides blaze when the sun is at or just below the horizon.
  const glow = clamp(1 - Math.abs(alt - 1) / 7, 0, 1) * (1 - cover * 0.5);
  const under = clamp(1 - Math.abs(alt + 1) / 5, 0, 1) * (1 - cover * 0.5);
  const ember = lerpRGB(scaleRGB(sunColor, 0.95), [255, 110, 70], 0.4);
  const dusk = clamp((-alt - 4) / 6, 0, 1);            // well after sunset: purple-gray
  // Moonlight silvers the tops at night.
  const nightK = clamp((-alt - 3) / 5, 0, 1);
  const phaseB = 1 - Math.abs(env.moon.phase - 0.5) * 2;
  const moonK = nightK * clamp(env.moon.altitude / 15, 0, 1) * (0.1 + 0.9 * phaseB);
  const haze = clamp((1.2 - depth) * 0.35, 0, 0.45);
  const tones = base.map((t, i) => {
    let c = mulRGB(t, ambient);
    const k = i / 4;
    c = lerpRGB(c, horizon, 0.08 + k * 0.12 + haze);
    if (glow > 0) c = lerpRGB(c, i < 2 ? lerpRGB(sunColor, [255, 214, 170], 0.5) : sunColor, glow * (i < 2 ? 0.45 : 0.2));
    if (under > 0) c = lerpRGB(c, ember, under * (i >= 3 ? 0.8 : i === 2 ? 0.45 : 0.1));
    if (dusk > 0) c = lerpRGB(c, [70, 62, 96], dusk * 0.35 * (0.5 + k));
    if (moonK > 0) c = [c[0] + 120 * moonK * (i < 2 ? 0.5 : 0.2), c[1] + 140 * moonK * (i < 2 ? 0.5 : 0.2), c[2] + 200 * moonK * (i < 2 ? 0.5 : 0.2)];
    if (env.cond.storm) c = scaleRGB(c, i < 2 ? 0.75 : 0.62);
    return c.map((v) => clamp(v, 0, 255));
  });
  // rim: the silhouette facing the light, brighter and warmer than the top tone
  let rim = lerpRGB(tones[0], [255, 255, 255], 0.4);
  if (glow > 0) rim = lerpRGB(rim, lerpRGB(sunColor, [255, 240, 210], 0.3), glow * 0.8);
  if (moonK > 0) rim = lerpRGB(rim, [220, 232, 255], moonK * 0.7);
  tones.push(rim.map((v) => clamp(v, 0, 255)));
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
  const smooth = c.smooth;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : smooth[y * w + x];
  const { puffs, who } = c;
  let top = h;
  for (let i = 0; i < w * h; i++) if (field[i] > 0) { top = (i / w) | 0; break; }
  const tall = Math.max(1, c.baseY - top);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i0 = y * w + x;
    const v = field[i0];
    if (v <= 0) continue;
    // the big form: a broad light from the sun's side and above, in three flat steps
    const gx = (at(x + 4, y) - at(x - 4, y)) / 8, gy = (at(x, y + 4) - at(x, y - 4)) / 8;
    const nn = Math.hypot(gx, gy, 1);
    const ndl = clamp((-gx * Lx - gy * Ly + Lz) / nn, 0, 1);
    const fy = (c.baseY - y) / tall;
    let b = 0.12 + 0.62 * ndl + 0.26 * fy;
    b *= 0.55 + 0.45 * clamp(fy * 2.2, 0, 1);          // the flat underside sits in shade
    // each lobe: a bright cap on its lit crown, a shadow band along its underside
    const p = puffs[who[i0]];
    const ldx = (x - p.x) / p.r, ldy = (y - p.y) / p.r;
    const facing = -(ldx * Lx + ldy * Ly);
    const small = p.r < c.maxR * 0.45;
    if (small && ldy < -0.45 && facing > 0.2) b += 0.12;
    if (small && ldy > 0.45) b -= 0.12;
    // where a small puff sits on a bigger one: a crease under it, a bright lip on its lit side.
    // Boundaries between two big lobes are left alone, or the body reads as a cracked shell.
    const me = who[i0];
    const upI = i0 - w, sideI = Lx < 0 ? i0 - 1 : i0 + 1;
    const upO = y > 0 && field[upI] > 0 ? who[upI] : -1;
    const sideO = (Lx < 0 ? x > 0 : x < w - 1) && field[sideI] > 0 ? who[sideI] : -1;
    const smallR = c.maxR * 0.45;
    if (upO >= 0 && upO !== me && puffs[upO].r < smallR && puffs[upO].r < p.r) b -= 0.2;   // a small puff above me: its shadow
    else if (small && sideO >= 0 && sideO !== me && puffs[sideO].r > p.r * 1.3) b += facing > 0 ? 0.12 : -0.12;   // I am a small puff on a big one
    const edge = v < 2.5 * SCALE;
    const q = b + (bayer(x, y) - 0.5) * 0.03;
    let tone = q > 0.8 ? 0 : q > 0.62 ? 1 : q > 0.46 ? 2 : q > 0.32 ? 3 : 4;
    if (edge && (-gx * Lx - gy * Ly) > 0.15 && fy > 0.2) tone = 5;   // rim light on the silhouette facing the sun
    const col = tones[tone];
    const i = i0 * 4;
    data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; data[i + 3] = 255;
  }
  c.spriteCtx.putImageData(c.img, 0, 0);
  c.spriteKey = spriteKey;
  return c.sprite;
}
