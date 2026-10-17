#!/usr/bin/env python3
"""Cut one cloud out of a photograph of the sky, for tools/pixelate.py to turn into a sprite.
  python3 tools/cut_cloud.py PHOTO OUT.png [--box fx0,fy0,fx1,fy1] [--cloud C] [--sky S] [--pad N]
No drawing: the sky is keyed out by how blue it is against the cloud (a cloud is white to gray,
near-neutral; the sky's blue stands far above its red), the largest connected cloud inside
--box (fractions of the frame; default the whole frame) is kept, and the result is an RGBA
cut-out at the photo's own pixels with a soft alpha where the cloud thins into the sky, so a
translucent edge averages down into the cloud rather than snapping to a hard line.
  --cloud C   blueness ((b - r) / b) at and below which a pixel is wholly cloud (default 0.28)
  --sky S     blueness at and above which it is wholly sky (default: measured as the 90th
              percentile inside the box, less a margin; a thin veil over the sky sits between)
  --pad N     pixels of margin kept around the cloud's bounding box (default 8)
  --clip      the box also cuts. Cumulus join at their bases, and without this the whole joined
              mass comes along; with it the cut runs straight along the box edge, so put that
              edge where the join is narrow or in the gray of the base
"""
import argparse, sys
import numpy as np
from PIL import Image, ImageOps


