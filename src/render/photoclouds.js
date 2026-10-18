import { ASSET_DIR, SCALE } from '../state.js';
import { makeCanvas, clamp } from '../util/pixel.js';
import { cloudTones } from './clouds.js';

// Cumulus cut from the user's photographs (tools/build_clouds.py: assets/clouds.png and
// clouds.json, from the config's "clouds" list), in place of the drawn puffs. Each sprite is the
// photo's own pixels averaged and snapped to a short palette; on the page it is recolored by
// lightness through the hour's cloud tones, the way the moon keeps its maria under a new
// color: each pixel's place on the light-to-dark ramp picks how much that step of the ramp has
// changed from plain daylight (cloudTones against the same tones on a clear noon), and the
// pixel is scaled by it,
// so the sprite's own white and blue-gray take the sunset's ember and the moon's silver.
// Loaded on the page only, after the scene is up; until it arrives, the drawn clouds stand in.

let sheet = null;   // { sprites: [{ x, y, w, h, far, data }], lo, hi }
export function photoClouds() { return sheet; }
// the lobe library (assets/lobes.png, lobes.json): the near clouds split along their creases
let lobes = null;   // { list: [{ x, y, w, h, data, cloud, freeTop, freeBottom, onBase }] }
export function lobeLibrary() { return lobes; }

async function loadSheet(name) {
  const r = await fetch(new URL('../../' + ASSET_DIR + '/' + name + '.json', import.meta.url));
  if (!r.ok) return null;
  const meta = await r.json();
  const im = new Image();
  im.src = new URL('../../' + ASSET_DIR + '/' + name + '.png', import.meta.url);
  await im.decode();
  const [, g] = makeCanvas(im.width, im.height);
  g.drawImage(im, 0, 0);
  return { meta, g };
}

if (typeof Image !== 'undefined') {
  (async () => {
    try {
      const loaded = await loadSheet('clouds');
      if (!loaded) return;
      const { meta, g } = loaded;
      let lo = 255, hi = 0;
      const sprites = meta.sprites.map((s) => {
        const data = g.getImageData(s.x, s.y, s.w, s.h);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue;
          const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (L < lo) lo = L; if (L > hi) hi = L;
        }
        return { ...s, data };
      });
      sheet = { sprites, lo, hi: Math.max(hi, lo + 1), cb: sprites.find((s) => s.cb) || null };
      const lb = await loadSheet('lobes');
      if (lb) lobes = { list: lb.meta.lobes.map((l) => ({ ...l, data: lb.g.getImageData(l.x, l.y, l.w, l.h) })) };
    } catch (e) { console.warn('photo clouds not loaded', e); }
  })();
}

// the tones of a clear noon: what the sprites' own colors stand for
let dayTones = null;
function daylight(depth) {
  if (!dayTones) {
    const env = { pal: { ambient: [1, 1, 1], horizon: [205, 220, 240], sunColor: [255, 250, 225] }, sun: { altitude: 50 }, moon: { phase: 0, altitude: -20 }, cond: { cover: 0, shade: 0, storm: false } };
    dayTones = cloudTones(env, depth).tones;
  }
  return dayTones;
}

// The first opaque row of each column of a sprite: the top edge the pieces of an assembly are set against.
function topContour(s) {
  if (s.top) return s.top;
  const { w, h, data } = s, d = data.data, top = new Int16Array(w).fill(h);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (d[(y * w + x) * 4 + 3]) { top[x] = y; break; }
  return (s.top = top);
}

// A near cloud is built the way the drawn ones were (layoutCloud): a base cloud, a smaller one
// set behind it as a tower rising out of its top, and a few small puffs behind the upper edge
// to scallop the outline. Every added piece goes behind the base, so the base's own edge is
// the join and the piece shows only where it stands proud of it: its lit top. The photos are
// the pieces, the grammar is the code's. Parts are listed back to front, the base last; a
// cloud that builds through an afternoon will add to this list.
export function assembleCloud(r, sheet, far) {
  const near = sheet.sprites.filter((s) => !s.far && !s.cb), small = sheet.sprites.filter((s) => s.far);
  const pick = (pool) => pool[Math.floor(r() * pool.length)];
  if (far || near.length < 2) return { parts: [{ photo: pick(far ? small : near), x: 0, y: 0 }] };
  const base = pick(near);
  const top = topContour(base);
  const parts = [];
  // the tower: a cloud under three quarters of the base's width, set over the base's middle,
  // most of its height standing above the base's top edge
  const towers = near.filter((s) => s !== base && s.w < base.w * 0.75 && s.w > base.w * 0.3);
  if (towers.length && r() < 0.8) {
    const t = pick(towers);
    const cx = Math.floor(base.w * (0.3 + r() * 0.4));
    const edge = top[Math.min(base.w - 1, Math.max(0, cx))];
    parts.push({ photo: t, x: cx - (t.w >> 1), y: edge - Math.floor(t.h * (0.55 + r() * 0.2)) });
  }
  // the scallops: one to three small puffs behind the upper edge, half showing
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n && small.length; i++) {
    const s = pick(small);
    const cx = Math.floor(base.w * (0.08 + r() * 0.84));
    const edge = top[Math.min(base.w - 1, Math.max(0, cx))];
    parts.push({ photo: s, x: cx - (s.w >> 1), y: edge - Math.floor(s.h * (0.35 + r() * 0.3)) });
  }
  parts.push({ photo: base, x: 0, y: 0 });
  return { parts };
}

