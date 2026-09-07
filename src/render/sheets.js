import { W, H, HORIZON, SCALE } from '../state.js';
import { bayer, clamp, lerpRGB, lerp, smooth } from '../util/pixel.js';
import { valueNoise2D, valueNoise1D, hash2, mulberry32 } from '../util/noise.js';
import { cloudTones } from './clouds.js';

// The sky's cloud sheets, back to front: cirrus and cirrostratus up high, altocumulus fields and
// altostratus in the middle, stratocumulus, stratus and nimbostratus down low. Cumulus are sprites
// drawn in front of all of this (weatherfx.js). Everything here is drawn once into an ImageData
// in the worker whenever the light or the mix changes, then scrolled with the wind on the page.
// Perspective: a cloud deck is a plane overhead, so rows nearer the horizon are smaller, flatter,
// denser and hazier; depth d = VANISH / (VANISH - y) runs from 1 at the top of the frame to
// infinity at the cloud horizon.

const VANISH = Math.round(HORIZON * 0.62);
const nA = valueNoise2D(301), nB = valueNoise2D(302), nC = valueNoise2D(303);
const n1 = valueNoise1D(304);

function put(data, x, y, c) {
  const i = (y * W + x) * 4;
  data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
}
const depthAt = (y) => VANISH / Math.max(1, VANISH - y);
// noise that repeats every W pixels in x, so the sheet scrolls seamlessly
function wrapNoise(nf, x, y, fx, fy) {
  const P = 320 * SCALE;
  const a = nf(x * fx, y * fy);
  if (x < W - P) return a;
  const t = (x - (W - P)) / P;
  return lerp(a, nf((x - W) * fx, y * fy), t);
}