def label_largest(mask, prefer=None):
    """The 4-connected component of a boolean mask with the most pixels inside `prefer` (or the
    largest), by flood fill on a coarse grid when scipy is not there (the selection only needs
    to be right to within a few pixels)."""
    if prefer is None: prefer = np.ones_like(mask)
    try:
        from scipy import ndimage
        lab, n = ndimage.label(mask)
        if n == 0: return None
        sizes = np.bincount(lab.ravel(), weights=prefer.ravel()); sizes[0] = 0
        return lab == sizes.argmax()
    except ImportError:
        pass
    H, W = mask.shape
    s = 4
    small = mask[:H // s * s, :W // s * s].reshape(H // s, s, W // s, s).mean((1, 3)) > 0.5
    psmall = prefer[:H // s * s, :W // s * s].reshape(H // s, s, W // s, s).mean((1, 3)) > 0.5
    seen = np.zeros_like(small); best = None; bestScore = -1
    for sy, sx in zip(*np.nonzero(small)):
        if seen[sy, sx]: continue
        stack = [(sy, sx)]; comp = []; seen[sy, sx] = True
        while stack:
            y, x = stack.pop(); comp.append((y, x))
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < small.shape[0] and 0 <= nx < small.shape[1] and small[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True; stack.append((ny, nx))
        score = sum(1 for y, x in comp if psmall[y, x])
        if score > bestScore: best, bestScore = comp, score
    if not best: return None
    keep = np.zeros_like(small)
    for y, x in best: keep[y, x] = True
    full = np.zeros_like(mask)
    full[:small.shape[0] * s, :small.shape[1] * s] = keep.repeat(s, 0).repeat(s, 1)
    return full & mask


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('photo'); ap.add_argument('out')
    ap.add_argument('--box', default='0,0,1,1')
    ap.add_argument('--cloud', type=float, default=0.28)
    ap.add_argument('--sky', type=float)
    ap.add_argument('--pad', type=int, default=8)
    ap.add_argument('--clip', action='store_true', help='the box also cuts: for a cloud joined to its neighbors, which otherwise come with it')
    a = ap.parse_args()
    im = ImageOps.exif_transpose(Image.open(a.photo)).convert('RGB')
    W, H = im.size
    fx0, fy0, fx1, fy1 = (float(v) for v in a.box.split(','))
    x0, y0, x1, y1 = int(fx0 * W), int(fy0 * H), int(fx1 * W), int(fy1 * H)
    px = np.asarray(im, np.float64)
    r, b = px[..., 0], px[..., 2]
    blueness = (b - r) / np.maximum(b, 1)
    sky = a.sky if a.sky is not None else float(np.percentile(blueness[y0:y1, x0:x1], 90)) - 0.14
    if sky <= a.cloud + 0.05: sys.exit(f'no blue sky to key against in the box (sky blueness {sky:.2f}, cloud {a.cloud:.2f}): '
                                       'the sky near the horizon is as pale as a cloud base, so this key only works for clouds against blue')
    alpha = ((sky - blueness) / (sky - a.cloud)).clip(0, 1)
    # the box picks the cloud (the one with the most core inside it) and never clips it: the
    # whole frame is keyed, so a cloud that runs past the box edge keeps its far side
    inbox = np.zeros(alpha.shape, bool); inbox[y0:y1, x0:x1] = True
    if a.clip: alpha[~inbox] = 0
    core = label_largest((alpha >= 0.6), prefer=inbox)
    if core is None: sys.exit('no cloud found in the box')
    # the soft edge belongs to the chosen cloud only where it touches that cloud's core
    try:
        from scipy import ndimage
        near = ndimage.binary_dilation(core, iterations=a.pad)
    except ImportError:
        near = core.copy()
        for _ in range(a.pad):
            n2 = near.copy(); n2[1:] |= near[:-1]; n2[:-1] |= near[1:]; n2[:, 1:] |= near[:, :-1]; n2[:, :-1] |= near[:, 1:]; near = n2
    alpha = np.where(near, alpha, 0)
    # despill: a translucent edge pixel is cloud over sky, so take the sky's share back out
    # (color = cloud * a + sky * (1 - a)), or every edge averages down to a dark blue rim
    # The sky darkens toward the top of a frame, so its color is taken row by row (the median
    # of that row's sky pixels, rows without sky filled from their neighbors, then smoothed);
    # one color for the whole frame over-subtracted at the top and left black edges.
    issky = blueness >= sky
    rows = np.array([np.median(px[y][issky[y]], 0) if issky[y].sum() > 20 else [np.nan] * 3 for y in range(px.shape[0])])
    for i in range(3):
        col = rows[:, i]; ok = ~np.isnan(col)
        if not ok.any(): col[:] = (80., 120., 180.)[i]
        else: col[~ok] = np.interp(np.nonzero(~ok)[0], np.nonzero(ok)[0], col[ok])
        k = 31; rows[:, i] = np.convolve(np.pad(col, k // 2, mode='edge'), np.ones(k) / k, mode='valid')
    skycol = rows[:, None, :]
    a3 = alpha[..., None]
    # only where the pixel is mostly cloud; thinner fringe keeps its mixed color and the
    # premultiplied average in the pixelate step weighs it by its alpha
    px = np.where(a3 >= 0.25, (px - skycol * (1 - a3)) / np.maximum(a3, 0.25), px).clip(0, 255)
    # Where the cloud runs into a cut (a clipped box edge, or the photo's own frame) the edge is
    # a straight line. Over a band inside it the cloud is trimmed from the cut inward, each row
    # or column eaten back until the first pixel lit enough for that depth: the lit lobes reach
    # nearest the cut, the shaded base recedes, so the cut follows the photo's structure instead
    # of a ruler, and nothing inside the cloud is touched. A mask on the photo's pixels, nothing drawn.
    cy, cx = np.nonzero(core)
    cw, ch = cx.max() - cx.min() + 1, cy.max() - cy.min() + 1
    lum = px.mean(2); lo_l, hi_l = np.percentile(lum[core], [5, 95])
    ln = ((lum - lo_l) / max(hi_l - lo_l, 1)).clip(0, 1)
    edges = []   # (axis, position, direction into the cloud)
    for pos, axis, d, size in ((x0 if a.clip else 0, 1, 1, cw), ((x1 if a.clip else px.shape[1]) - 1, 1, -1, cw), (y0 if a.clip else 0, 0, 1, ch), ((y1 if a.clip else px.shape[0]) - 1, 0, -1, ch)):
        coord = cx if axis == 1 else cy
        if np.abs(coord - pos).min() <= 2: edges.append((axis, pos, d, max(60, int(size * 0.12))))
    for axis, pos, d, B in edges:
        idx = np.arange(px.shape[1] if axis == 1 else px.shape[0])
        dist = ((idx - pos) * d).clip(0, B) / B          # 0 at the cut, 1 a band's width in
        dist = dist[None, :] if axis == 1 else dist[:, None]
        lit = ln >= (1 - dist)                           # lit enough to stand at this depth
        if d < 0: lit = np.flip(lit, axis=1 - axis)     # accumulate from the cut inward
        keep = np.maximum.accumulate(lit, axis=1 - axis)
        if d < 0: keep = np.flip(keep, axis=1 - axis)
        alpha = alpha * keep
    ys, xs = np.nonzero(alpha > 0)
    by0, by1 = max(ys.min() - a.pad, 0), min(ys.max() + a.pad + 1, alpha.shape[0])
    bx0, bx1 = max(xs.min() - a.pad, 0), min(xs.max() + a.pad + 1, alpha.shape[1])
    out = np.zeros((by1 - by0, bx1 - bx0, 4), np.uint8)
    out[..., :3] = px[by0:by1, bx0:bx1].astype(np.uint8)
    out[..., 3] = (alpha[by0:by1, bx0:bx1] * 255 + 0.5).astype(np.uint8)
    Image.fromarray(out).save(a.out)
    print(f'{a.photo} -> {a.out}: cloud {bx1 - bx0}x{by1 - by0} px at ({bx0},{by0}) in the photo, sky blueness {sky:.2f}, {int(core.sum())} core pixels')


if __name__ == '__main__':
    main()
