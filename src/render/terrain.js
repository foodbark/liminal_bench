import { W, H, SEASON_SNOW } from '../state.js';
import { bayer, lerpRGB, mulRGB, scaleRGB, quantRGB, clamp, hex, lum } from '../util/pixel.js';
import { valueNoise1D, hash2 } from '../util/noise.js';
import { LAYER, MAT } from '../assets.js';

// The scene is a painting (assets/backdrop.png) with a per-pixel layer/material/height mask.
// This pass re-lights it for the moment: seasonal grass, snow creeping down each range, haze and
// fog by depth, then the ambient light. Sky pixels stay transparent so the procedural sky shows through.

// Per-layer character, far to near.
const LAYERS = {
  [LAYER.PEAK]:    { depth: 1.0, snowBias: 0.0, hill: true },
  [LAYER.RANGE]:   { depth: 0.75, snowBias: -0.05, hill: true },
  [LAYER.FARHILL]: { depth: 0.5, snowBias: -0.12, hill: true },
  [LAYER.FLANK]:   { depth: 0.3, snowBias: -0.15, hill: true },   // Mount Sentinel
  [LAYER.TREES]:   { depth: 0.22, snowBias: -0.1, hill: true },
  [LAYER.NEAR]:    { depth: 0.0, snowBias: 0, hill: false },
};

// Grass tone by month: green spring, greener early summer, tan by August, brown into winter.
function grassColors(month) {
  const K = [
    ['#7a6a3c', '#a89465'], ['#7a6a3c', '#a89465'], ['#6e6b3a', '#9c9560'], ['#4f7a35', '#84a552'],
    ['#3f7f33', '#78ad50'], ['#3a7a30', '#74a84c'], ['#5f7d34', '#9aa653'], ['#7c7a3a', '#b5a660'],
    ['#8a7a3c', '#bda863'], ['#8a6f3a', '#b89a5d'], ['#7a6a3c', '#a89465'], ['#7a6a3c', '#a89465'],
  ];
  return [hex(K[month][0]), hex(K[month][1])];
}
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

const SNOW_DARK = [118, 140, 196], SNOW_LIT = [250, 251, 255];
const GROUND_SNOW_DARK = [190, 202, 230], GROUND_SNOW_LIT = [246, 248, 252];
const PACKED_DARK = [176, 184, 205], PACKED_LIT = [214, 220, 236];
// The painting already carries some summit snow (about a June amount); only snow beyond that is
// added, and in barer months those pixels are recolored as lit rock.
const ART_SNOW = 0.12, BARE_BELOW = 0.1;
const ROCK_LIT = [110, 150, 214], ROCK_MID = [79, 122, 187];
const snowN = valueNoise1D(7);

function putPx(data, i, c) {
  data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
}

export function renderTerrain(img, env, assets) {
  const data = img.data; data.fill(0);
  const { horizon, ambient } = env.pal;
  if (!assets) {
    for (let y = (H * 0.7) | 0; y < H; y++) for (let x = 0; x < W; x++) putPx(data, (y * W + x) * 4, mulRGB(horizon, ambient));
    return;
  }
  const { rgb, mask } = assets;
  const fogK = env.cond.fog ? 0.45 : 0;
  const wet = env.cond.precip.type === 'rain';
  const tintMeadow = grassTint(env.month, false), tintHill = grassTint(env.month, true);
  const groundSnow = env.groundSnow;
  const bare = env.snowAmount < BARE_BELOW;
  const extraSnow = clamp((env.snowAmount - ART_SNOW) / (1 - ART_SNOW), 0, 1);

  const per = {};
  for (const id in LAYERS) {
    const L = LAYERS[id];
    const cov = clamp(extraSnow + L.snowBias, 0, 1);
    per[id] = {
      snowThresh: cov > 0 ? 1 - Math.min(1, Math.pow(cov, 1.4) * 1.35) : 2,
      persp: L.depth * 0.08,
    };
  }

  for (let y = 0; y < H; y++) {
    const nearHaze = clamp(1 - (y - 526) / 50, 0, 1) * 0.2;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const layer = mask[i];
      const d = bayer(x, y);
      if (layer === LAYER.SKY) continue;
      const L = LAYERS[layer], P = per[layer];
      const mat = mask[i + 1], e = mask[i + 2] / 255;
      let c = [rgb[i], rgb[i + 1], rgb[i + 2]];
      let snowy = mat === MAT.SNOW && !bare;
      const isProp = mat === MAT.PROP;

      if (!isProp) {
        if (mat === MAT.GRASS) {
          const t = L.hill ? tintHill : tintMeadow;
          c = [c[0] * t[0], c[1] * t[1], c[2] * t[2]];
        }
        if (layer === LAYER.NEAR) {
          if (groundSnow) {
            const f = clamp(lum(c) / 190, 0, 1);
            if (mat === MAT.DIRT) c = lerpRGB(PACKED_DARK, PACKED_LIT, f);
            else if (mat === MAT.SHRUB) c = lerpRGB(c, GROUND_SNOW_LIT, 0.5);
            else if (mat === MAT.ROCK) c = lerpRGB(c, GROUND_SNOW_LIT, 0.7);
            else c = lerpRGB(GROUND_SNOW_DARK, GROUND_SNOW_LIT, f);
            snowy = true;
          } else if (wet) c = scaleRGB(c, 0.82);
        } else {
          if (mat === MAT.SNOW && bare) c = lerpRGB(ROCK_MID, ROCK_LIT, 0.45 + hash2(x, y, 5) * 0.55);
          const thresh = P.snowThresh + (snowN(x * 0.045) - 0.5) * 0.12 + (d - 0.5) * 0.06;
          if (e > thresh) {
            if (mat === MAT.FOLIAGE) {
              if (lum(c) > 60 && hash2(x >> 1, y >> 1, 3) > 0.45) { c = lerpRGB(c, SNOW_LIT, 0.6); snowy = true; }
            } else { c = lerpRGB(SNOW_DARK, SNOW_LIT, clamp(lum(c) / 200, 0, 1)); snowy = true; }
          }
        }
      }

      c = quantRGB(c, 9, d);
      const persp = layer === LAYER.NEAR ? nearHaze : P.persp;
      const fog = layer === LAYER.NEAR ? fogK * 0.78 : fogK;
      c = lerpRGB(c, horizon, persp + fog * (1 - persp));

      c = mulRGB(c, ambient);

      putPx(data, i, [clamp(c[0], 0, 255), clamp(c[1], 0, 255), clamp(c[2], 0, 255)]);
    }
  }
}