// A cumulus built on a photographed base with the lobe library, by the drawn clouds' grammar
// (layoutCloud in clouds.js) kept wide and low: a whole cloud from the sheet is the base mass,
// a tower of one or two broad lobes stands out of its top seated deep into it, and one or two
// big lobes scallop the base's upper edge. Every lobe shows only the edge that was free sky in
// its photo: the parts are listed from the top of the tower down to the base and drawn in that
// order, so each lobe's crease cut lies behind the lobe below it and the base's own edge is the
// last join. The look to shoot for is cumulus_01.jpg, a heavy horizontal mass with white
// crowns; three stacked lobes with shoulders and scallops read as vertical popcorn (the user,
// 2026-10-17). A cloud that builds through an afternoon adds to this list from the base up.
export function buildCloud(r, sheet, far) {
  const near = sheet.sprites.filter((s) => !s.far && !s.cb), small = sheet.sprites.filter((s) => s.far);
  const pick = (pool) => pool[Math.floor(r() * pool.length)];
  if (far || !near.length) return { parts: [{ photo: pick(far ? small : near), x: 0, y: 0 }] };
  const base = pick(near);
  if (!lobes) return assembleCloud(r, sheet, far);
  const crowns = lobes.list.filter((l) => l.freeTop > 0.4);
  const want = (w) => {
    const ok = crowns.filter((l) => l.w >= w * 0.7 && l.w <= w * 1.4);
    if (ok.length) return ok[Math.floor(r() * ok.length)];
    const by = [...crowns].sort((a, b) => Math.abs(a.w - w) - Math.abs(b.w - w));
    return by[Math.floor(r() * Math.min(3, by.length))];
  };
  const top = topContour(base);
  const edgeAt = (x) => top[Math.min(base.w - 1, Math.max(0, Math.round(x)))];
  const above = [];   // [lobe, cx, bottomY] from the base upward
  // the tower: three lobes, each a little narrower, each standing most of its height above the one below
  const tx = base.w * (0.3 + r() * 0.4);
  const levels = r() < 0.6 ? 2 : 1;
  let w = base.w * (0.5 + r() * 0.15), cx = tx, bottom = edgeAt(tx) + 0;
  for (let t = 0; t < levels; t++) {
    const l = want(w);
    const showing = 0.38 + r() * 0.12;             // seated deep: most of the lobe is behind the mass below
    const y = bottom - l.h * showing;
    above.push({ photo: l, x: cx - l.w / 2, y: y, level: t });
    bottom = y; cx += (r() - 0.5) * l.w * 0.3; w *= 0.72;
  }
  // one or two big scallops along the base's upper edge, away from the tower, seated deep
  const n = 1 + Math.floor(r() * 2);
  for (let i = 0; i < n; i++) {
    const sx = base.w * (0.1 + r() * 0.8);
    if (Math.abs(sx - tx) < base.w * 0.25) continue;
    const l = want(base.w * (0.28 + r() * 0.14));
    above.push({ photo: l, x: sx - l.w / 2, y: edgeAt(sx) - l.h * (0.3 + r() * 0.15), level: -1 });
  }
  // drawn from the top of the tower down: higher levels first, then the scallops, then the base
  above.sort((a, b) => b.level - a.level);
  const parts = above.map((p) => ({ photo: p.photo, x: Math.round(p.x), y: Math.round(p.y) }));
  parts.push({ photo: base, x: 0, y: 0 });
  return { parts };
}

// The bounds of an assembly's parts, and the parts shifted so the bounds start at 0,0.
export function assemblyBounds(parts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.photo.w); y1 = Math.max(y1, p.y + p.photo.h); }
  for (const p of parts) { p.x -= x0; p.y -= y0; }
  return { w: x1 - x0, h: y1 - y0 };
}

// One sprite recolored for the hour, cached on the sprite (clouds sharing it share the work).
function recolored(s, tones, key, env, dark) {
  if (s.cache && s.cacheKey === key) return s.cache;
  const { w, h, data } = s;
  if (!s.cache) { const [cv, g] = makeCanvas(w, h); s.cache = cv; s.cacheCtx = g; s.img = g.createImageData(w, h); }
  paint(data, s.img, tones, env, !!s.cb, dark);
  s.cacheCtx.putImageData(s.img, 0, 0);
  s.cacheKey = key;
  return s.cache;
}

