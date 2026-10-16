// The clouds the feed does not see. Open-Meteo reports the cover for its grid cell, and on an
// afternoon of big cumulus hanging over the ranges it can still say 1% (2026-10-13: fat clouds
// sliding behind the mountains, the feed clear). The valley webcams see them. Two stills come
// through the site's own proxy (functions/api/cam/[name].js; tools/serve.py does the same for
// the dev server) and the sky above each cam's ridges is read for cloud: a pixel is cloud when
// it stands out from its row's clear-sky level (brighter or darker than the row's median, since
// the lit tops are white and the bases gray) or sits in rough texture (an 8 px block with any
// spread, since clear sky is smooth and cloud is not). Color is no use: one cam has a blue cast
// that makes cloud white read bluer than the other cam's sky. The fraction tops up the low
// cover the scene draws cumulus from (main.js, camCover); it never takes cloud away, and only
// by day with the sun well up, since dusk paints the sky unevenly on its own.
//
// Fog, too. On a calm cold morning the valley fills with fog that the grid model never has (a
// morning of fog to the South Hills, Sentinel gone from downtown, and the feed said clear, 0%
// cloud, 18 km visibility, 2026-10-15). A fogged frame is smooth: the mountain that fills the
// KPAX cam's frame is a flat gray, so the texture of each cam's scene (the mean spread within
// 8 px blocks of the part of the frame that holds the hills) reads the fog, a flat frame fog
// and a textured one clear. The KPAX cam decides (Sentinel fills it, so a blank frame is not
// ambiguous); the Mountain Press cam, 400 ft up the South Hills, says how deep the fog is: in
// it too, and the sea comes up the slopes (main.js, camFog).
import { LAT, LON } from './state.js';
import { sunPosition } from './util/solar.js';

// Each cam's sky, as rectangles in fractions of the frame, kept off the burned-in captions and
// sponsor boxes and above the ridges (docs/webcams.md). Re-measure if a cam is re-aimed.
// `scene` is the part of the frame that holds the hills (off the near trees and the captions),
// read for fog; `fogTex` the block texture that is full fog and the one that is clear. Measured
// on a fogged morning (2026-10-15): 0.7 on the KPAX frame inside the fog; on the Mountain Press
// frame 2.3 inside it and 3.6 an hour later with the cam just above the sea, hazy hills over a
// white floor, which should read as the fog partway down, so its clear end sits just above that.
// The clear ends are set without a clear frame to measure; check them against one (the ?diag
// line shows each cam's texture).
export const CAMS = [
  { id: 'mp', label: 'Mountain Press cam', sky: [[0.23, 0.05, 0.82, 0.20], [0.0, 0.11, 0.23, 0.36], [0.23, 0.20, 0.50, 0.29]], scene: [[0.05, 0.36, 0.80, 0.58]], fogTex: [2.5, 4.5] },
  { id: 'kpax', label: 'KPAX cam', sky: [[0.18, 0.02, 0.60, 0.18], [0.60, 0.02, 0.98, 0.24]], scene: [[0.20, 0.30, 0.98, 0.95]], fogTex: [1.5, 5] },
];
export const CAM_FRESH_MS = 30 * 60 * 1000;   // a reading older than this is not used
const DEV = 18;      // luminance steps from the row's median that make a pixel cloud
const TEX = 6;       // luminance spread within an 8 px block that makes it cloud
const DARK = 50;     // mean luminance below which the cam is looking at night
const SUN_MIN = 8;   // degrees; below this the sky's own gradients fool the test
const BLOCK = 8;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('cam image failed: ' + url));
    img.src = url;
  });
}

