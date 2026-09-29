#!/usr/bin/env python3
"""Does the painting distinguish larch (and other deciduous trees) from fir?

  python3 tools/forest_study.py OUTDIR

Reads assets/backdrop.png and assets/backdrop_mask.png (the current build), takes every FOLIAGE
pixel on Dean Stone (layer RANGE) and in the valley trees (layer TREES), prints hue/value
histograms, and writes overlays that tint the yellow-shifted candidates gold so a person can
judge whether they land on individual trees or on lighting. Reads only; changes nothing.
"""
import os, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
rgb = np.array(Image.open(os.path.join(ROOT, 'assets/backdrop.png')).convert('RGB'))
mask = np.array(Image.open(os.path.join(ROOT, 'assets/backdrop_mask.png')).convert('RGB'))
layer = (mask[..., 0].astype(int) + 16) >> 5; mat = (mask[..., 1].astype(int) + 16) >> 5
H, W = layer.shape
hsv = np.array(Image.fromarray(rgb).convert('HSV')).astype(int)   # H 0..255 (=360deg), S, V
hue = hsv[..., 0] * 360 / 255; sat = hsv[..., 1] / 255; val = hsv[..., 2] / 255

def hist(sel, name):
    h = hue[sel]; v = val[sel]; s = sat[sel]
    print(f'\n{name}: {sel.sum()} px')
    edges = np.arange(30, 181, 10)
    counts, _ = np.histogram(h, edges)
    print('  hue (deg)   ' + ' '.join(f'{e:>4d}' for e in edges[:-1]))
    print('  share (%)   ' + ' '.join(f'{100*c/max(1,len(h)):4.1f}' for c in counts))
    vedges = np.linspace(0, 1, 11)
    vc, _ = np.histogram(v, vedges)
    print('  value       ' + ' '.join(f'{e:4.1f}' for e in vedges[:-1]))
    print('  share (%)   ' + ' '.join(f'{100*c/max(1,len(v)):4.1f}' for c in vc))
    print(f'  hue median {np.median(h):.0f}  sat median {np.median(s):.2f}  val median {np.median(v):.2f}')

for lid, name in ((2, 'Dean Stone (RANGE) foliage'), (5, 'valley trees (TREES) foliage'), (6, 'NEAR shrubs')):
    sel = (layer == lid) & (mat == (6 if lid == 6 else 2))
    if sel.sum(): hist(sel, name)

# candidates: warm greens (hue toward yellow) that are not just dark shadow
forest = (mat == 2) & ((layer == 2) | (layer == 5))
warm = forest & (hue < 75) & (val > 0.25)
bright_warm = forest & (hue < 85) & (val > 0.45) & (sat > 0.3)
print(f'\nwarm candidates (hue<75, val>.25): {warm.sum()} of {forest.sum()} forest px ({100*warm.sum()/max(1,forest.sum()):.1f}%)')
print(f'bright warm (hue<85, val>.45, sat>.3): {bright_warm.sum()} ({100*bright_warm.sum()/max(1,forest.sum()):.1f}%)')
for lid, name in ((2, 'Dean Stone'), (5, 'valley trees')):
    f = forest & (layer == lid)
    print(f'  {name}: warm {100*(warm & f).sum()/max(1,f.sum()):.1f}%  bright warm {100*(bright_warm & f).sum()/max(1,f.sum()):.1f}%')

ov = rgb.copy()
ov[warm] = (ov[warm] * 0.35 + np.array((255, 190, 40)) * 0.65).astype(np.uint8)
ov[bright_warm] = (255, 120, 0)
Image.fromarray(ov).save(os.path.join(out, 'warm_overlay.png'))
# a hue map of the forest only: yellow (hue 40) -> blue-green (hue 160), everything else dimmed
hm = (rgb * 0.25).astype(np.uint8)
t = np.clip((hue - 40) / 120, 0, 1)
col = np.stack([255 * (1 - t), 220 * (1 - t) + 120 * t, 255 * t], -1).astype(np.uint8)
hm[forest] = col[forest]
Image.fromarray(hm).save(os.path.join(out, 'forest_hue.png'))
ys, xs = np.nonzero(layer == 2)
if len(xs):
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    print(f'\nDean Stone bbox x {x0}..{x1} y {y0}..{y1}')
    for nm in ('warm_overlay', 'forest_hue'):
        Image.open(os.path.join(out, nm + '.png')).crop((x0, y0, x1, y1)).save(os.path.join(out, nm + '_deanstone.png'))
    Image.fromarray(rgb).crop((x0, y0, x1, y1)).save(os.path.join(out, 'deanstone_plain.png'))
