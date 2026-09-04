import { W, H, HORIZON } from '../state.js';
import { bayer, lerpRGB, mulRGB, scaleRGB, quantRGB, clamp, hex, lerp } from '../util/pixel.js';
import { fbm1D, valueNoise1D, valueNoise2D, hash2, mulberry32 } from '../util/noise.js';

// The backdrop: looking southwest from the University district. Far to near:
// a fictional Lolo Peak, the forested dome of Mount Dean Stone, a low wooded foothill on the
// right, and the grassy south flank of Mount Sentinel sweeping down from the upper left.
// Silhouettes are hand-placed keypoints [x, screenY] plus a little noise.
const LAYERS = [
  { name: 'lolo', material: 'rock', persp: 0.4, snowBias: 0.22, noise: 16, seed: 11,
    points: [[0, 372], [260, 372], [380, 338], [470, 300], [540, 245], [590, 208], [625, 200], [660, 222], [720, 262], [800, 300], [900, 328], [960, 336]] },
  { name: 'deanstone', material: 'forest', persp: 0.22, snowBias: -0.1, noise: 7, seed: 23, crestTrees: true,
    points: [[0, 372], [330, 372], [430, 338], [530, 296], [630, 268], [720, 256], [790, 260], [860, 274], [920, 290], [960, 300]] },
  { name: 'foothill', material: 'forest', persp: 0.1, snowBias: -0.2, noise: 6, seed: 37, crestTrees: true,
    points: [[0, 372], [560, 372], [660, 356], [760, 338], [850, 328], [960, 322]] },
  { name: 'sentinel', material: 'grass', persp: 0.05, snowBias: -0.15, noise: 5, seed: 41,
    points: [[0, 186], [110, 208], [220, 248], [330, 292], [430, 328], [520, 352], [600, 368], [700, 376], [960, 380]] },
];

function ridgeFromPoints(pts, noiseAmp, seed) {
  const f = fbm1D(seed, 3), r = fbm1D(seed + 99, 3);
  const y = new Float32Array(W + 8);
  for (let x = -4; x < W + 4; x++) {
    let i = 0;
    while (i < pts.length - 2 && pts[i + 1][0] < x) i++;
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const t = clamp((x - x0) / (x1 - x0), 0, 1);
    const base = lerp(y0, y1, t * t * (3 - 2 * t));
    const ridged = 1 - Math.abs(r(x * 0.02) * 2 - 1);
    y[x + 4] = base - (f(x * 0.012) - 0.5) * noiseAmp * 2 - ridged * noiseAmp * 0.5;
  }
  return y;
}
const ridges = LAYERS.map((L) => ({ y: ridgeFromPoints(L.points, L.noise, L.seed), snowN: valueNoise1D(L.seed + 7), gully: valueNoise1D(L.seed + 13), patch: valueNoise2D(L.seed + 17) }));
const ridgeY = (i, x) => ridges[i].y[clamp(x + 4, 0, W + 7)];
export const nearRidgeY = (x) => ridgeY(3, x);

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
// Hillside grass: a touch lighter and dustier than the lawn in the foreground.
function hillGrass(month) {
  const [d, l] = grassColors(month);
  return [lerpRGB(d, [150, 130, 90], 0.15), lerpRGB(l, [225, 205, 150], 0.25)];
}

const FOREST_DARK = [30, 56, 40], FOREST_LIT = [78, 112, 62];
const ROCK_DARK = [58, 62, 74], ROCK_LIT = [150, 152, 164];
const SNOW_DARK = [146, 166, 208], SNOW_LIT = [250, 251, 255];

