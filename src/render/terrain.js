import { W, H, HORIZON } from '../state.js';
import { bayer, lerpRGB, mulRGB, scaleRGB, quantRGB, clamp, hex, lerp } from '../util/pixel.js';
import { fbm1D, valueNoise1D, valueNoise2D, hash2, mulberry32 } from '../util/noise.js';

// Three ridge lines, far to near.
const LAYERS = [
  { base: HORIZON - 14, amp: 165, freq: 0.0032, oct: 4, seed: 11, persp: 0.46, snowBias: 0.08, rock: '#6d7692' },
  { base: HORIZON - 6,  amp: 100, freq: 0.0050, oct: 4, seed: 23, persp: 0.26, snowBias: -0.12, rock: '#5c6a6e' },
  { base: HORIZON + 2,  amp: 58,  freq: 0.0080, oct: 3, seed: 37, persp: 0.09, snowBias: -0.32, rock: '#4f5f4c', trees: true },
];

const ridges = LAYERS.map((L) => {
  const f = fbm1D(L.seed, L.oct), r = fbm1D(L.seed + 99, 3);
  const h = new Float32Array(W + 8);
  for (let x = -4; x < W + 4; x++) {
    const n = f(x * L.freq);
    const rg = 1 - Math.abs(r(x * L.freq * 1.7) * 2 - 1);
    h[x + 4] = L.amp * (0.42 * n + 0.58 * Math.pow(rg, 1.7));
  }
  return { h, snowN: valueNoise1D(L.seed + 7), rock: hex(L.rock) };
});
const ridgeH = (i, x) => ridges[i].h[clamp(x + 4, 0, W + 7)];
export const nearRidgeY = (x) => LAYERS[2].base - ridgeH(2, x);

const groundN = valueNoise2D(77);
const pathN = valueNoise1D(91);

function putPx(data, x, y, c) {
  const i = (y * W + x) * 4;
  data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
}

// Grass tone by month: green spring, greener early summer, tan by August, brown into winter.
function grassColors(month) {
  const K = [
    ['#7a6a3c', '#a89465'], ['#7a6a3c', '#a89465'], ['#6e6b3a', '#9c9560'], ['#4f7a35', '#84a552'],
    ['#3f7f33', '#78ad50'], ['#3a7a30', '#74a84c'], ['#5f7d34', '#9aa653'], ['#7c7a3a', '#b5a660'],
    ['#8a7a3c', '#bda863'], ['#8a6f3a', '#b89a5d'], ['#7a6a3c', '#a89465'], ['#7a6a3c', '#a89465'],
  ];
  return [hex(K[month][0]), hex(K[month][1])];
}

export function renderTerrain(img, env) {
  const data = img.data; data.fill(0);
  const { horizon, ambient } = env.pal;
  const sunSide = env.sun.azimuth < 180 ? 1 : -1;
  const contrast = clamp((env.sun.altitude + 8) / 14, 0.15, 1);
  const fogK = env.cond.fog ? 0.45 : 0;
  const snowAmount = env.snowAmount;

  for (let li = 0; li < LAYERS.length; li++) {
    const L = LAYERS[li], R = ridges[li];
    const persp = L.persp + fogK * (1 - L.persp);
    const snowCov = clamp(snowAmount + L.snowBias, 0, 1);
    const snowLine = L.base - L.amp * (1.08 - snowCov * 1.2);
    const rockDark = scaleRGB(R.rock, 0.5), rockLit = scaleRGB(R.rock, 1.28);
    const snowDark = [146, 166, 208], snowLit = [250, 251, 255];
    for (let x = 0; x < W; x++) {
      const hh = ridgeH(li, x);
      const ry = Math.round(L.base - hh);
      const s = (ridgeH(li, x + 3) - ridgeH(li, x - 3)) / 6;
      const light = 0.5 + 0.5 * Math.tanh(s * sunSide * 2.3) * contrast;
      const sy = snowLine + (R.snowN(x * 0.045) - 0.5) * 30;
      const steep = Math.abs(s);
      for (let y = Math.max(0, ry); y < L.base + 3 && y < H; y++) {
        const d = bayer(x, y);
        const depth = y - ry;
        const isSnow = snowCov > 0 && y < sy + (d - 0.5) * 14 && (steep < 1.05 || hash2(x, y, li) > (steep - 1.05) * 1.2);
        let c;
        if (isSnow) {
          const f = clamp(light + (hash2(x, y, li + 9) - 0.5) * 0.1 + (depth < 2 ? 0.2 : 0), 0, 1);
          c = lerpRGB(snowDark, snowLit, f);
        } else {
          const tex = (hash2(x, y, li + 5) - 0.5) * 0.18;
          const valley = clamp(depth / (L.amp * 0.9), 0, 1) * 0.3; // darker down in the folds
          const f = clamp(light + tex + (depth < 2 ? 0.28 : 0) - valley, 0, 1);
          c = lerpRGB(rockDark, rockLit, f);
        }
        c = quantRGB(c, 15, d);
        c = lerpRGB(c, horizon, persp);
        putPx(data, x, y, mulRGB(c, ambient));
      }
    }
    if (L.trees) drawTrees(data, li, env, sunSide, contrast, persp);
  }
  renderGround(data, env);
}

