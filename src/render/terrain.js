import { W, H, SEASON_SNOW } from '../state.js';
import { bayer, lerpRGB, mulRGB, scaleRGB, quantRGB, clamp, hex, lum, smooth } from '../util/pixel.js';
import { valueNoise1D, hash2 } from '../util/noise.js';
import { LAYER, MAT } from '../assets.js';

// The scene is a painting (assets/backdrop.png) with a per-pixel layer/material/height mask.
// This pass re-lights it for the moment: seasonal grass, snow creeping down each range, haze and
// fog by depth, then the light itself. Each range has its own horizon so at dawn and dusk the sun
// reaches the peak first (alpenglow) while nearer ranges and the valley sit in blue shadow; the
// moon silvers snow and rock at night; ridgelines and silhouettes against the sky catch a rim of
// light. Sky pixels stay transparent so the procedural sky shows through.

// Per-layer character, far to near. horizon: sun altitude (deg) at which the layer is lit.
const LAYERS = {
  [LAYER.PEAK]:    { depth: 1.0, horizon: -4.0, snowBias: 0.0, hill: true },
  [LAYER.RANGE]:   { depth: 0.75, horizon: -2.6, snowBias: -0.05, hill: true },
  [LAYER.FARHILL]: { depth: 0.5, horizon: -2.4, snowBias: -0.12, hill: true },
  [LAYER.FLANK]:   { depth: 0.3, horizon: -4.2, snowBias: -0.15, hill: true, backlitAM: true },   // Mount Sentinel: sunset glow on the face; at dawn the sun is behind it
  [LAYER.TREES]:   { depth: 0.22, horizon: 0.0, snowBias: -0.1, hill: true },
  [LAYER.NEAR]:    { depth: 0.0, horizon: 0.6, snowBias: 0, hill: false },
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
  const { horizon, ambient, sunColor } = env.pal;
  if (!assets) {
    for (let y = (H * 0.7) | 0; y < H; y++) for (let x = 0; x < W; x++) putPx(data, (y * W + x) * 4, mulRGB(horizon, ambient));
    return;
  }
  const { rgb, mask } = assets;
  const alt = env.sun.altitude;
  const fogK = env.cond.fog ? 0.45 : 0;
  const wet = env.cond.precip.type === 'rain';
  const tintMeadow = grassTint(env.month, false), tintHill = grassTint(env.month, true);
  const groundSnow = env.groundSnow;
  const bare = env.snowAmount < BARE_BELOW;
  const extraSnow = clamp((env.snowAmount - ART_SNOW) / (1 - ART_SNOW), 0, 1);

  // --- light for this moment
  // Alpenglow: strongest with the sun right at the horizon, deep pink-orange below it, gold above.
  // full strength within about two degrees of the horizon, fading out over the next seven
  const glow = clamp(1 - (Math.abs(alt + 0.5) - 2) / 7, 0, 1) * (1 - env.cond.cover * 0.7);
  const glowRGB = lerpRGB([255, 118, 88], [255, 205, 150], clamp((alt + 3) / 6, 0, 1));
  const litAmbient = lerpRGB(ambient, [1, 0.96, 0.92], glow);
  const shadowTint = lerpRGB([1, 1, 1], [0.72, 0.78, 0.96], clamp(1 - Math.abs(alt + 2) / 7, 0, 1));
  // Moonlight: needs night, the moon up, and a bright phase (0.5 = full).
  const nightK = clamp((-alt - 3) / 5, 0, 1);
  const moonUp = clamp(env.moon.altitude / 15, 0, 1);
  const phaseB = 1 - Math.abs(env.moon.phase - 0.5) * 2;
  const moonK = nightK * moonUp * (0.1 + 0.9 * phaseB) * (1 - env.cond.cover * 0.85);
  const MOON = [125, 155, 220];
  const sunLeft = env.sun.azimuth < 180;
  const rimColor = lerpRGB([255, 236, 200], [255, 170, 120], clamp(1 - Math.abs(alt + 1) / 5, 0, 1));
  const per = {};
  for (const id in LAYERS) {
    const L = LAYERS[id];
    const cov = clamp(extraSnow + L.snowBias, 0, 1);
    const sunK = smooth(clamp((alt - (L.horizon - 1.2)) / 2.4, 0, 1));
    const backlit = !!L.backlitAM && env.sun.azimuth < 180;   // morning sun behind this ridge
    per[id] = {
      snowThresh: cov > 0 ? 1 - Math.min(1, Math.pow(cov, 1.4) * 1.35) : 2,
      sunK,
      faceK: backlit ? 0 : sunK,        // no glow on a face the sun is behind
      rimK: backlit ? 1.8 : 1,          // but its outline burns
      rimReach: backlit ? 4 : 3,
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

      // --- sun: lit layers warm up toward the glow color, unlit ones cool into shadow
      const lm = lum(c) / 255;
      const sunK = P.faceK;
      let lit = c;
      if (glow > 0 && sunK > 0) {
        // the light lands as color: bright faces and snow go pink-orange, dark faces stay dark
        const bright = snowy ? 1 : 0.45 + 0.6 * lm;
        lit = lerpRGB(c, scaleRGB(glowRGB, bright), glow * (snowy ? 0.95 : 0.85));
      }
      const shadowed = mulRGB(mulRGB(c, shadowTint), ambient);
      const sunlit = mulRGB(lit, lerpRGB(ambient, litAmbient, sunK));
      c = lerpRGB(shadowed, sunlit, sunK);

      // --- moon: silver on snow and pale rock, a little everywhere
      if (moonK > 0) {
        const k = moonK * lm * (snowy ? 0.95 : mat === MAT.ROCK ? 0.5 : 0.28);
        c = [c[0] + MOON[0] * k, c[1] + MOON[1] * k, c[2] + MOON[2] * k];
      }

      // --- rim light where a silhouette meets the sky, on top and on the sun's side: a short
      // band that thins out through the dither instead of a hard outline
      let dist = 0;
      for (let k = 1; k <= P.rimReach && !dist; k++) {
        const up = y >= k && mask[i - W * 4 * k] === LAYER.SKY;
        const side = sunLeft ? (x >= k && mask[i - 4 * k] === LAYER.SKY) : (x < W - k && mask[i + 4 * k] === LAYER.SKY);
        if (up || side) dist = k;
      }
      if (dist && d < 1.15 - dist * (P.rimReach > 3 ? 0.25 : 0.33)) {
        const fall = 1 - (dist - 1) * (P.rimReach > 3 ? 0.22 : 0.3);
        if (glow > 0 && P.sunK > 0.2) c = lerpRGB(c, rimColor, clamp(glow * P.sunK * 0.7 * fall * P.rimK, 0, 1));
        else if (moonK > 0.05) c = lerpRGB(c, [200, 215, 245], moonK * 0.5 * fall);
      }
      putPx(data, i, [clamp(c[0], 0, 255), clamp(c[1], 0, 255), clamp(c[2], 0, 255)]);
    }
  }
}
