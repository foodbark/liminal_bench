import { ASSET_DIR, SCALE, W, HORIZON } from '../state.js';
import { makeCanvas, clamp, blue, quant } from '../util/pixel.js';
import { cloudTones } from './clouds.js';
import { skyXY, setMistCover } from './sky.js';
import { valueNoise2D } from '../util/noise.js';
const mistNoise = valueNoise2D(8191);   // mottling for the cirrus mist, like the Milky Way's rifts

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
let lobes = null;   // { list: [{ x, y, w, h, data, cloud, freeTop, freeBottom, freeSides, onBase, seam }] }: bumps cut along their shadow seams (tools/lobes.py)
export function lobeLibrary() { return lobes; }
// the cloud field (assets/field.png, field.json): every cloudlet of a photographed altocumulus
// field with where it sat in the photo's sky, laid out on the page by the photo's own arrangement
let field = null;   // { fields: [{ photo, type, scale, width }], cloudlets: [{ x, y, w, h, u, v, rank, density, data }], lo, hi }
export function photoField() { return field; }
// the cirrus tiles (assets/cirrus.png, cirrus.json): a photographed cirrus sheet keyed to a density per cell
let cirrus = null;   // { tiles: [{ x, y, w, h, scale, data }] }
export function photoCirrus() { return cirrus; }
// the overcast decks (assets/decks.png, decks.json): photographed skies from under a stratocumulus and a nimbostratus, as luminance
let decks = null;   // { tiles: [{ x, y, w, h, kind, lum: Uint8Array }] }
export function photoDecks() { return decks; }

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
      const fd = await loadSheet('field');
      if (fd) {
        let flo = 255, fhi = 0;
        const cloudlets = fd.meta.cloudlets.map((c) => {
          const data = fd.g.getImageData(c.x, c.y, c.w, c.h), d = data.data;
          for (let i = 0; i < d.length; i += 4) {
            if (!d[i + 3]) continue;
            const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            if (L < flo) flo = L; if (L > fhi) fhi = L;
          }
          return { ...c, data, bands: [] };
        });
        field = { fields: fd.meta.fields, cloudlets, lo: flo, hi: Math.max(fhi, flo + 1) };
      }
      const dk = await loadSheet('decks');
      if (dk) decks = { tiles: dk.meta.tiles.map((t) => { const d = dk.g.getImageData(t.x, t.y, t.w, t.h).data; const lum = new Uint8Array(t.w * t.h); for (let i = 0; i < lum.length; i++) lum[i] = d[i * 4]; return { ...t, lum }; }) };
      const ci = await loadSheet('cirrus');
      if (ci) cirrus = { tiles: ci.meta.tiles.map((t) => ({ ...t, data: ci.g.getImageData(t.x, t.y, t.w, t.h) })) };
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
  // a crown is a bump whose top edge and upper flanks were sky in its photo: what stands out of
  // the mass is then the photo's own outline, never a seam cut (a mass piece with a flat seam on
  // top and sky down its sides stood on the bench with a ruler-straight top, 2026-10-20)
  const crowns = lobes.list.filter((l) => l.freeTop > 0.85 && l.freeSides > 0.7);
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
function recolored(s, tones, key, env, dark, range = sheet, sunlit = 1, light = null) {
  if (s.cache && s.cacheKey === key) return s.cache;
  const { w, h, data } = s;
  if (!s.cache) { const [cv, g] = makeCanvas(w, h); s.cache = cv; s.cacheCtx = g; s.img = g.createImageData(w, h); }
  paint(data, s.img, tones, env, !!s.cb, dark, range, sunlit, light);
  s.cacheCtx.putImageData(s.img, 0, 0);
  s.cacheKey = key;
  return s.cache;
}

// `light`: at night, which side of the cloud the moon is on ({ side: -1 | 1, k: 0..1 }), so
// the moon's silver and the rim go on the moon-facing side and the far side falls into shade
// The moon's rim on the composed cloud: the silhouette pixels on the moon's side and along
// the top take the rim tone, the pixel inside them half of it, scaled across the cloud from
// the far edge to the moon-facing one. Done after the parts are laid, not per part, since
// per part the rim ran along the joins inside the cloud and read as a pencil outline
// (the user rejected an outline once before, 2026-10-20).
function moonRim(g, w, h, light, env, tones) {
  const nightK = clamp((-env.sun.altitude - 3) / 5, 0, 1);
  const k0 = light.k * nightK;
  if (k0 <= 0.02) return;
  const img = g.getImageData(0, 0, w, h), d = img.data;
  const rimCol = tones[5] || tones[0];
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i * 4 + 3]) continue;
    const nx = x + light.side, up = y - 1;
    if ((nx < 0 || nx >= w || !d[(y * w + nx) * 4 + 3]) || (up < 0 || !d[(up * w + x) * 4 + 3])) edge[i] = 1;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i * 4 + 3]) continue;
    let r = 0;
    if (edge[i]) r = 1;
    else {
      const bx = x + light.side, by = y - 1;   // the pixel just inside an edge pixel
      if ((bx >= 0 && bx < w && edge[y * w + bx]) || (by >= 0 && edge[by * w + x])) r = 0.45;
    }
    if (!r) continue;
    const facing = clamp(0.5 + (x / w - 0.5) * light.side * 1.5, 0, 1);
    const k = r * k0 * (0.3 + 0.6 * facing) * 0.8;
    for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = clamp(Math.round(d[i * 4 + ch] + (rimCol[ch] - d[i * 4 + ch]) * k), 0, 255);
  }
  g.putImageData(img, 0, 0);
}

