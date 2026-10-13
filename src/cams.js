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
import { LAT, LON } from './state.js';
import { sunPosition } from './util/solar.js';

// Each cam's sky, as rectangles in fractions of the frame, kept off the burned-in captions and
// sponsor boxes and above the ridges (docs/webcams.md). Re-measure if a cam is re-aimed.
export const CAMS = [
  { id: 'mp', label: 'Mountain Press cam', sky: [[0.23, 0.05, 0.82, 0.20], [0.0, 0.11, 0.23, 0.36], [0.23, 0.20, 0.50, 0.29]] },
  { id: 'kpax', label: 'KPAX cam', sky: [[0.18, 0.02, 0.60, 0.18], [0.60, 0.02, 0.98, 0.24]] },
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

async function readCam(cam, canvas) {
  const img = await loadImage('api/cam/' + cam.id + '?t=' + Math.floor(Date.now() / CAM_FRESH_MS));
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) throw new Error('cam image empty');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, W, H);
  return cloudFraction(data, W, H, cam.sky);
}

// Reads every cam it can; the cumulus is the most any one of them sees. `ok` is false when none
// answered (the dev server without the proxy, GitHub Pages, a cam down).
export async function fetchCams() {
  const canvas = document.createElement('canvas');
  const out = { ok: false, at: Date.now(), cumulus: 0, cams: {} };
  for (const cam of CAMS) {
    try {
      const r = await readCam(cam, canvas);
      out.cams[cam.id] = r;
      if (r.cloud != null) { out.ok = true; out.cumulus = Math.max(out.cumulus, r.cloud); }
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