export function renderSheets(img, env) {
  const data = img.data; data.fill(0);
  const sky = env.sky;
  if (!sky) return;
  const { tones } = cloudTones(env, 1);
  const { horizon } = env.pal;
  const haze = (c, d) => lerpRGB(c, horizon, clamp((1 - 1 / d) * 0.55, 0, 0.55));
  const windSign = Math.sin(env.wind.dir * Math.PI / 180) >= 0 ? 1 : -1;

  // --- cirrostratus / altostratus: milky dithered veils the sun still shows through
  const veils = [[sky.veilHigh, 1, 0.30, 0.22], [sky.veilMid, 2, 0.55, 0.30]];
  for (const [k, tone, base, spread] of veils) {
    if (k <= 0) continue;
    for (let y = 0; y < VANISH; y++) {
      const d = depthAt(y);
      for (let x = 0; x < W; x++) {
        const n = wrapNoise(nA, x, y, 0.0012 / SCALE, 0.006 / SCALE);
        const dens = k * (base + spread * n) * (0.75 + 0.25 * clamp(1 - 1 / d, 0, 1));
        if (bayer(x, y) < dens) put(data, x, y, haze(tones[tone], d));
      }
    }
  }

  // --- cirrus: wisps combed along the wind, fading at their ends
  if (sky.cirrus > 0) {
    const rnd = mulberry32(77);
    const count = Math.round(6 + sky.cirrus * 34);
    for (let s = 0; s < count; s++) {
      const x0 = rnd() * W, y0 = rnd() * VANISH * 0.55;
      const len = (140 + rnd() * 420) * SCALE * (0.6 + 0.4 * sky.cirrus);
      const ang = (windSign > 0 ? -1 : 1) * (0.12 + rnd() * 0.3) + (rnd() - 0.5) * 0.1;
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      const fil = 2 + Math.floor(rnd() * 5), wave = 4 + rnd() * 10, ph = rnd() * 6.28;
      const dens = 0.35 + rnd() * 0.4;
      for (let f = 0; f < fil; f++) {
        const off = (f - fil / 2) * (2.2 * SCALE);
        for (let t = 0; t < len; t++) {
          const u = t / len;
          const fade = smooth(clamp(Math.min(u, 1 - u) * 3.5, 0, 1));
          const wy = Math.sin(u * wave + ph + f) * 3 * SCALE * u;
          let x = Math.round(x0 + cosA * t - sinA * (off + wy)), y = Math.round(y0 + sinA * t + cosA * (off + wy));
          x = ((x % W) + W) % W;
          if (y < 0 || y >= VANISH) continue;
          if (bayer(x, y) < dens * fade) put(data, x, y, haze(tones[f % 3 === 0 ? 0 : 1], depthAt(y)));
        }
      }
    }
  }

  // --- altocumulus: fields of ragged little patches in rippled rows, shrinking and flattening
  // toward the horizon; each patch is a few overlapping ellipses, gaps come in clusters
  if (sky.alto > 0) {
    const rnd = mulberry32(91);
    for (let r = 0; r < 48; r++) {
      const d = Math.pow(1.13, r);
      const R = (15 * SCALE) / d;
      if (R < 1.5) break;
      const yBase = VANISH - VANISH / d;
      const step = R * 2.3, n = Math.ceil(W / step);
      const rowSeed = rnd(), ripple = rnd() * 6.28;
      const flat = 0.7 - 0.3 * clamp(1 - 1 / d, 0, 1);
      for (let b = 0; b < n; b++) {
        const cluster = wrapNoise(nB, b * step, r * 37, 0.0025 / SCALE, 0.05);
        if (hash2(b, r, 5) > sky.alto * (0.35 + 0.9 * cluster)) continue;
        const cx = (b + rowSeed) * step + (hash2(b, r, 6) - 0.5) * step * 0.7;
        const cy = yBase + Math.sin(b * 0.9 + ripple) * R * 0.5 + (hash2(b, r, 8) - 0.5) * R * 0.8;
        const litT = haze(tones[0], d), midT = haze(tones[1], d), shT = haze(tones[2], d);
        // two or three lumps make one patch
        const lumps = 2 + Math.floor(hash2(b, r, 9) * 2);
        const top = cy - R * flat;
        for (let l = 0; l < lumps; l++) {
          const lx = cx + (l - (lumps - 1) / 2) * R * 0.9 + (hash2(b, r, 10 + l) - 0.5) * R * 0.5;
          const rx = R * (0.55 + hash2(b, r, 20 + l) * 0.6), ry = rx * flat * (0.8 + hash2(b, r, 30 + l) * 0.4);
          const ly = cy + (hash2(b, r, 40 + l) - 0.5) * R * 0.3;
          for (let dy = -ry; dy <= ry; dy++) {
            const yy = Math.round(ly + dy); if (yy < 0 || yy >= VANISH) continue;
            const hw = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry))));
            for (let dx = -hw; dx <= hw; dx++) {
              const xx = ((Math.round(lx + dx) % W) + W) % W;
              const edge = hw - Math.abs(dx) < 1.5 || Math.abs(dy) > ry - 1.5;
              if (edge && bayer(xx, yy) > 0.5) continue;
              const rel = (yy - top) / Math.max(1, R * flat * 2);   // 0 at the patch's top, 1 at its bottom
              put(data, xx, yy, rel < 0.45 ? litT : rel < 0.78 ? midT : shT);
            }
          }
        }
      }
    }
  }

  // --- stratocumulus: a lumpy sheet with gaps; stratus: a flat gray layer; nimbostratus: dark rain base
  const lumpy = sky.strato, flat = Math.max(sky.stratus, sky.nimbo);
  if (lumpy > 0 || flat > 0) {
    const dark = sky.nimbo > 0;
    const top0 = dark ? tones[2] : tones[0], top1 = dark ? tones[3] : tones[1], shade = dark ? tones[4] : tones[2], under = dark ? tones[4] : tones[3];
    for (let y = 0; y < VANISH; y++) {
      const d = depthAt(y);
      const v = Math.log(d) * 4.2;
      for (let x = 0; x < W; x++) {
        let done = false;
        if (lumpy > 0) {
          const n = 0.6 * wrapNoise(nB, x * d, v * 60, 0.0035 / SCALE, 0.02) + 0.4 * wrapNoise(nC, x * d, v * 60, 0.011 / SCALE, 0.06);
          const thr = 1 - lumpy * 0.92;
          const q = n + (bayer(x, y) - 0.5) * 0.05;
          if (q > thr) {
            const k = (q - thr) / Math.max(0.05, 1 - thr);
            const c = k > 0.55 ? top0 : k > 0.3 ? top1 : shade;
            put(data, x, y, haze(c, d)); done = true;
          }
        }
        if (!done && flat > 0) {
          const n = wrapNoise(nA, x * d, v * 40, 0.002 / SCALE, 0.03);
          const ragged = y > VANISH * 0.82 && bayer(x, y) > flat * (0.2 + n) * 3;   // frayed lower edge
          if (!ragged && bayer(x, y) < flat * (0.85 + 0.15 * n)) {
            const c = n > 0.62 ? top1 : n > 0.35 ? shade : under;
            put(data, x, y, haze(c, d));
          }
        }
      }
    }
  }
}