export function photoCloudSprite(c, tones, key, env) {
  if (c.sprite && c.spriteKey === key) return c.sprite;
  // the same hour's tones with the moon down: what the cloud's bulk is at night, the moon's
  // silver being kept for the crowns (paint)
  const dark = env && env.sun.altitude < -3 && env.moon.altitude > 0 ? cloudTones({ ...env, moon: { ...env.moon, altitude: -20 } }, c.depth || 1).tones : null;
  if (c.parts) {
    if (!c.sprite) { const [cv, g] = makeCanvas(c.w, c.h); c.sprite = cv; c.spriteCtx = g; }
    const g = c.spriteCtx;
    g.clearRect(0, 0, c.w, c.h);
    // (a band of shade cast from each lobe onto the one behind was tried for the joins and
    // read as a pencil outline; the lobes stay as the photos' pixels, the joins hidden by order)
    for (const p of c.parts) g.drawImage(recolored(p.photo, tones, key, env, dark), p.x, p.y);
    c.spriteKey = key;
    return c.sprite;
  }
  const { w, h, data } = c.photo;
  if (!c.sprite) { const [cv, g] = makeCanvas(w, h); c.sprite = cv; c.spriteCtx = g; c.img = g.createImageData(w, h); }
  paint(data, c.img, tones, env, !!c.cb, dark);
  c.spriteCtx.putImageData(c.img, 0, 0);
  c.spriteKey = key;
  return c.sprite;
}

// Recolor one sprite's pixels (data) into img through the hour's tones. At night the bulk is
// the dark night ambient, the moon's silver goes only on the lit crowns (the top third of the
// sprite's own lightness, scaled by how near the moon the cloud is, through `dark`: the tones
// with the moon down), and the town's glow warms the bases from below, since a cumulus over
// Missoula on a moonless night is a dark shape that blots out stars with an orange underside
// (the user, 2026-10-17: there are still cumulus at night).
function paint(data, img, tones, env, cb = false, dark = null) {
  const nightK = env ? clamp((-env.sun.altitude - 3) / 5, 0, 1) : 0;
  const body = dark || tones;
  // how this hour's light changed each step of the ramp, against a clear noon
  // The cover's dimming of the valley's light is taken back out: a cumulus top is in full sun
  // above whatever shades the ground, and the photos were taken under partly cloudy skies
  // already. Only the sun's height, the sunset and the moon change the sprite.
  // and by day the palette's own ambient (0.83 in a Missoula afternoon, set for the terrain)
  // is taken out as well, since a sunlit cumulus top is white whenever the sun is up; the
  // correction fades through dusk so the clouds still dim into the night
  const day = daylight(1);
  // (not under a storm: the cell is the cover, and the light really is down; the cell itself
  // keeps some, since its anvil stands in sun above the sheet and a lit anvil over a dark
  // valley is the storm's beauty)
  let lift = env && env.cond.storm ? (cb ? 1.3 : 1) : 1 / (1 - 0.32 * (env ? (env.cond.shade ?? env.cond.cover) : 0));
  if (env && !(env.cond.storm)) {
    const amb = env.pal.ambient, lum = Math.max(0.4, (0.299 * amb[0] + 0.587 * amb[1] + 0.114 * amb[2]));
    lift *= 1 + clamp(env.sun.altitude / 10, 0, 1) * (1 / lum - 1);
  }
  lift = 1 + (lift - 1) * (1 - nightK);   // a sunlit top's lift has no sun at night
  const ratio = day.slice(0, 5).map((b, i) => [body[i][0] / b[0] * lift, body[i][1] / b[1] * lift, body[i][2] / b[2] * lift]);
  // the moon's silver: what the moon adds to the lightest tone, for the crowns only
  const silver = dark ? [tones[0][0] - dark[0][0], tones[0][1] - dark[0][1], tones[0][2] - dark[0][2]] : null;
  // the town's glow on the bases, warm, strongest when there is no moon to compete
  const glowK = nightK * (dark ? 0.1 : 0.22) * (env && env.cond.fog ? 0.3 : 1);
  const glowCol = [255, 150, 70];
  const w = img.width, h = img.height;
  const last = ratio.length - 1;
  const src = data.data, out = img.data, { lo, hi } = sheet;
  for (let i = 0; i < src.length; i += 4) {
    if (!src[i + 3]) { out[i + 3] = 0; continue; }
    const L = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    const ln = clamp((L - lo) / (hi - lo), 0, 1);
    const t = (1 - ln) * last;
    const k = Math.min(last - 1, Math.floor(t)), f = t - k;
    const lit = silver ? clamp((ln - 0.6) / 0.35, 0, 1) : 0;                 // the crowns
    const yF = ((i >> 2) / w | 0) / h;
    const glow = glowK > 0 ? glowK * yF * yF * (1 - ln * 0.7) : 0;         // the bases, from below
    for (let ch = 0; ch < 3; ch++) {
      const q = ratio[k][ch] + (ratio[k + 1][ch] - ratio[k][ch]) * f;
      let v = src[i + ch] * q;
      if (lit > 0) v += silver[ch] * lit * (src[i + ch] / 255);
      if (glow > 0) v += glowCol[ch] * glow;
      out[i + ch] = clamp(Math.round(v), 0, 255);
    }
    out[i + 3] = 255;
  }
}