// Fraction of the sky rectangles that is cloud, and the mean luminance (null fraction at night).
export function cloudFraction(data, W, H, rects) {
  let n = 0, cloud = 0, lumSum = 0;
  const px = data.data;
  for (const [fx0, fy0, fx1, fy1] of rects) {
    const x0 = Math.floor(fx0 * W), y0 = Math.floor(fy0 * H), x1 = Math.floor(fx1 * W), y1 = Math.floor(fy1 * H);
    const w = x1 - x0, h = y1 - y0;
    if (w < BLOCK || h < BLOCK) continue;
    const lum = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = ((y0 + y) * W + x0 + x) * 4;
        const l = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
        lum[y * w + x] = l; lumSum += l;
      }
    }
    const isCloud = new Uint8Array(w * h);
    const row = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      row.set(lum.subarray(y * w, y * w + w)); row.sort();
      const med = row[w >> 1];
      for (let x = 0; x < w; x++) if (Math.abs(lum[y * w + x] - med) > DEV) isCloud[y * w + x] = 1;
    }
    for (let by = 0; by + BLOCK <= h; by += BLOCK) {
      for (let bx = 0; bx + BLOCK <= w; bx += BLOCK) {
        let s = 0, s2 = 0;
        for (let y = by; y < by + BLOCK; y++) for (let x = bx; x < bx + BLOCK; x++) { const l = lum[y * w + x]; s += l; s2 += l * l; }
        const m = s / (BLOCK * BLOCK), sd = Math.sqrt(Math.max(0, s2 / (BLOCK * BLOCK) - m * m));
        if (sd > TEX) for (let y = by; y < by + BLOCK; y++) for (let x = bx; x < bx + BLOCK; x++) isCloud[y * w + x] = 1;
      }
    }
    n += w * h;
    for (let i = 0; i < w * h; i++) cloud += isCloud[i];
  }
  if (!n) return { cloud: null, lum: 0 };
  const lum = lumSum / n;
  return { cloud: lum < DARK ? null : cloud / n, lum };
}

// The mean luminance spread within 8 px blocks over the rectangles: a fogged frame is smooth,
// a clear hillside is not. Also the mean luminance, to know a dark frame.
export function texture(data, W, H, rects) {
  const px = data.data;
  let blocks = 0, sdSum = 0, lumSum = 0, n = 0;
  for (const [fx0, fy0, fx1, fy1] of rects) {
    const x0 = Math.floor(fx0 * W), y0 = Math.floor(fy0 * H), x1 = Math.floor(fx1 * W), y1 = Math.floor(fy1 * H);
    for (let by = y0; by + BLOCK <= y1; by += BLOCK) {
      for (let bx = x0; bx + BLOCK <= x1; bx += BLOCK) {
        let s = 0, s2 = 0;
        for (let y = by; y < by + BLOCK; y++) {
          for (let x = bx; x < bx + BLOCK; x++) {
            const i = (y * W + x) * 4;
            const l = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
            s += l; s2 += l * l;
          }
        }
        const m = s / (BLOCK * BLOCK);
        sdSum += Math.sqrt(Math.max(0, s2 / (BLOCK * BLOCK) - m * m)); blocks++;
        lumSum += s; n += BLOCK * BLOCK;
      }
    }
  }
  if (!blocks) return { tex: null, lum: 0 };
  return { tex: sdSum / blocks, lum: lumSum / n };
}

// The median luminance over the rectangles, through a histogram (the rectangles are most of a
// 1920 px frame; a sort would not do).
export function medianLum(data, W, H, rects) {
  const px = data.data, hist = new Uint32Array(256);
  let n = 0;
  for (const [fx0, fy0, fx1, fy1] of rects) {
    const x0 = Math.floor(fx0 * W), y0 = Math.floor(fy0 * H), x1 = Math.floor(fx1 * W), y1 = Math.floor(fy1 * H);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        hist[Math.min(255, Math.round((px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000))]++; n++;
      }
    }
  }
  if (!n) return null;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc * 2 >= n) return v; }
  return 255;
}

// Is the cam on its usual view? The KPAX cam is a pan-tilt-zoom camera, and on a clear afternoon
// (2026-10-16) it had been swung down onto the stadium: its sky rectangles were full of trees
// and hillside, which read as 78% cloud, and the bench hung mountain fog under a blue sky. By
// day the sky is brighter than the hills, so a frame counts only when every sky rectangle's
// median luminance is above the hills' (the scene rectangle's); the margin is zero until a
// clear frame has been measured (that day's panned frame: sky 98 and 127 against hills 110; the
// Mountain Press frame: sky 193 to 207 against hills 149). An off frame adds nothing, cloud
// or fog, which is the cams' rule anyway.
function onView(data, W, H, cam) {
  if (!cam.scene) return { on: true };
  const hills = medianLum(data, W, H, cam.scene);
  let sky = null;
  for (const r of cam.sky) { const m = medianLum(data, W, H, [r]); if (m != null && (sky == null || m < sky)) sky = m; }
  if (hills == null || sky == null) return { on: true, sky, hills };
  return { on: sky > hills, sky, hills };
}

