#!/usr/bin/env python3
"""Put a photographed Mount Sentinel into the front painting in place of the painted one.

  python3 tools/swap_flank.py CUTOUT --scale S --dy DY [--out art/mount_sentinel_photo_front.png]
                              [--front art/mount_sentinel_alone_transparent_sky.jpg] [--xmax 1180]
                              [--shave 2] [--gain 0.74] [--pop 1.15] [--keep-key]

A bridging step while the scene is part photo, part painting: the painted front (Sentinel, the
valley trees, the meadow, the far field) keeps its trees and meadow, and its Sentinel flank is
replaced by the photo. The photo is a cut-out of the face on a flat background: a real alpha
PNG, or a flattened checker/gray background that is keyed here by color (the face is tan and
green, the background neutral). The keyed edge is shaved by --shave pixels, because a cut-out
carries a halo of pale sky along its tree tops that the pixelation would bake into bright caps.
The pixelated cut-out is graded by --gain (an exposure match, applied after the pixelation since pixelate's pop would undo it before: the 2026-10-08 photo's grass was 40% brighter
than the painted face it replaces and went to peach under the alpenglow; 0.74 matches their mean
luminance) and pixelated as a mountain (tools/pixelate.py, with --pop) at --scale times its size and
laid at (0, --dy) in scene pixels; the painted flank pixels left of --xmax are replaced where the
photo covers them and cleared where it does not (the back painting shows there), and the
painted crest pines above y 650 go with the flank. Nothing is drawn: every pixel is the photo's
or the painting's. The fit (--scale, --dy) was searched for the 2026-10-08 cut-out so the photo's
skyline sits just above the painted one and its torn bottom edge stays under the trees.

Needs the current build's mask (assets/backdrop_mask.png) for the painted layers.
"""
import argparse, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from build_backdrop import key_checker, majority   # noqa: E402


def key_by_color(rgb):
    """Alpha for a cut-out on a neutral light background: keep what is colored or dark."""
    r, g, b = [rgb[..., i].astype(int) for i in range(3)]
    mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    keep = majority(~(((mx - mn) < 16) & (lum > 140)), 3)
    # only the biggest connected piece: specks of background texture go
    from collections import deque
    H, W = keep.shape; lab = np.zeros((H, W), int); n = 0; sizes = {}
    for y0 in range(0, H, 4):
        for x0 in range(0, W, 4):
            if keep[y0, x0] and not lab[y0, x0]:
                n += 1; q = deque([(y0, x0)]); lab[y0, x0] = n; c = 0
                while q:
                    y, x = q.popleft(); c += 1
                    for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                        if 0 <= yy < H and 0 <= xx < W and keep[yy, xx] and not lab[yy, xx]: lab[yy, xx] = n; q.append((yy, xx))
                sizes[n] = c
    return lab == max(sizes, key=sizes.get)


def erode(a, k):
    for _ in range(k):
        p = np.pad(a, 1)
        a = a & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    return a


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('cutout'); ap.add_argument('--scale', type=float, required=True); ap.add_argument('--dy', type=int, required=True)
    ap.add_argument('--out', default='art/mount_sentinel_photo_front.png')
    ap.add_argument('--front', default='art/mount_sentinel_alone_transparent_sky.jpg')
    ap.add_argument('--xmax', type=int, default=1180); ap.add_argument('--shave', type=int, default=2)
    ap.add_argument('--gain', type=float, default=0.74); ap.add_argument('--pop', type=float, default=1.15)
    ap.add_argument('--keep-key', action='store_true', help='the cut-out already has a clean alpha; do not re-key it')
    a = ap.parse_args()

    im = Image.open(os.path.join(ROOT, a.cutout)).convert('RGBA')
    rgb = np.asarray(im)[..., :3]
    alpha = np.asarray(im)[..., 3] > 128 if a.keep_key else key_by_color(rgb)
    alpha = erode(alpha, a.shave)
    keyed = np.dstack([rgb, np.where(alpha, 255, 0).astype(np.uint8)])
    tmp = tempfile.mkdtemp()
    kp = os.path.join(tmp, 'keyed.png'); Image.fromarray(keyed, 'RGBA').save(kp)
    width = int(round(im.width * a.scale / 4)) * 4
    pp = os.path.join(tmp, 'pix.png')
    subprocess.run([sys.executable, os.path.join(ROOT, 'tools/pixelate.py'), kp, pp, '--as', 'mountain', '--width', str(width), '--pop', str(a.pop)], check=True)
    pix = np.asarray(Image.open(pp).convert('RGBA')).copy()
    # the exposure grade goes after the pixelation: pixelate's pop stretches lightness to the full
    # range by design (it wants plain daylight), so a grade before it would simply be undone
    pix[..., :3] = np.clip(pix[..., :3].astype(float) * a.gain, 0, 255).astype(np.uint8)

    old = Image.open(os.path.join(ROOT, a.front)).convert('RGB')
    W, H = old.size
    front = np.dstack([np.asarray(old), np.where(key_checker(old), 255, 0).astype(np.uint8)]).copy()
    layer = np.array(Image.open(os.path.join(ROOT, 'assets/backdrop_mask.png')))[..., 0]
    ph, pw = pix.shape[:2]
    new = np.zeros((H, W, 4), np.uint8)
    y0, y1 = a.dy, min(H, a.dy + ph); new[y0:y1, :min(W, pw)] = pix[:y1 - y0, :min(W, pw)]
    pa = new[..., 3] > 0
    yy = np.arange(H)[:, None]; xx = np.arange(W)[None, :]
    region = xx < a.xmax
    crestpines = (layer == 160) & (yy < 650) & region
    replaceable = ((layer == 128) | (layer == 0) | crestpines) & region
    front[pa & replaceable] = new[pa & replaceable]
    gone = (~pa) & ((layer == 128) | crestpines) & region
    front[gone, 3] = 0
    Image.fromarray(front, 'RGBA').save(os.path.join(ROOT, a.out), optimize=True)
    print(f'{a.out}: photo over {int((pa & replaceable).sum())} px, painted flank cleared on {int(gone.sum())} px')


if __name__ == '__main__':
    main()