function drawTrees(data, li, env, sunSide, contrast, persp) {
  const L = LAYERS[li];
  const rnd = mulberry32(L.seed * 3 + 1);
  const { horizon, ambient } = env.pal;
  const dark = [22, 52, 38], lit = [58, 104, 60];
  const snowy = env.snowAmount > 0.55;
  let x = 0;
  while (x < W - 3) {
    x += 4 + Math.floor(rnd() * 9);
    const th = 9 + Math.floor(rnd() * 15);
    const wob = 0.8 + rnd() * 0.5;
    const baseY = Math.round(L.base - ridgeH(li, x)) + 4;
    for (let i = 0; i < th; i++) {
      const y = baseY - th + i;
      if (y < 0 || y >= H) continue;
      const tier = i % 4;
      const hw = Math.max(0, Math.floor(i * 0.36 * wob) - (tier === 0 ? 1 : 0));
      for (let dx = -hw; dx <= hw; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const side = dx * sunSide;
        let f = side < 0 ? 0.25 : 0.7;
        f = 0.5 + (f - 0.5) * contrast + (hash2(xx, y, 3) - 0.5) * 0.2;
        let c = lerpRGB(dark, lit, clamp(f, 0, 1));
        if (snowy && (tier === 0 || (tier === 1 && hash2(xx, y, 4) > 0.5)) && dx * sunSide >= -1) c = [225, 232, 245];
        c = quantRGB(c, 15, bayer(xx, y));
        c = lerpRGB(c, horizon, persp);
        putPx(data, xx, y, mulRGB(c, ambient));
      }
    }
    // trunk
    for (let t = 0; t < 3; t++) { const y = baseY + t; if (y < H) putPx(data, x, y, mulRGB(lerpRGB([48, 34, 24], horizon, persp), ambient)); }
  }
}

function renderGround(data, env) {
  const { horizon, ambient } = env.pal;
  const [gDark, gLight] = grassColors(env.month);
  const snow = env.groundSnow;
  const dirtDark = hex('#6f5637'), dirtLight = hex('#a08462');
  const snowDark = [190, 202, 230], snowLit = [246, 248, 252];
  const packedDark = [176, 184, 205], packedLit = [214, 220, 236];
  const fogK = env.cond.fog ? 0.35 : 0;
  const wet = env.cond.precip.type === 'rain' ? 0.18 : 0;
  for (let y = HORIZON; y < H; y++) {
    const rel = (y - HORIZON) / (H - HORIZON);
    const haze = clamp(1 - (y - HORIZON) / 50, 0, 1) * 0.28 + fogK * (1 - rel * 0.6);
    for (let x = 0; x < W; x++) {
      const d = bayer(x, y);
      const n = groundN(x * 0.022, y * 0.06);
      const py = 486 + Math.sin(x * 0.011) * 9 + (pathN(x * 0.02) - 0.5) * 14;
      const hw = 15 + (pathN(x * 0.05 + 40) - 0.5) * 8;
      const onPath = Math.abs(y - py) < hw + (d - 0.5) * 7;
      const h = hash2(x, y, 21);
      let c;
      if (snow) {
        if (onPath) c = lerpRGB(packedDark, packedLit, clamp(n * 1.2 + (h - 0.5) * 0.25, 0, 1));
        else {
          c = lerpRGB(snowDark, snowLit, clamp(0.35 + n * 0.8 + (h - 0.5) * 0.15, 0, 1));
          if (h > 0.996) c = [120, 100, 70]; // dead grass poking through
        }
      } else if (onPath) {
        c = lerpRGB(dirtDark, dirtLight, clamp(n * 1.1 + (h - 0.5) * 0.35, 0, 1));
        if (h > 0.985) c = scaleRGB(c, 0.75); // pebbles
      } else {
        c = lerpRGB(gDark, gLight, clamp(n * 1.15 + (h - 0.5) * 0.3 - rel * 0.15, 0, 1));
        if (h > 0.982) c = scaleRGB(c, 0.7); // tufts
        else if (h < 0.012) c = scaleRGB(c, 1.2);
      }
      if (wet) c = scaleRGB(c, 1 - wet);
      c = quantRGB(c, 13, d);
      c = lerpRGB(c, horizon, haze);
      putPx(data, x, y, mulRGB(c, ambient));
    }
  }
}