async function readCam(cam, canvas) {
  const img = await loadImage('api/cam/' + cam.id + '?t=' + Math.floor(Date.now() / CAM_FRESH_MS));
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) throw new Error('cam image empty');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, W, H);
  const r = cloudFraction(data, W, H, cam.sky);
  // fog: how far the scene's texture has dropped from clear toward a flat frame (null at night)
  const t = cam.scene ? texture(data, W, H, cam.scene) : { tex: null, lum: 0 };
  r.tex = t.tex;
  r.fog = t.tex == null || t.lum < DARK ? null : Math.max(0, Math.min(1, (cam.fogTex[1] - t.tex) / (cam.fogTex[1] - cam.fogTex[0])));
  // a cam swung off its view says nothing, by day (at night both readings are null already)
  const v = onView(data, W, H, cam);
  r.sky = v.sky; r.hills = v.hills; r.off = false;
  if (!v.on && r.lum >= DARK) { r.off = true; r.cloud = null; r.fog = null; }
  return r;
}

// Reads every cam it can; the cumulus is the most any one of them sees. `ok` is false when none
// answered (the dev server without the proxy, GitHub Pages, a cam down).
export async function fetchCams() {
  const canvas = document.createElement('canvas');
  // fog: the KPAX cam's reading (null when it is dark or down); fogHigh: the Mountain Press cam's
  const out = { ok: false, at: Date.now(), cumulus: 0, fog: null, fogHigh: null, cams: {} };
  for (const cam of CAMS) {
    try {
      const r = await readCam(cam, canvas);
      out.cams[cam.id] = r;
      if (r.cloud != null) { out.ok = true; out.cumulus = Math.max(out.cumulus, r.cloud); }
      if (r.fog != null) { out.ok = true; if (cam.id === 'kpax') out.fog = r.fog; else out.fogHigh = r.fog; }
    } catch (err) {
      out.cams[cam.id] = { error: String(err && err.message || err) };
    }
  }
  canvas.width = canvas.height = 1;
  return out;
}

// What the cams add to the feed's weather, or null when they add nothing: the low cover raised
// to the cloud the cams see, the total with it, and a clear code turned partly cloudy. Only a
// fresh daytime reading on a dry day, and only upward.
export function camCover(cams, w, now) {
  if (!cams || !cams.ok || !w || !w.ok) return null;
  if (now.getTime() - cams.at > CAM_FRESH_MS) return null;
  if (w.code >= 45) return null;   // fog, drizzle, rain, snow: the feed's sky stands
  if (sunPosition(now, LAT, LON).altitude < SUN_MIN) return null;
  const c = Math.min(1, cams.cumulus);
  const low = w.coverLow ?? w.cover ?? 0;
  if (c <= low + 0.05) return null;
  const code = w.code <= 2 ? (c > 0.3 ? 2 : Math.max(w.code, 1)) : w.code;
  return { coverLow: c, cover: Math.max(w.cover ?? 0, c), code, camCumulus: c };
}

// The fog the cams see and the feed does not, or null: the weather code turned to fog when the
// KPAX frame has gone flat, with how deep it is (`fogTop`, 0..1: the valley floor only, or up
// the slopes when the Mountain Press cam on the South Hills is inside it too). Only a fresh
// reading with the sun near up (the cams are lit from civil dawn; fog is a morning thing), when
// the feed is not already saying fog or precipitation, and only in cold weather: a warm blank
// frame is smoke, which is not drawn yet, and a smoke day must not come out as an inversion.
export const FOG_MAX_TEMP = 50;   // °F
export function camFog(cams, w, now) {
  if (!cams || !cams.ok || !w || !w.ok || cams.fog == null) return null;
  if (now.getTime() - cams.at > CAM_FRESH_MS) return null;
  if (w.code >= 45) return null;
  if (w.temp != null && w.temp >= FOG_MAX_TEMP) return null;
  if (sunPosition(now, LAT, LON).altitude < -4) return null;
  if (cams.fog < 0.5) return null;
  // The sea is always drawn opaque. A reading of how thin the fog is was tried from the Mountain
  // Press cam's residual texture and misread the classic inversion: that texture rises when the
  // fog top drops below the cam and the hills come into view over a solid white floor, which is
  // the opaque case, not the thin one (2026-10-15, the user: "most true inversion days they are
  // pretty opaque"; "it's pretty heavy in the cams").
  return { code: 45, camFog: cams.fog, fogTop: 0.35 + 0.65 * (cams.fogHigh ?? 0) };
}