export function photoCloudSprite(c, tones, key, env, light = null) {
  if (light) key = key + '|' + light.side + '|' + light.k.toFixed(1);
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
    for (const p of c.parts) g.drawImage(recolored(p.photo, tones, key + '|' + (p.x / c.w).toFixed(2), env, dark, sheet, 1, light && { ...light, x0: p.x / c.w, span: (p.w || p.photo.w) / c.w }), p.x, p.y);
    if (light) moonRim(g, c.w, c.h, light, env, tones);
    c.spriteKey = key;
    return c.sprite;
  }
  const { w, h, data } = c.photo;
  if (!c.sprite) { const [cv, g] = makeCanvas(w, h); c.sprite = cv; c.spriteCtx = g; c.img = g.createImageData(w, h); }
  paint(data, c.img, tones, env, !!c.cb, dark, sheet, 1, light && { ...light, x0: 0, span: 1 });
  c.spriteCtx.putImageData(c.img, 0, 0);
  if (light) moonRim(c.spriteCtx, w, h, light, env, tones);
  c.spriteKey = key;
  return c.sprite;
}

// Recolor one sprite's pixels (data) into img through the hour's tones. At night the bulk is
// the dark night ambient, the moon's silver goes only on the lit crowns (the top third of the
// sprite's own lightness, scaled by how near the moon the cloud is, through `dark`: the tones
// with the moon down), and the town's glow warms the bases from below, since a cumulus over
// Missoula on a moonless night is a dark shape that blots out stars with an orange underside
// (the user, 2026-10-17: there are still cumulus at night).
function paint(data, img, tones, env, cb = false, dark = null, range = sheet, sunlit = 1, light = null) {
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
  // (the altocumulus field takes half of it, `sunlit`: with the whole lift the cloudlets were
  // white blobs again, with none they sat dull gray beside the white cumulus; their mass is
  // the shaded undersides, kept by pixelating the field as one image; the user, 2026-10-20)
  let lift = env && env.cond.storm ? (cb ? 1.3 : 1) : 1 / (1 - 0.32 * (env ? (env.cond.shade ?? env.cond.cover) : 0));
  if (env && !(env.cond.storm)) {
    const amb = env.pal.ambient, lum = Math.max(0.4, (0.299 * amb[0] + 0.587 * amb[1] + 0.114 * amb[2]));
    lift *= 1 + clamp(env.sun.altitude / 10, 0, 1) * (1 / lum - 1);
  }
  // the cell outside a storm (the cumulonimbus preset, or a cell the feed shows on a dry
  // afternoon) keeps most of its gray: with the full lift the anvil and the tower were one
  // white slab (2026-10-20), and a cell's shape is its shade
  if (cb && !(env && env.cond.storm)) sunlit = Math.min(sunlit, 0.35);
  // and no lift under a sheet: a cumulus below an altostratus veil, or one left in a closing
  // stratocumulus deck, is not in full sun, and lifted anyway it sat as a flat white cutout
  // on a gray sky (2026-10-20); it takes the palette's gray like everything else
  if (env && env.sky && !env.cond.storm) sunlit *= 1 - clamp(env.sky.veilMid + env.sky.strato * 0.8 + env.sky.nimbo, 0, 1);
  lift = 1 + (lift - 1) * (1 - nightK) * sunlit;   // a sunlit top's lift has no sun at night
  const ratio = day.slice(0, 5).map((b, i) => [body[i][0] / b[0] * lift, body[i][1] / b[1] * lift, body[i][2] / b[2] * lift]);
  // the moon's silver: what the moon adds to the lightest tone, for the crowns only
  const silver = dark ? [tones[0][0] - dark[0][0], tones[0][1] - dark[0][1], tones[0][2] - dark[0][2]] : null;
  // the town's glow on the bases, warm, strongest when there is no moon to compete
  const glowK = nightK * (dark ? 0.1 : 0.22) * (env && env.cond.fog ? 0.3 : 1);
  const glowCol = [255, 150, 70];
  const w = img.width, h = img.height;
  const last = ratio.length - 1;
  const src = data.data, out = img.data, { lo, hi } = range;
  // the moon's side (the user, 2026-10-22: the cloud was lit from the top right with the moon
  // top left): across the whole cloud, from its far edge to its moon-facing edge, the moon's
  // silver scales up and the shade scales down, and the silhouette's pixels on the moon's side
  // take the rim tone; the photo's own shading from the sun stays underneath
  const sideK = light && nightK > 0 ? light.k * nightK : 0;
  for (let i = 0; i < src.length; i += 4) {
    if (!src[i + 3]) { out[i + 3] = 0; continue; }
    const L = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    const ln = clamp((L - lo) / (hi - lo), 0, 1);
    const t = (1 - ln) * last;
    const k = Math.min(last - 1, Math.floor(t)), f = t - k;
    const px = (i >> 2) % w, py = (i >> 2) / w | 0;
    const yF = py / h;
    let facing = 1;
    if (sideK > 0) {
      const xF = light.x0 + (px / w) * light.span;                           // across the whole cloud, 0..1
      facing = clamp(0.5 + (xF - 0.5) * light.side * 1.5, 0, 1);             // 1 on the moon's side, 0 on the far side
    }
    const lit = silver ? clamp((ln - 0.6) / 0.35, 0, 1) * (sideK > 0 ? 0.3 + 0.7 * facing : 1) : 0;   // the crowns, on the moon's side
    const shade = sideK > 0 ? 1 - sideK * 0.3 * (1 - facing) : 1;                                     // the far side falls into shade
    const glow = glowK > 0 ? glowK * yF * yF * (1 - ln * 0.7) : 0;         // the bases, from below
    for (let ch = 0; ch < 3; ch++) {
      const q = ratio[k][ch] + (ratio[k + 1][ch] - ratio[k][ch]) * f;
      let v = src[i + ch] * q * shade;
      if (lit > 0) v += silver[ch] * lit * (src[i + ch] / 255);
      if (glow > 0) v += glowCol[ch] * glow;
      out[i + ch] = clamp(Math.round(v), 0, 255);
    }
    out[i + 3] = 255;
  }
}

