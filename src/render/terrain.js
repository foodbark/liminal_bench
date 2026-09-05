import { W, H } from '../state.js';
import { bayer, lerpRGB, mulRGB, scaleRGB, quantRGB, clamp, hex, lum } from '../util/pixel.js';
import { valueNoise1D, hash2 } from '../util/noise.js';
import { LAYER, MAT } from '../assets.js';

// The terrain is a painting (assets/backdrop.png) with a per-pixel layer/material/height mask.
// This pass re-lights it for the current season and weather: seasonal grass tint, snow creeping
// down each layer, aerial perspective and fog toward the sky's horizon color, then the ambient
// light multiplier. Sky pixels stay transparent so the procedural sky shows through.

// Grass tone by month: green spring, greener early summer, tan by August, brown into winter.
function grassColors(month) {
  const K = [
    ['#7a6a3c', '#a89465'], ['#7a6a3c', '#a89465'], ['#6e6b3a', '#9c9560'], ['#4f7a35', '#84a552'],
    ['#3f7f33', '#78ad50'], ['#3a7a30', '#74a84c'], ['#5f7d34', '#9aa653'], ['#7c7a3a', '#b5a660'],
    ['#8a7a3c', '#bda863'], ['#8a6f3a', '#b89a5d'], ['#7a6a3c', '#a89465'], ['#7a6a3c', '#a89465'],
  ];
  return [hex(K[month][0]), hex(K[month][1])];
}
// Hillside grass: a touch lighter and dustier than the meadow in the foreground.
function hillGrass(month) {
  const [d, l] = grassColors(month);
  return [lerpRGB(d, [150, 130, 90], 0.15), lerpRGB(l, [225, 205, 150], 0.25)];
}
// The painting is a late-summer scene; tint grass by the ratio of this month's tone to September's.
const ART_MONTH = 8;
function grassTint(month, hill) {
  const now = hill ? hillGrass(month)[1] : grassColors(month)[1];
  const ref = hill ? hillGrass(ART_MONTH)[1] : grassColors(ART_MONTH)[1];
  return [0, 1, 2].map((i) => clamp(now[i] / ref[i], 0.5, 1.6));
}

const SNOW_DARK = [146, 166, 208], SNOW_LIT = [250, 251, 255];
const GROUND_SNOW_DARK = [190, 202, 230], GROUND_SNOW_LIT = [246, 248, 252];
const PACKED_DARK = [176, 184, 205], PACKED_LIT = [214, 220, 236];
const SNOW_BIAS = { [LAYER.FAR]: 0.25, [LAYER.FLANK]: -0.15, [LAYER.TREES]: -0.1 };
const snowN = valueNoise1D(7);

function putPx(data, i, c) {
  data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
}

export function renderTerrain(img, env, assets) {
  const data = img.data; data.fill(0);
  const { horizon, ambient } = env.pal;
  if (!assets) { // no painting available: a flat ground so the page still runs
    for (let y = 300; y < H; y++) for (let x = 0; x < W; x++) putPx(data, (y * W + x) * 4, mulRGB(horizon, ambient));
    return;
  }
  const { rgb, mask } = assets;
  const fogK = env.cond.fog ? 0.45 : 0;
  const wet = env.cond.precip.type === 'rain';
  const tintMeadow = grassTint(env.month, false), tintHill = grassTint(env.month, true);
  // Snow threshold per layer: the height fraction above which pixels are snowy.
  const snowThresh = {};
  for (const L of [LAYER.FAR, LAYER.FLANK, LAYER.TREES]) {
    const cov = clamp(env.snowAmount + SNOW_BIAS[L], 0, 1);
    snowThresh[L] = cov > 0 ? 1 - Math.min(1, Math.pow(cov, 1.4) * 1.35) : 2;
  }
  const groundSnow = env.groundSnow;

  for (let y = 0; y < H; y++) {
    const nearHaze = clamp(1 - (y - 336) / 50, 0, 1) * 0.2;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const layer = mask[i];
      if (layer === LAYER.SKY) continue;
      const mat = mask[i + 1], e = mask[i + 2] / 255;
      const d = bayer(x, y);
      let c = [rgb[i], rgb[i + 1], rgb[i + 2]];

      if (mat === MAT.GRASS) {
        const t = layer === LAYER.NEAR ? tintMeadow : tintHill;
        c = [c[0] * t[0], c[1] * t[1], c[2] * t[2]];
      }
      if (layer === LAYER.NEAR) {
        if (groundSnow) {
          const f = clamp(lum(c) / 190, 0, 1);
          if (mat === MAT.DIRT) c = lerpRGB(PACKED_DARK, PACKED_LIT, f);
          else if (mat === MAT.SHRUB) c = lerpRGB(c, GROUND_SNOW_LIT, 0.5);
          else if (mat === MAT.ROCK) c = lerpRGB(c, GROUND_SNOW_LIT, 0.7);
          else c = lerpRGB(GROUND_SNOW_DARK, GROUND_SNOW_LIT, f);
        } else if (wet) c = scaleRGB(c, 0.82);
      } else {
        const thresh = snowThresh[layer] + (snowN(x * 0.045) - 0.5) * 0.12 + (d - 0.5) * 0.06;
        if (e > thresh) {
          if (mat === MAT.FOLIAGE) {
            if (lum(c) > 60 && hash2(x >> 1, y >> 1, 3) > 0.45) c = lerpRGB(c, SNOW_LIT, 0.6);
          } else c = lerpRGB(SNOW_DARK, SNOW_LIT, clamp(lum(c) / 170, 0, 1));
        }
      }

      c = quantRGB(c, 9, d);
      let persp;
      if (layer === LAYER.FAR) persp = 0.22;
      else if (layer === LAYER.FLANK) persp = 0.03 + 0.22 * clamp(x / 640, 0, 1);
      else if (layer === LAYER.TREES) persp = Math.min(0.12, 0.03 + 0.22 * clamp(x / 640, 0, 1));
      else persp = nearHaze;
      const fog = layer === LAYER.NEAR ? fogK * 0.78 : fogK;
      c = lerpRGB(c, horizon, persp + fog * (1 - persp));
      putPx(data, i, mulRGB(c, ambient));
    }
  }
}
