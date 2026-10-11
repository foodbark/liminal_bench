#!/usr/bin/env python3
"""Writes src/util/bluenoise.js: a 64x64 blue-noise threshold tile (void-and-cluster, Ulichney),
256 levels. Blue noise is what the renderer dithers big soft areas with (sky, cloud sheets, fog,
the terrain's blends): a density becomes an even, random-looking stipple at every level, where an
ordered Bayer matrix locks into a lattice (a checkerboard at half, a dot grid at the thin end)
that crawls when it scrolls. Deterministic (seeded); run once, commit the output."""
import base64, numpy as np
N, SIGMA, SEED = 64, 1.9, 7
rng = np.random.default_rng(SEED)
yy, xx = np.meshgrid(np.arange(N), np.arange(N), indexing='ij')
dx, dy = np.minimum(xx, N - xx), np.minimum(yy, N - yy)
K = np.fft.fft2(np.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA)))
energy = lambda b: np.real(np.fft.ifft2(np.fft.fft2(b) * K))
tightest = lambda b: int(np.argmax(np.where(b == 1, energy(b), -np.inf)))
largest_void = lambda b: int(np.argmin(np.where(b == 0, energy(b), np.inf)))
b = np.zeros((N, N)); b.flat[rng.choice(N * N, N * N // 10, replace=False)] = 1
while True:   # relax the initial pattern until its tightest cluster is also its largest void
    c = tightest(b); b.flat[c] = 0
    v = largest_void(b)
    if v == c: b.flat[c] = 1; break
    b.flat[v] = 1
rank = np.zeros(N * N, int); ones = int(b.sum())
bb = b.copy()
for r in range(ones - 1, -1, -1): c = tightest(bb); bb.flat[c] = 0; rank[c] = r
bb = b.copy()
for r in range(ones, N * N // 2): v = largest_void(bb); bb.flat[v] = 1; rank[v] = r
inv = 1 - bb
for r in range(N * N // 2, N * N): c = tightest(inv); inv.flat[c] = 0; rank[c] = r
levels = (rank * 256 // (N * N)).astype(np.uint8)
assert sorted(set(levels.tolist())) == list(range(256))
js = ("// 64x64 blue-noise threshold tile, 256 levels, from tools/make_bluenoise.py (void-and-cluster).\n"
      "// Worker-safe. See `blue` in pixel.js.\n"
      f"const B64 = '{base64.b64encode(levels.tobytes()).decode()}';\n"
      "export const BLUE64 = Uint8Array.from(atob(B64), (ch) => ch.charCodeAt(0));\n")
open('src/util/bluenoise.js', 'w').write(js)
print('wrote src/util/bluenoise.js', len(js), 'bytes')