// The altocumulus field, laid out on the sheet deck (W wide, down to the sheets' vanishing line)
// by the photo's own arrangement: each cloudlet at its photo position, the photo's horizon on
// the deck's vanishing line, the photo repeated across the frame (every other copy mirrored)
// and around the wrap so the field scrolls with the sheets. The feed's mid cover thins it: a
// cloudlet stays while its crowding rank beats the cover's cut, so a thin field is the photo's
// densest patches in an otherwise clear sky and the strays go first; past half (the mix never
// hands the field more than 0.7: above that the mid cover becomes the altostratus veil) a
// second copy, offset by half a period, fills the gaps with more of the same cloudlets. Each row's depth
// picks its tones (farther rows hazier, as cloudTones does for the cumulus), and the recolor
// is the cumulus sprites' own (paint), so the sunset and the moon land on the field too.
export const VANISH = Math.round(HORIZON * 0.62);
const fhash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
export function drawField(g, env) {
  g.clearRect(0, 0, W, VANISH);
  const amount = env.sky ? env.sky.alto : 0;
  if (!field || amount <= 0) return;
  const f = field.fields[0];
  const P = f.width * f.scale;                       // one copy of the photo's field, in page pixels
  const n = Math.max(1, Math.round(W / P)), Pp = W / n;
  const dark = env.sun.altitude < -3 && env.moon.altitude > 0 ? (d) => cloudTones({ ...env, moon: { ...env.moon, altitude: -20 } }, d).tones : null;
  const bands = 5, toneOf = [];
  for (let b = 0; b < bands; b++) {
    const depth = 1.2 - (b + 0.5) / bands;           // the top of the frame near, the vanishing line far
    const { tones, key } = cloudTones(env, depth);
    toneOf.push({ tones, key, dark: dark ? dark(depth) : null });
  }
  const layers = amount > 0.5 ? [[0, amount], [0.5, (amount - 0.5) / 0.2]] : [[0, amount]];
  for (const [shift, t] of layers) {
    for (let k = 0; k < n; k++) {
      const mirror = k % 2 === 1;
      for (let i = 0; i < field.cloudlets.length; i++) {
        const c = field.cloudlets[i];
        const jitter = fhash(i, k * 7 + (shift ? 3 : 0));
        if (c.rank + (jitter - 0.5) * 0.2 < 1 - t) continue;   // thinned out
        const u = mirror ? 1 - c.u : c.u;
        const x = Math.round((k + shift) * Pp + u * Pp - c.w / 2 + (shift ? (fhash(i, 11) - 0.5) * c.w : 0));
        const y = Math.round(c.v * VANISH - c.h / 2 + (shift ? (fhash(i, 13) - 0.5) * c.h * 0.6 : 0));
        if (y + c.h <= 0 || y >= VANISH) continue;
        const b = Math.min(bands - 1, Math.max(0, Math.floor(c.v * bands)));
        const t0 = toneOf[b];
        if (!c.bands[b]) c.bands[b] = { w: c.w, h: c.h, data: c.data };
        const img = recolored(c.bands[b], t0.tones, t0.key, env, t0.dark, field, 0.5);
        for (const dx of [-W, 0, W]) {
          const xx = x + dx;
          if (xx + c.w <= 0 || xx >= W) continue;
          if (mirror) { g.save(); g.translate(xx + c.w, y); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore(); }
          else g.drawImage(img, xx, y);
        }
      }
    }
  }
}

