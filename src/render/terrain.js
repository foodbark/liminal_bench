import { W, H, SEASON_SNOW, SCALE, META } from '../state.js';
import { bayer, lerpRGB, mulRGB, scaleRGB, quantRGB, clamp, hex, lum, smooth } from '../util/pixel.js';
import { valueNoise1D, valueNoise2D, hash2 } from '../util/noise.js';
import { LAYER, MAT } from '../assets.js';

// The scene is a painting (assets/backdrop.png) with a per-pixel layer/material/height mask.
// This pass re-lights it for the moment: seasonal grass, snow creeping down each range, haze and
// fog by depth, then the light itself. Each range has its own horizon so at dawn and dusk the sun
// reaches the peak first (alpenglow) while nearer ranges and the valley sit in blue shadow; the
// moon silvers snow and rock at night; ridgelines and silhouettes against the sky catch a rim of
// light. Sky pixels stay transparent so the procedural sky shows through.

// Per-layer character, far to near. horizon: sun altitude (deg) at which the layer is lit.
const LAYERS = {
  // meltHours: how many hours above freezing it takes a dusting to melt off the whole layer,
  // bottom up; the high forested range (Dean Stone) holds it longest.
  [LAYER.PEAK]:    { depth: 1.0, horizon: -4.0, snowBias: 0.0, hill: true, meltHours: 16 },
  [LAYER.RANGE]:   { depth: 0.75, horizon: -2.6, snowBias: -0.05, hill: true, meltHours: 9.5 },
  [LAYER.FARHILL]: { depth: 0.5, horizon: -2.4, snowBias: -0.12, hill: true, meltHours: 5 },
  [LAYER.FLANK]:   { depth: 0.3, horizon: -4.2, snowBias: -0.15, hill: true, backlitAM: true, meltHours: 6.5 },   // Mount Sentinel: sunset glow on the face; at dawn the sun is behind it
  [LAYER.TREES]:   { depth: 0.22, horizon: 0.0, snowBias: -0.1, hill: true, meltHours: 4.5 },
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
const invN = valueNoise1D(31);
const fogN = valueNoise2D(43), fogN2 = valueNoise2D(47);
// The inversion's flat top (screen y) and how far below it the fog is solid.
const INVERSION_TOP = META.inversionTop, INVERSION_BAND = Math.round(22 * SCALE);
const [INV_X0, INV_X1] = META.inversionReachX, [BANK_X0, BANK_X1] = META.bankReachX;

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
  const { rgb, mask, ridge } = assets;
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
  // Fog colors: pale and bright by day, taking the glow at dawn and dusk, dim at night.
  const inversion = env.inversion || 0, mountainFog = env.mountainFog || 0;
  const fogBase = lerpRGB(lerpRGB([208, 216, 228], horizon, 0.22), scaleRGB(glowRGB, 0.9), glow * 0.55);
  const fogCol = mulRGB(fogBase, lerpRGB(ambient, [1, 1, 1], 0.25));
  const fogLit = mulRGB(lerpRGB([246, 248, 252], glowRGB, glow * 0.5), lerpRGB(ambient, [1, 1, 1], 0.4));
  const bankCol = mulRGB(lerpRGB(lerpRGB([204, 212, 224], horizon, 0.4), scaleRGB(glowRGB, 0.9), glow * 0.4), lerpRGB(ambient, [1, 1, 1], 0.2));
  const per = {};
  for (const id in LAYERS) {
    const L = LAYERS[id];
    const cov = clamp(extraSnow + L.snowBias, 0, 1);
    const sunK = smooth(clamp((alt - (L.horizon - 1.2)) / 2.4, 0, 1));
    const dust = env.dusting || { amount: 0, thaw: 0 };
    const meltLine = L.meltHours ? clamp(dust.thaw / L.meltHours, 0, 1) : 1;   // height fraction below which it has melted
    const backlit = !!L.backlitAM && env.sun.azimuth < 180;   // morning sun behind this ridge
    per[id] = {
      snowThresh: cov > 0 ? 1 - Math.min(1, Math.pow(cov, 1.4) * 1.35) : 2,
      sunK,
      faceK: backlit ? 0 : sunK,        // no glow on a face the sun is behind
      rimK: backlit ? 1.8 : 1,          // but its outline burns
      rimReach: Math.round((backlit ? 4 : 3) * SCALE),
      persp: L.depth * 0.08,
      dustLine: dust.amount > 0 && meltLine < 1 ? meltLine : 2,
      dustK: dust.amount * (0.55 + 0.3 * (1 - meltLine)),   // thins as it melts
    };
  }

  for (let y = 0; y < H; y++) {
    const nearHaze = clamp(1 - (y - META.nearHazeY) / (50 * SCALE), 0, 1) * 0.2;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const layer = mask[i];
      const d = bayer(x, y);
      if (layer === LAYER.SKY) {
        // mountain fog spills over the crest: stippled cloud in the sky just above the ridge
        if (mountainFog > 0) {
          const above = ridge[x] - y;
          if (above > 0 && above < 44 * SCALE) {
            const w = smooth(clamp(1 - above / (44 * SCALE), 0, 1));
            const n = fogN(x * 0.005 / SCALE, y * 0.06 / SCALE) * 0.75 + fogN2(x * 0.02 / SCALE, y * 0.12 / SCALE) * 0.25;
            const dens = clamp((n - (0.9 - mountainFog * 0.45)) / 0.32, 0, 1) * w;
            if (d < dens) putPx(data, i, quantRGB(bankCol, 9, d));
          }
        }
        continue;
      }
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
          const thresh = P.snowThresh + (snowN(x * 0.045 / SCALE) - 0.5) * 0.12 + (d - 0.5) * 0.06;
          if (e > thresh) {
            if (mat === MAT.FOLIAGE) {
              if (lum(c) > 60 && hash2(x >> 1, y >> 1, 3) > 0.45) { c = lerpRGB(c, SNOW_LIT, 0.6); snowy = true; }
            } else { c = lerpRGB(SNOW_DARK, SNOW_LIT, clamp(lum(c) / 200, 0, 1)); snowy = true; }
          } else if (e > P.dustLine + (snowN(x * 0.07 / SCALE + 9) - 0.5) * 0.14 + (d - 0.5) * 0.08) {
            // last night's dusting: thin, grass and rock still showing through
            if (mat === MAT.FOLIAGE) {
              if (lum(c) > 60 && hash2(x >> 1, y >> 1, 3) > 0.5) { c = lerpRGB(c, SNOW_LIT, 0.45 * P.dustK); snowy = true; }
            } else { c = lerpRGB(c, lerpRGB(SNOW_DARK, SNOW_LIT, clamp(lum(c) / 200, 0, 1)), P.dustK); snowy = true; }
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

      // --- inversion: a sea of fog fills the far valley behind the trees, flat-topped, lit on top
      if (inversion > 0 && (layer === LAYER.PEAK || layer === LAYER.RANGE || layer === LAYER.FARHILL || layer === LAYER.FLANK)) {
        const reach = layer === LAYER.FLANK ? clamp((x - INV_X0) / INV_X1, 0, 1) : 1;
        const yTop = INVERSION_TOP + (invN(x * 0.02 / SCALE) - 0.5) * 8 * SCALE;
        const below = y - yTop;
        if (below > -1 && reach > 0) {
          const dens = clamp(below / INVERSION_BAND, 0, 1) * 0.95 * inversion * reach;
          c = lerpRGB(c, fogCol, dens);
          if (below < 6 * SCALE && d < 1.1 - below / (5 * SCALE)) c = lerpRGB(c, fogLit, 0.8 * inversion * reach);
          c = quantRGB(c, 9, d);
        }
      }
      // --- mountain fog: ragged banks hanging mid-slope on the ranges
      if (mountainFog > 0 && layer !== LAYER.NEAR && layer !== LAYER.TREES && !isProp) {
        // banks hang from the crest down to mid-slope, stretched along the slope, stippled
        const lo = layer === LAYER.PEAK ? 0.2 : layer === LAYER.RANGE ? 0.3 : 0.35;
        let w = smooth(clamp((e - lo) / 0.2, 0, 1));
        if (layer === LAYER.FLANK) w *= 0.6 * clamp((x - BANK_X0) / BANK_X1, 0, 1);   // Sentinel's near end is too close for banks
        if (w > 0) {
          const n = fogN(x * 0.005 / SCALE, y * 0.06 / SCALE) * 0.75 + fogN2(x * 0.02 / SCALE, y * 0.12 / SCALE) * 0.25;
          const dens = clamp((n - (0.9 - mountainFog * 0.45)) / 0.32, 0, 1) * w;
          if (d < dens) c = lerpRGB(c, bankCol, 0.9);
        }
      }

      // --- rim light where a silhouette meets the sky, on top and on the sun's side: a short
      // band that thins out through the dither instead of a hard outline
      let dist = 0;
      for (let k = 1; k <= P.rimReach && !dist; k++) {
        const up = y >= k && mask[i - W * 4 * k] === LAYER.SKY;
        const side = sunLeft ? (x >= k && mask[i - 4 * k] === LAYER.SKY) : (x < W - k && mask[i + 4 * k] === LAYER.SKY);
        if (up || side) dist = k;
      }
      if (dist && d < 1.15 - (dist / SCALE) * (P.rimReach > 3 * SCALE ? 0.25 : 0.33)) {
        const fall = 1 - ((dist - 1) / SCALE) * (P.rimReach > 3 * SCALE ? 0.22 : 0.3);
        if (glow > 0 && P.sunK > 0.2) c = lerpRGB(c, rimColor, clamp(glow * P.sunK * 0.7 * fall * P.rimK, 0, 1));
        else if (moonK > 0.05) c = lerpRGB(c, [200, 215, 245], moonK * 0.5 * fall);
      }
      putPx(data, i, [clamp(c[0], 0, 255), clamp(c[1], 0, 255), clamp(c[2], 0, 255)]);
    }
  }
}
