import { hex, lerpRGB, clamp, lum, scaleRGB } from './util/pixel.js';

// Sky keyframes by sun altitude: [alt, zenith, horizon, ambient light multiplier]
const KEYS = [
  [-18, '#04061a', '#0a0f2e', [0.30, 0.35, 0.60]],
  [-12, '#05082a', '#141a45', [0.32, 0.37, 0.62]],
  [-6,  '#0d1548', '#4a2f5e', [0.44, 0.40, 0.62]],
  [-2,  '#1c2f6e', '#b8563a', [0.66, 0.54, 0.58]],
  [0,   '#2a4488', '#ec8a45', [0.82, 0.66, 0.60]],
  [4,   '#3d6cbd', '#f5bb72', [0.96, 0.85, 0.72]],
  [10,  '#4a80d0', '#b3cfee', [1.00, 0.97, 0.92]],
  [30,  '#3d6fc4', '#86abe0', [1, 1, 1]],
  [90,  '#3566bd', '#84a9de', [1, 1, 1]],
].map(([a, t, h, amb]) => [a, hex(t), hex(h), amb]);

export function skyPalette(alt, cond) {
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1][0] < alt) i++;
  const [a0, t0, h0, m0] = KEYS[i], [a1, t1, h1, m1] = KEYS[i + 1];
  const t = clamp((alt - a0) / (a1 - a0), 0, 1);
  let top = lerpRGB(t0, t1, t), horizon = lerpRGB(h0, h1, t), ambient = lerpRGB(m0, m1, t);

  // Sun disc color: white-hot high up, orange at the horizon.
  const warm = clamp(1 - alt / 14, 0, 1);
  const sunColor = lerpRGB([255, 250, 225], [255, 150, 70], warm);

  // Clouds flatten the sky toward gray and dim the light.
  const cover = cond.cover;
  if (cover > 0) {
    const gt = lum(top), gh = lum(horizon);
    top = lerpRGB(top, [gt * 0.92, gt * 0.93, gt * 0.97], cover * 0.75);
    horizon = lerpRGB(horizon, [gh * 0.9, gh * 0.9, gh * 0.92], cover * 0.7);
    ambient = scaleRGB(ambient, 1 - 0.32 * cover);
  }
  if (cond.precip.intensity > 0) ambient = scaleRGB(ambient, 1 - 0.18 * cond.precip.intensity);
  if (cond.storm) ambient = scaleRGB(ambient, 0.8);
  if (cond.fog) {
    const g = lum(horizon);
    horizon = lerpRGB(horizon, [g * 1.05, g * 1.05, g * 1.08], 0.6);
    top = lerpRGB(top, horizon, 0.6);
    ambient = scaleRGB(ambient, 0.9);
  }

  return { top, horizon, ambient, sunColor };
}