// The cirrus from the user's photograph (cirrus_02: a band of hooked cirrus): the tile's alpha is
// the cirrus density per cell, and the sheet is that tile repeated across the sky, every other
// copy mirrored, wrapped so it scrolls with the sheets. The feed's high cover says how thin a
// density still shows: a little cirrus is the dense cores only, a few hooks and streaks, full
// cover brings in the body and the haze. Each density is one solid tone (the hour's veil tones,
// the haze mixed toward the sky, all hazed toward the horizon with depth), never a stipple,
// since the sheet scrolls and a scrolling stipple dances (the user, 2026-10-11). The drawn
// filaments (sheets.js) stand in until the tile is loaded.
let cirrusImg = null;
// how much mist is over each sky pixel after the last render (0..255), for the stars: a star
// under a hook dims, one in a clear patch twinkles on
let mistCover = null;
export const mistCoverAt = (x, y) => (mistCover && y >= 0 && y < VANISH && x >= 0 && x < W ? mistCover[y * W + x] / 255 : 0);
export function clearMistCover() { if (mistCover) mistCover.fill(0); }
setMistCover(mistCoverAt);
// Fish scales (the user, 2026-10-21): the mackerel sky, small cloudlets in rippled rows, as a
// stand-in from the altocumulus photo's cloudlets until a cirrocumulus photo comes: the
// cloudlets' alpha, weighted by their lightness, laid out as drawField lays the sprites (the
// photo's own arrangement, repeated across the frame, every other copy mirrored, thinned by
// rank with the mid cover, a second offset copy past half), into a density field the mist
// stipples like the cirrus. Built once per tenth of cover and kept.
let scalesCache = new Map();
function scalesDensity(amount) {
  const q = Math.min(10, Math.max(1, Math.round(amount * 10)));
  if (scalesCache.has(q)) return scalesCache.get(q);
  const t = Math.min(1, q / 10 * 1.5);   // thinned less than the sprites: a mackerel sky is full
  const out = new Uint8ClampedArray(W * VANISH);
  const f = field.fields[0];
  const DIV = 2;                          // the photo's band at half size: scales, not lumps
  const P = f.width * f.scale / DIV;
  const n = Math.max(1, Math.round(W / P)), Pp = W / n;
  const bandH = Math.round(VANISH / DIV);
  const layers = t > 0.5 ? [[0, t], [0.5, (t - 0.5) / 0.2]] : [[0, t]];
  for (const [shift, tt] of layers) {
    for (let row = 0; row < DIV; row++) {                // the band laid again below itself down to the vanishing line
      for (let k = 0; k < n; k++) {
        // no mirroring: a cloudlet near a copy's edge met its own reflection in the next copy
        // (the user, 2026-10-22); alternate copies and the lower row slide by part of a period
        // instead, so neighbouring copies interleave their cloudlets
        const mirror = false;
        const slide = ((k + row) % 2) * 0.5 + row * 0.23;
        for (let i = 0; i < field.cloudlets.length; i++) {
          const c = field.cloudlets[i];
          // a cloudlet the photo's frame cut has a straight side: a cut side is feathered over
          // its width so it fades into the stipple instead of ending in a line (the user,
          // 2026-10-21 and 22: weird mirroring and sharp edges; the flat bases are cloud-like
          // and stay)
          const cut = cutEdges(c);
          const jitter = fhash(i, k * 7 + row * 5 + (shift ? 3 : 0));
          if (c.rank + (jitter - 0.5) * 0.2 < 1 - tt) continue;
          const cw = Math.max(1, Math.round(c.w / DIV)), chh = Math.max(1, Math.round(c.h / DIV));
          const u = (c.u + slide) % 1;
          const x0 = Math.round((k + shift) * Pp + u * Pp - cw / 2 + (shift ? (fhash(i, 11) - 0.5) * cw : 0));
          const y0 = Math.round(row * bandH + c.v * bandH - chh / 2 + (shift ? (fhash(i, 13) - 0.5) * chh * 0.6 : 0));
          if (y0 + chh <= 0 || y0 >= VANISH) continue;
          const d = c.data.data;
          for (let yy = 0; yy < chh; yy++) {
            const y = y0 + yy; if (y < 0 || y >= VANISH) continue;
            const syy = Math.min(c.h - 1, yy * DIV);
            for (let xx = 0; xx < cw; xx++) {
              const sxx = Math.min(c.w - 1, xx * DIV);
              const o = (syy * c.w + sxx) * 4, a = d[o + 3];
              if (!a) continue;
              const L = (0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]) / 255;
              // the sides only: a flat base is what an altocumulus has (the user, 2026-10-22)
              let feather = 1;
              if (cut.l) feather *= Math.min(1, xx / (cw * 0.4));
              if (cut.r) feather *= Math.min(1, (cw - 1 - xx) / (cw * 0.4));
              const v = a * (0.7 + 0.3 * L) * feather;
              const sx = mirror ? x0 + cw - 1 - xx : x0 + xx;
              const x = ((sx % W) + W) % W;
              const idx = y * W + x;
              if (v > out[idx]) out[idx] = v;
            }
          }
        }
      }
    }
  }
  // softened, so the stipple feathers every edge instead of cutting a cloudlet out sharp
  const soft = blurField(out, W, VANISH, 3);
  scalesCache.set(q, soft);
  return soft;
}
// which edges of a cloudlet were cut straight by the photo's frame or its horizon: a long
// run of cloud along that edge
function cutEdges(c) {
  if (c.cut) return c.cut;
  const d = c.data.data; let l = 0, r = 0, t = 0, b = 0;
  for (let y = 0; y < c.h; y++) { if (d[(y * c.w) * 4 + 3] > 40) l++; if (d[(y * c.w + c.w - 1) * 4 + 3] > 40) r++; }
  for (let x = 0; x < c.w; x++) { if (d[x * 4 + 3] > 40) t++; if (d[((c.h - 1) * c.w + x) * 4 + 3] > 40) b++; }
  c.cut = { l: l > c.h * 0.3, r: r > c.h * 0.3, t: t > c.w * 0.3, b: b > c.w * 0.3 };
  return c.cut;
}
// a separable box blur of a byte field, wrapping in x (the field tiles across the frame)
function blurField(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Uint8ClampedArray(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[y * w + ((k + w) % w)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      acc += src[y * w + ((x + r + 1) % w)] - src[y * w + ((x - r + w) % w)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
// The cirrus as mist, the way the Milky Way is drawn (the user, 2026-10-21: "they need to be
// more misty like the milky way"; the solid-toned version read as threads and ropes). The
// photographed tile's density per cell is sampled smoothly and put through the blue noise at a
// fixed screen position: a pixel is lit where the noise falls under the density, so dense
// cores are nearly solid and the edges thin out to scattered points, with no edge anywhere
// and never a solid tone. The lit tone is the hour's veil tone mixed toward the sky where the
// density is thin, hazed toward the horizon with depth. The stipple stays fixed to the screen
// and the density drifts under it: the renderer re-renders this with the sheets' scroll as the
// sample offset (`off`, page pixels) every few pixels of drift, instead of scrolling the pixels,
// since a scrolling stipple dances (the user, 2026-10-11). The feed's high cover sets how
// much of the tile's density shows: a little cover, the cores only; full cover, the whole veil.
// Precomputed once per tile: the smooth density (the cells interpolated), as a byte per tile
// pixel, and once per page: the mottling noise per screen pixel. A render is then lookups and
// compares (the first version did the interpolation and a pow per pixel and took 180 ms at
// full size, a hitch every few seconds of drift).
let mistMottle = null, mistSlow = null, mistGrain = null, mistSoft = null, mistMottleKey = '';
// Mares' tails (the user, 2026-10-21): cirrus uncinus is a dense hooked head with a fibrous
// tail combed out behind it by the wind shear, hanging a little below. The tile's hooks are the
// heads; the comb makes every dense cell trail a fading streak downwind (a decaying maximum
// along the comb direction, at cell resolution, so it costs nothing to speak of), and the
// mottling is stretched along the same direction so the stipple reads as fibres. The direction
// is the upper wind's: tails stream toward where the wind at cirrus height is going, east being
// the left of a south-facing frame.
const COMB_CELLS = 40;   // the tail's e-folding length, in tile cells (160 tile pixels)
export function combDir(env) {
  const from = env.upper && env.upper.windDir != null ? env.upper.windDir : env.wind.dir;
  const toward = (from + 180) * Math.PI / 180;
  const east = Math.sin(toward);
  return { dx: east >= 0 ? -1 : 1, dy: 0.3 };   // east is screen-left; the tails hang a little
}
function mistDensity(t, dir) {
  const key = dir.dx + ',' + dir.dy;
  if (t.dens && t.densKey === key) return t.dens;
  const td = t.data.data, tw = t.w, th = t.h, CELL = 4;
  const cw = Math.floor(tw / CELL), chh = Math.floor(th / CELL);
  const raw = (cx, cy) => td[((Math.min(chh - 1, Math.max(0, cy)) * CELL + 1) * tw + Math.min(cw - 1, Math.max(0, cx)) * CELL + 1) * 4 + 3];
  // the comb: each cell is the most of what lies upwind of it along the direction, decayed
  const grid = new Float32Array(cw * chh);
  const n = Math.hypot(dir.dx, dir.dy), ux = dir.dx / n, uy = dir.dy / n;
  for (let cy = 0; cy < chh; cy++) for (let cx = 0; cx < cw; cx++) {
    let best = raw(cx, cy);
    for (let k = 1; k <= COMB_CELLS * 2.5; k++) {
      const v = raw(Math.round(cx - ux * k), Math.round(cy - uy * k)) * Math.exp(-k / COMB_CELLS);
      if (v > best) best = v;
    }
    grid[cy * cw + cx] = best;
  }
  const cell = (cx, cy) => grid[Math.min(chh - 1, Math.max(0, cy)) * cw + Math.min(cw - 1, Math.max(0, cx))];
  const dens = new Uint8ClampedArray(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const fy = (ty - CELL / 2) / CELL, cy = Math.floor(fy), ay = fy - cy;
    for (let tx = 0; tx < tw; tx++) {
      const fx = (tx - CELL / 2) / CELL, cx = Math.floor(fx), ax = fx - cx;
      dens[ty * tw + tx] = (cell(cx, cy) * (1 - ax) + cell(cx + 1, cy) * ax) * (1 - ay) + (cell(cx, cy + 1) * (1 - ax) + cell(cx + 1, cy + 1) * ax) * ay;
    }
  }
  t.dens = dens; t.densKey = key;
  return dens;
}
// the noise fields the mist and the decks share: the fibres along the comb direction, the
// veil's slow mottle (its clear patches), an even mottle for the haze; made on their own, since
// a deck that drew before the cirrus tile had loaded reached for the tile through the mist
// and the thrown error killed the frame loop (a partly cloudy load froze with no clouds,
// found 2026-10-23)
function mistFields(dir) {
  const mkey = dir.dx + ',' + dir.dy;
  if (mistMottle && mistMottleKey === mkey) return;
  mistMottle = new Float32Array(W * VANISH); mistSlow = new Float32Array(W * VANISH); mistSoft = new Float32Array(W * VANISH); mistMottleKey = mkey;
  const n = Math.hypot(dir.dx, dir.dy), ux = dir.dx / n, uy = dir.dy / n;
  for (let y = 0; y < VANISH; y++) for (let x = 0; x < W; x++) {
    // fibres: the noise stretched along the comb direction, fine across it
    const along = x * ux + y * uy, across = -x * uy + y * ux;
    mistMottle[y * W + x] = 0.5 + 0.5 * mistNoise(along / 150, across / 7);
    mistSlow[y * W + x] = mistNoise(x / 210 + 50, y / 70 + 20);   // the veil's own slow mottling, streaked along the sky
    mistSoft[y * W + x] = 0.55 + 0.45 * mistNoise(x / 38 + 30, y / 26 + 70);   // an even mottle for the veil haze: the fibres are the tails' alone (the haze came out striped, the user, 2026-10-22)
  }
}
export function drawCirrusMist(g, env, off = 0, skyPix = null) {
  if (!cirrus) return;
  const t = cirrus.tiles[0];
  const k = Math.min(1, env.sky.cirrus + (env.sky.veilHigh || 0));   // all the high cover: the veil is mist too, denser
  const { tones } = cloudTones(env, 1);
  const { horizon, top } = env.pal;
  const sky = top || horizon;
  if (!cirrusImg) cirrusImg = g.createImageData(W, VANISH);
  const out = cirrusImg.data; out.fill(0);
  const td = t.data.data, tw = t.w, th = t.h;
  if (!t.join) {
    const n0 = Math.max(1, Math.round(W / tw)), full = Math.floor(Math.min(tw, W / n0));
    let best = full - 1, least = Infinity;
    for (let x = Math.floor(full * 0.84); x < full; x++) {
      let s = 0; for (let y = 0; y < th; y++) s += td[(y * tw + x) * 4 + 3];
      if (s < least) { least = s; best = x; }
    }
    t.join = best + 1;
  }
  const Pp = t.join;
  const oy = Math.round((t.dy || 0) * th);
  const drop = Math.round(th * 0.18);
  const cut = 0.5 - 0.42 * k;                // the tile density under which nothing shows
  const dir = combDir(env);
  const dens = mistDensity(t, dir);
  mistFields(dir);
  // the cirrostratus veil as mist too: the tile has dense cirrus over a few percent of its
  // frame, and a veil is a milky haze over the whole sky with blue through it, so under the
  // hooks a slow mottled haze grows with the veil amount (never more than the stipple's cap,
  // so the sky always shows through: a high veil never grays the sky)
  // the altostratus veil hazes the same way, denser and grayer than the cirrostratus
  const veil = (env.sky.veilHigh || 0), veilMid = (env.sky.veilMid || 0);
  const hazeK = Math.min(1, veil * 0.55 + veilMid * 0.85);
  // the fish scales, when there is mid cover and the altocumulus photo is loaded
  const altoAmt = env.sky.alto || 0;
  const scales = altoAmt > 0.01 && field ? scalesDensity(altoAmt) : null;
  if (!mistGrain) {
    mistGrain = new Float32Array(W * VANISH);
    for (let y = 0; y < VANISH; y++) for (let x = 0; x < W; x++) mistGrain[y * W + x] = 0.6 + 0.4 * mistNoise(x / 16 + 90, y / 12 + 40);   // a fine even grain for the scales, not the tails' fibres
  }
  const wrapW = (v) => ((v % W) + W) % W;
  // the eased density by byte, so the per-pixel work is a lookup
  const eased = new Float32Array(256);
  const cutB = cut * 255;
  for (let v = 0; v < 256; v++) eased[v] = v <= cutB ? 0 : Math.pow((v - cutB) / (255 - cutB), 1.4);
  // the lit tones by density step and depth band, mixed toward the sky where thin and toward
  // the horizon with depth
  const cache = new Map();
  const toneAt = (ms, band) => {
    const key = ms * 8 + band;
    let c = cache.get(key);
    if (!c) {
      const m = (ms + 0.5) / 6, d = 1 / (1 - (band + 0.5) / 8);
      const hz = Math.min(0.55, (1 - 1 / d) * 0.55);
      c = [0, 1, 2].map((i) => { const v = tones[0][i] + (sky[i] - tones[0][i]) * (1 - m) * 0.5; return Math.round(v + (horizon[i] - v) * hz); });
      cache.set(key, c);
    }
    return c;
  };
  const shift = Math.round(off);
  // The blend (the user, 2026-10-22, "two and four"): a stipple of single pixels switched on
  // or off read as sand at night and as low resolution everywhere, so the mist is a field
  // now: the sky is blended toward the veil tone by the density and the result is quantized
  // through the blue noise in nine steps the way the sky gradient is, so a hook's core is a
  // solid pale tone, its edge two or three stepped tones with grain only along each step, and
  // the veil a milky shift of the sky with soft mottles. Sky shows through by the blend, not by
  // holes. At night the blend sits closer to the sky (the Milky Way's restraint). The veil's
  // slow mottle opens clear patches, so there is plain sky to rest on and stars to twinkle
  // between the clouds; the coverage is kept per pixel for the stars to read.
  const nightK = clamp((-env.sun.altitude - 2) / 6, 0, 1);
  const aMax = 0.76 - 0.3 * nightK;   // a touch dimmer than the first blend ("a little bright maybe", the user, 2026-10-22)
  const SKY_BOTTOM = HORIZON + 24;
  const topCol = env.pal.top || horizon;
  const toneBand = [0, 1, 2, 3, 4, 5, 6, 7].map((band) => { const d = 1 / (1 - (band + 0.5) / 8), hz = Math.min(0.55, (1 - 1 / d) * 0.55); return [0, 1, 2].map((i) => tones[0][i] + (horizon[i] - tones[0][i]) * hz); });
  if (!mistCover) mistCover = new Uint8Array(W * VANISH); else mistCover.fill(0);
  const patch0 = 0.42 - 0.17 * k;   // the slow noise under which the veil is clear sky
  const OVm = Math.min(160, tw >> 2), Pm = tw - OVm;   // the crossfade's overlap and the period it leaves
  for (let y = 0; y < VANISH; y++) {
    const d = VANISH / Math.max(1, VANISH - y);
    const band = Math.min(7, Math.floor((1 - 1 / d) * 8));
    const tn = toneBand[band];
    // the sky under this row: the worker's own gradient when the renderer hands it over (the sun's
    // glow and the Milky Way included, so a thin blend never comes out darker than the sky it
    // sits on: an estimate left hard-edged dark blobs under the sun), else an estimate of it
    const tt = Math.pow(y / SKY_BOTTOM, 1.45);
    const skyR0 = topCol[0] + (horizon[0] - topCol[0]) * tt, skyG0 = topCol[1] + (horizon[1] - topCol[1]) * tt, skyB0 = topCol[2] + (horizon[2] - topCol[2]) * tt;
    const sp = skyPix && skyPix.height > y ? skyPix.data : null;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const skyR = sp ? sp[i * 4] : skyR0, skyG = sp ? sp[i * 4 + 1] : skyG0, skyB = sp ? sp[i * 4 + 2] : skyB0;
      // the tile's copies crossfade over an overlap, as the decks' do: a mirrored copy paired
      // the hooks into a butterfly, and dropping it to break that left a step along the whole
      // join column once the mist became a blended field (2026-10-22)
      const u = ((x - shift) % Pm + Pm) % Pm;
      const ty = y - oy;
      let e = 0;
      if (ty >= 0 && ty < th) {
        let dv = dens[ty * tw + u];
        if (u < OVm) { const f = u / OVm; dv = dens[ty * tw + Pm + u] * (1 - f) + dv * f; }
        e = eased[dv | 0];
      }
      const sl = mistSlow[i];
      const open = clamp((sl - patch0) / 0.4, 0, 1);
      const hz = hazeK > 0 ? hazeK * open * (0.45 + 0.55 * sl) : 0;
      const sc = scales ? scales[y * W + wrapW(x - shift)] / 255 * mistGrain[i] : 0;
      const mc = Math.max(e * mistMottle[i], hz * mistSoft[i]);
      const a = Math.max(mc * aMax, Math.min(0.95, sc * (aMax + 0.1)));
      if (a < 0.03) continue;
      const dn = blue(x, y);
      const o = i * 4;
      let v = (skyR + (tn[0] - skyR) * a) / 9 + dn; out[o] = (v < 0 ? 0 : v > 28.4 ? 28 : v | 0) * 9;
      v = (skyG + (tn[1] - skyG) * a) / 9 + dn; out[o + 1] = (v < 0 ? 0 : v > 28.4 ? 28 : v | 0) * 9;
      v = (skyB + (tn[2] - skyB) * a) / 9 + dn; out[o + 2] = (v < 0 ? 0 : v > 28.4 ? 28 : v | 0) * 9;
      out[o + 3] = 255;
      // the stars read the cloud's density, not how pale it is painted: the blend is faint at
      // night by design, and read as coverage it let Saturn and Fomalhaut through a full veil
      // (the user, 2026-10-22); a clear patch is still clear, since the density is zero there
      mistCover[i] = Math.min(1, Math.max(mc, sc) * 1.6) * 255;
    }
  }
  g.putImageData(cirrusImg, 0, 0);
}

// The overcast decks from the photographs (the user's mammatus over Denver as the stratocumulus,
// the rain sky as the nimbostratus; 2026-10-21). A deck is solid cloud, so the tile is the
// sky's luminance and the stipple's cap sits near solid: the photo's lumps become the deck's
// shading in the hour's deck tones by darkness (the lighter tones for the lumpy deck, the dark
// ones for the rain base), hazed toward the horizon. Where the cover is partial the deck
// breaks open along a slow noise, the stipple feathering the edges, and sky shows in the
// gaps. The tile repeats across the sky, every other copy mirrored; the stipple stays fixed to
// the screen and the deck drifts under it like the mist. The drawn decks in sheets.js stand
// in until the sheet is loaded (env.photoDecks); the flat stratus stays drawn.
let deckImg = null;
export function drawDeckMist(g, env, off = 0) {
  if (!deckImg) deckImg = g.createImageData(W, VANISH);
  const out = deckImg.data; out.fill(0);
  const { horizon } = env.pal;
  // the flat stratus takes the rain sky's texture in lighter tones (the stratus photo was set aside; the drawn sheet was "cartoony blobs of grey", the user, 2026-10-22)
  const want = [['strato', env.sky.strato || 0], ['stratus', env.sky.stratus || 0], ['nimbo', env.sky.nimbo || 0]].filter(([, a]) => a > 0.01);
  if (!want.length) { g.putImageData(deckImg, 0, 0); return; }
  mistFields(combDir(env));   // the noise fields, shared with the mist
  const shift = Math.round(off);
  // the haze toward the horizon colour, which at sunset is the ember: a deck takes it only on
  // the sun's side of the frame (w, 0..1 by distance from the sun's place) and a desaturated
  // horizon elsewhere, or the whole overcast warmed evenly (the user, 2026-10-22)
  const horizonGray = (() => { const L = 0.299 * horizon[0] + 0.587 * horizon[1] + 0.114 * horizon[2]; return [L * 0.98, L * 0.98, L * 1.04]; })();
  const haze = (c, d, w = 1) => { const hz = Math.min(0.55, (1 - 1 / d) * 0.55); return [0, 1, 2].map((i) => { const h = horizonGray[i] + (horizon[i] - horizonGray[i]) * w; return Math.round(c[i] + (h - c[i]) * hz); }); };
  for (const [kind, amount] of want) {
    const t = decks.tiles.find((x) => x.kind === kind) || (kind === 'stratus' ? decks.tiles.find((x) => x.kind === 'nimbo') : null) || decks.tiles[0];
    if (!t) continue;
    const { tones } = cloudTones(env, 1);
    // the tones by darkness: the lumpy deck from the lit top down to its shade, the rain base darker
    const ramp = kind === 'nimbo' ? [tones[1], tones[2], tones[3], tones[4]] : kind === 'stratus' ? [tones[0], tones[1], tones[1], tones[2]] : [tones[0], tones[1], tones[2], tones[3]];
    // a low sun lights an overcast's underside from its own side only: the warm tones hold
    // toward the sun's place in the frame and the rest of the deck stays its gray (the whole
    // deck went one salmon at sunset)
    const sunX = skyXY(env.sun.azimuth, env.sun.altitude).x;
    const glowK = clamp(1 - Math.abs(env.sun.altitude - 1) / 6, 0, 1);
    const gray = ramp.map((c) => { const L = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; return [L * 0.97, L * 0.97, L * 1.04]; });
    const cache = new Map();
    const toneAt = (ti, band, ek) => {
      const key = (ti * 8 + band) * 6 + ek;
      let c = cache.get(key);
      if (!c) { const w = ek / 5; const base = [0, 1, 2].map((i) => gray[ti][i] + (ramp[ti][i] - gray[ti][i]) * (1 - glowK + glowK * w)); c = haze(base, 1 / (1 - (band + 0.5) / 8), 1 - glowK + glowK * w); cache.set(key, c); }
      return c;
    };
    const tw = t.w, th = t.h, lum = t.lum;
    const solid = amount >= 0.9 || kind === 'nimbo' || (kind === 'stratus' && amount >= 0.7);   // a rain base has no gaps, a stratus few
    // the sky in a gap is bright, the way daylight through a hole in a deck is (the beauty
    // rule's blue sky through cloud gaps), not the slate the palette gives under heavy cover;
    // at night the gap is the night sky as it is
    const nightK = clamp((-env.sun.altitude - 2) / 6, 0, 1);
    const skyTop = env.pal.top || horizon;
    const gapTone = [0, 1, 2].map((i) => skyTop[i] + ([150, 185, 235][i] - skyTop[i]) * 0.55 * (1 - nightK));
    const gapCache = new Map();
    const gapAt = (band, ek = 5) => { const key = band * 6 + ek; let c = gapCache.get(key); if (!c) { c = haze(gapTone, 1 / (1 - (band + 0.5) / 8), 1 - glowK + glowK * ek / 5); gapCache.set(key, c); } return c; };
    // the copies crossfade over an overlap instead of mirroring: a mirrored join paired the
    // lumps into a butterfly, and a vertical drop to break that left rectangular seams
    const OV = Math.min(160, tw >> 2), P = tw - OV;
    for (let y = 0; y < VANISH; y++) {
      const d = VANISH / Math.max(1, VANISH - y);
      const band = Math.min(7, Math.floor((1 - 1 / d) * 8));
      for (let x = 0; x < W; x++) {
        const u = ((x - shift) % P + P) % P;
        const ty = Math.min(th - 1, y);
        // the sun-side step dithered through the noise, or a flat deck showed it as vertical bands
        const ek = glowK > 0 ? Math.min(5, Math.max(0, Math.round(clamp(1 - Math.abs(x - sunX) / (W * 0.55), 0, 1) * 5 + (blue(x + 3, y + 11) - 0.5) * 0.9))) : 0;
        // inside the overlap the tile's tail fades into the next copy's head
        let L = lum[ty * tw + u];
        if (u < OV) { const f = u / OV; L = lum[ty * tw + P + u] * (1 - f) + L * f; }
        const dark = 1 - L / 255;
        // the cover: solid, or broken open where the slow noise runs above it, feathered, the
        // holes opening first where the photo's lumps are lightest so the gaps follow the deck's
        // own structure (the slow noise bunches around its middle, so it is stretched to use its
        // whole range before the cover is set against it, or a half-covered sky was nearly empty)
        let m = 1;
        if (!solid) {
          const n = clamp((mistSlow[y * W + x] - 0.5) * 2.4 + 0.5, 0, 1) * 0.6 + (1 - dark) * 0.4;
          m = clamp((amount - n) / 0.2 + 0.5, 0, 1);
        }
        if (m <= 0 || blue(x, y) >= m * 0.97) {
          if (!solid) { const c = gapAt(band, ek); const o = (y * W + x) * 4; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255; }
          continue;
        }
        // the tone steps dithered through the noise, so the four tones meet in grain, not contour lines
        const ti = Math.min(3, Math.max(0, Math.floor(dark * 4 + (blue(x + 7, y + 3) - 0.5) * 0.9)));
        const c = toneAt(ti, band, ek);
        const o = (y * W + x) * 4;
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
      }
    }
  }
  g.putImageData(deckImg, 0, 0);
}
