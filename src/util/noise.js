export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash2(x, y, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function valueNoise1D(seed) {
  const rnd = mulberry32(seed); const N = 1024; const t = new Float32Array(N);
  for (let i = 0; i < N; i++) t[i] = rnd();
  return (x) => {
    const i = Math.floor(x), f = x - i;
    const a = t[((i % N) + N) % N], b = t[(((i + 1) % N) + N) % N];
    const u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
  };
}
export function fbm1D(seed, oct = 4, lac = 2, gain = 0.5) {
  const layers = [];
  for (let i = 0; i < oct; i++) layers.push(valueNoise1D(seed * 7 + i * 131));
  return (x) => {
    let s = 0, a = 1, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { s += a * layers[i](x * f); norm += a; a *= gain; f *= lac; }
    return s / norm;
  };
}
export function valueNoise2D(seed) {
  const rnd = mulberry32(seed); const N = 64; const t = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) t[i] = rnd();
  const g = (i, j) => t[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = g(xi, yi), b = g(xi + 1, yi), c = g(xi, yi + 1), d = g(xi + 1, yi + 1);
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
  };
}