export function renderTerrain(img, env) {
  const data = img.data; data.fill(0);
  const { horizon, ambient } = env.pal;
  const sunSide = env.sun.azimuth < 180 ? 1 : -1;
  const contrast = clamp((env.sun.altitude + 8) / 14, 0.15, 1);
  const fogK = env.cond.fog ? 0.45 : 0;
  const snowAmount = env.snowAmount;
  const [hillDark, hillLit] = hillGrass(env.month);

  for (let li = 0; li < LAYERS.length; li++) {
    const L = LAYERS[li], R = ridges[li];
    const persp = L.persp + fogK * (1 - L.persp);
    const snowCov = clamp(snowAmount + L.snowBias, 0, 1);
    // Snow creeps down from the layer's highest point toward the horizon as coverage grows.
    let top = H; for (let x = 0; x < W; x++) top = Math.min(top, R.y[x + 4]);
    const snowLine = top - 10 + (HORIZON + 24 - top) * Math.pow(snowCov, 1.4) * 1.35;
    const forestLit = L.material === 'forest' ? FOREST_LIT : lerpRGB(FOREST_LIT, [60, 90, 55], 0.3);
    for (let x = 0; x < W; x++) {
      const ry = Math.round(ridgeY(li, x));
      const s = (ridgeY(li, x - 3) - ridgeY(li, x + 3)) / 6; // >0: rising to the right (faces left/east)
      const light = 0.5 + 0.5 * Math.tanh(s * sunSide * 2.3) * contrast;
      const sy = snowLine + (R.snowN(x * 0.045) - 0.5) * 30;
      const steep = Math.abs(s);
      for (let y = Math.max(0, ry); y < HORIZON + 4 && y < H; y++) {
        const d = bayer(x, y);
        const depth = y - ry;
        let mat = L.material;
        if (mat === 'grass') {
          // pines gather in the draws that run down the slope, and along the crest at the left
          const u = x + depth * 0.75;
          const g = R.gully(u * 0.05) + (R.patch(x * 0.06, y * 0.06) - 0.5) * 0.2;
          const thresh = 0.74 - clamp((300 - x) / 300, 0, 1) * 0.12; // more trees toward the left crest
          const crest = depth < 5 + R.gully(x * 0.05 + 40) * 9 && x < 260;
          if (g > thresh || crest || hash2(x, y, li) > 0.996) mat = 'forest';
        } else if (mat === 'forest' && L.name === 'deanstone') {
          // grassy openings on the lower right slopes, like the real thing
          const span = HORIZON + 4 - ry;
          const frac = depth / Math.max(span, 1);
          const edge = 0.5 + (R.patch(x * 0.02, y * 0.05) - 0.5) * 0.5 + clamp((700 - x) / 500, 0, 1) * 0.6;
          if (frac > edge && x > 480 && R.patch(x * 0.04, y * 0.04) > 0.3) mat = 'grass';
        }
        const snowOk = snowCov > 0 && y < sy + (d - 0.5) * 14 && (mat !== 'rock' || steep < 1.05 || hash2(x, y, li) > (steep - 1.05) * 1.2);
        let c;
        if (snowOk && mat !== 'forest') {
          const f = clamp(light + (hash2(x, y, li + 9) - 0.5) * 0.1 + (depth < 2 ? 0.2 : 0), 0, 1);
          c = lerpRGB(SNOW_DARK, SNOW_LIT, f);
        } else if (mat === 'rock') {
          const tex = (hash2(x, y, li + 5) - 0.5) * 0.18;
          const valley = clamp(depth / 150, 0, 1) * 0.3;
          c = lerpRGB(ROCK_DARK, ROCK_LIT, clamp(light + tex + (depth < 2 ? 0.28 : 0) - valley, 0, 1));
        } else if (mat === 'forest') {
          // clumpy canopy: 2px cells so it reads as trees, not static
          const cell = hash2(x >> 1, y >> 1, li + 3);
          const f = clamp(light * 0.8 + (cell - 0.5) * 0.7 + (depth < 2 ? 0.2 : 0), 0, 1);
          c = lerpRGB(FOREST_DARK, forestLit, f);
          if (snowOk && cell > 0.55) c = lerpRGB(c, SNOW_LIT, 0.7); // snow on the canopy
        } else {
          const tex = (hash2(x, y, li + 5) - 0.5) * 0.2 + (R.patch(x * 0.02, y * 0.04) - 0.5) * 0.3;
          c = lerpRGB(hillDark, hillLit, clamp(0.25 + light * 0.6 + tex, 0, 1));
        }
        c = quantRGB(c, 15, d);
        c = lerpRGB(c, horizon, persp);
        putPx(data, x, y, mulRGB(c, ambient));
      }
    }
    if (L.crestTrees) drawTrees(data, li, env, sunSide, contrast, persp);
  }
  renderGround(data, env);
}

function drawTrees(data, li, env, sunSide, contrast, persp) {
  const L = LAYERS[li];
  const rnd = mulberry32(L.seed * 3 + 1);
  const { horizon, ambient } = env.pal;
  const snowy = env.snowAmount + L.snowBias > 0.55;
  let x = 0;
  while (x < W - 3) {
    x += 4 + Math.floor(rnd() * 9);
    const th = 5 + Math.floor(rnd() * 9);
    const wob = 0.8 + rnd() * 0.5;
    const baseY = Math.round(ridgeY(li, x)) + 3;
    if (baseY > HORIZON - 2) continue;
    // only where this layer is actually the visible silhouette
    let hidden = false;
    for (let k = li + 1; k < LAYERS.length; k++) if (ridgeY(k, x) < baseY - th) hidden = true;
    if (hidden) continue;
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
        let c = lerpRGB(FOREST_DARK, FOREST_LIT, clamp(f, 0, 1));
        if (snowy && (tier === 0 || (tier === 1 && hash2(xx, y, 4) > 0.5)) && dx * sunSide >= -1) c = [225, 232, 245];
        c = quantRGB(c, 15, bayer(xx, y));
        c = lerpRGB(c, horizon, persp);
        putPx(data, xx, y, mulRGB(c, ambient));
      }
    }
    for (let t = 0; t < 2; t++) { const y = baseY + t; if (y < H) putPx(data, x, y, mulRGB(lerpRGB([48, 34, 24], horizon, persp), ambient)); }
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
