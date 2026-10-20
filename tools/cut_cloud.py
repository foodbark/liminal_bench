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
  --open N    wisps and fingers thinner than 2N photo pixels are dropped (default 48, less on a
              small cloud; 0 keeps them)
  --list      no cut: print the separate clouds the key finds in the box, largest first, with
              the box fractions to pass back in, for filling the config's clouds list
  --all       keep every cloud in the box (a cluster, or one cloud the key sees as two pieces)
              instead of the single one with the most core inside it
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


def components(mask, y0, y1, x0, x1):
    """Every 4-connected component of the mask inside the box, on a coarse grid: (pixels, x0, y0, x1, y1), largest first."""
    s = 4
    sub = mask[y0:y1, x0:x1]
    small = sub[:sub.shape[0] // s * s, :sub.shape[1] // s * s].reshape(sub.shape[0] // s, s, sub.shape[1] // s, s).mean((1, 3)) > 0.5
    seen = np.zeros_like(small); out = []
    for sy, sx in zip(*np.nonzero(small)):
        if seen[sy, sx]: continue
        stack = [(sy, sx)]; seen[sy, sx] = True; comp = []
        while stack:
            y, x = stack.pop(); comp.append((y, x))
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < small.shape[0] and 0 <= nx < small.shape[1] and small[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True; stack.append((ny, nx))
        ys = [p[0] for p in comp]; xs = [p[1] for p in comp]
        out.append((len(comp) * s * s, x0 + min(xs) * s, y0 + min(ys) * s, x0 + (max(xs) + 1) * s, y0 + (max(ys) + 1) * s))
    out.sort(reverse=True)
    return out


def seam_cut(alpha, ln, axis, pos, d, B):
    """Move a straight cut at `pos` (a column if axis == 1, a row if 0; d the direction into the
    cloud) onto the darkest seam through the band of width B inside it, and clear what lies
    between the cut and the seam."""
    a = alpha if axis == 1 else alpha.T
    L = ln if axis == 1 else ln.T
    H, W = a.shape
    lo, hi = (pos, min(W, pos + B)) if d > 0 else (max(0, pos - B + 1), pos + 1)
    band = L[:, lo:hi]; cover = a[:, lo:hi] > 0.3
    if band.shape[1] < 3 or not cover.any(): return alpha
    # cost: the lightness where there is cloud, and more so the crease (how much darker a pixel is
    # than its surroundings, so a seam finds the folds between lobes even where the whole band
    # is bright), a middle value over sky, and a slight lean toward the cut so an even field is
    # cut near its edge rather than deep in
    n = band.shape[1]
    k = 25
    pad = np.pad(band, k // 2, mode='edge')
    c = np.cumsum(np.cumsum(pad, 0), 1); c = np.pad(c, ((1, 0), (1, 0)))
    H2, W2 = band.shape
    local = (c[k:k + H2, k:k + W2] - c[:H2, k:k + W2] - c[k:k + H2, :W2] + c[:H2, :W2]) / (k * k)
    crease = (band - local) * 3
    lean = (np.arange(n) if d > 0 else np.arange(n)[::-1]) / max(n - 1, 1) * 0.08
    cost = np.where(cover, band * 0.6 + crease, 0.45) + lean[None, :]
    cum = cost.copy()
    for y in range(1, H):
        prev = cum[y - 1]
        best = np.minimum(np.minimum(np.pad(prev[:-1], (1, 0), constant_values=np.inf), prev), np.pad(prev[1:], (0, 1), constant_values=np.inf))
        cum[y] = cost[y] + best
    seam = np.empty(H, int); seam[-1] = int(np.argmin(cum[-1]))
    for y in range(H - 2, -1, -1):
        x = seam[y + 1]; x0 = max(0, x - 1); seam[y] = x0 + int(np.argmin(cum[y, x0:x + 2]))
    cols = np.arange(n)[None, :]
    outside = cols < seam[:, None] if d > 0 else cols > seam[:, None]
    a = a.copy(); a[:, lo:hi] = np.where(outside, 0, a[:, lo:hi])
    return a if axis == 1 else a.T


def opened(mask, radius):
    """Morphological opening (erode then dilate by radius, on a coarse grid): drops fingers and
    wisps thinner than twice the radius, keeps every lobe. The element alternates the 4- and
    8-neighborhoods so it is an octagon, near a disc; a plain 4-neighborhood element is a
    diamond, and a wisp eroded to a point grew back as a diamond on the bench. Done on the
    photo's own mask."""
    s = 4; r = max(1, radius // s)
    H, W = mask.shape
    small = mask[:H // s * s, :W // s * s].reshape(H // s, s, W // s, s).mean((1, 3)) > 0.5
    def grow(m, keep):
        out = m.copy()
        for i in range(r):
            n = out.copy()
            n[1:] = keep(n[1:], out[:-1]); n[:-1] = keep(n[:-1], out[1:]); n[:, 1:] = keep(n[:, 1:], out[:, :-1]); n[:, :-1] = keep(n[:, :-1], out[:, 1:])
            if i % 2:   # the diagonals every other step
                n[1:, 1:] = keep(n[1:, 1:], out[:-1, :-1]); n[:-1, :-1] = keep(n[:-1, :-1], out[1:, 1:])
                n[1:, :-1] = keep(n[1:, :-1], out[:-1, 1:]); n[:-1, 1:] = keep(n[:-1, 1:], out[1:, :-1])
            out = n
        return out
    o = grow(grow(small, np.logical_and), np.logical_or)
    full = np.zeros_like(mask); full[:o.shape[0] * s, :o.shape[1] * s] = o.repeat(s, 0).repeat(s, 1)
    return mask & full


def key_sky(px, x0, y0, x1, y1, cloud=0.28, sky=None):
    """Alpha (1 cloud, 0 sky) for the whole frame from how blue each pixel is against the cloud,
    the sky's blueness measured inside the box when not given. Returns (alpha, blueness, sky)."""
    r, b = px[..., 0], px[..., 2]
    blueness = (b - r) / np.maximum(b, 1)
    if sky is None: sky = float(np.percentile(blueness[y0:y1, x0:x1], 90)) - 0.14
    if sky <= cloud + 0.05: sys.exit(f'no blue sky to key against in the box (sky blueness {sky:.2f}, cloud {cloud:.2f}): '
                                     'the sky near the horizon is as pale as a cloud base, so this key only works for clouds against blue')
    return ((sky - blueness) / (sky - cloud)).clip(0, 1), blueness, sky


def despill(px, alpha, blueness, sky):
    """A translucent edge pixel is cloud over sky, so take the sky's share back out (color =
    cloud * a + sky * (1 - a)), or every edge averages down to a dark blue rim. The sky darkens
    toward the top of a frame, so its color is taken row by row (the median of that row's sky
    pixels, rows without sky filled from their neighbors, then smoothed); one color for the
    whole frame over-subtracted at the top and left black edges. Only where the pixel is mostly
    cloud; thinner fringe keeps its mixed color and the premultiplied average in the pixelate
    step weighs it by its alpha."""
    issky = blueness >= sky
    rows = np.array([np.median(px[y][issky[y]], 0) if issky[y].sum() > 20 else [np.nan] * 3 for y in range(px.shape[0])])
    for i in range(3):
        col = rows[:, i]; ok = ~np.isnan(col)
        if not ok.any(): col[:] = (80., 120., 180.)[i]
        else: col[~ok] = np.interp(np.nonzero(~ok)[0], np.nonzero(ok)[0], col[ok])
        k = 31; rows[:, i] = np.convolve(np.pad(col, k // 2, mode='edge'), np.ones(k) / k, mode='valid')
    skycol = rows[:, None, :]
    a3 = alpha[..., None]
    return np.where(a3 >= 0.25, (px - skycol * (1 - a3)) / np.maximum(a3, 0.25), px).clip(0, 255)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('photo'); ap.add_argument('out')
    ap.add_argument('--box', default='0,0,1,1')
    ap.add_argument('--cloud', type=float, default=0.28)
    ap.add_argument('--sky', type=float)
    ap.add_argument('--pad', type=int, default=8)
    ap.add_argument('--open', type=int, default=48, help='drop wisps and fingers thinner than twice this many photo pixels (0 keeps them)')
    ap.add_argument('--clip', action='store_true', help='the box also cuts: for a cloud joined to its neighbors, which otherwise come with it')
    ap.add_argument('--list', action='store_true', help='list the separate clouds in the box with their boxes, and cut nothing')
    ap.add_argument('--all', action='store_true', help='keep every cloud in the box, not just the one with the most core in it: for a cluster, or a cloud in two pieces')
    a = ap.parse_args()
    im = ImageOps.exif_transpose(Image.open(a.photo)).convert('RGB')
    W, H = im.size
    fx0, fy0, fx1, fy1 = (float(v) for v in a.box.split(','))
    x0, y0, x1, y1 = int(fx0 * W), int(fy0 * H), int(fx1 * W), int(fy1 * H)
    px = np.asarray(im, np.float64)
    alpha, blueness, sky = key_sky(px, x0, y0, x1, y1, a.cloud, a.sky)
    if a.list:
        for n, bx0, by0, bx1, by1 in components(alpha >= 0.6, y0, y1, x0, x1)[:30]:
            print(f'{n:8d} px  {bx1 - bx0}x{by1 - by0}  box [{bx0 / W:.3f}, {by0 / H:.3f}, {bx1 / W:.3f}, {by1 / H:.3f}]')
        return
    # the box picks the cloud (the one with the most core inside it) and never clips it: the
    # whole frame is keyed, so a cloud that runs past the box edge keeps its far side
    inbox = np.zeros(alpha.shape, bool); inbox[y0:y1, x0:x1] = True
    if a.clip: alpha[~inbox] = 0
    core = ((alpha >= 0.6) & inbox) if a.all else label_largest((alpha >= 0.6), prefer=inbox)
    if core is None or not core.any(): sys.exit('no cloud found in the box')
    if a.open > 0:   # a thin wisp off a lobe read as a finger on the bench (the user, 2026-10-17); the radius scales with the cloud, so a small puff is not eroded away
        cy, cx = np.nonzero(core)
        core = opened(core, int(min(a.open, max(6, min(cx.max() - cx.min(), cy.max() - cy.min()) * 0.05))))
        if not a.all: core = label_largest(core, prefer=inbox)   # the opening can leave crumbs where a wisp was
    # the soft edge belongs to the chosen cloud only where it touches that cloud's core
    try:
        from scipy import ndimage
        near = ndimage.binary_dilation(core, iterations=a.pad)
    except ImportError:
        near = core.copy()
        for _ in range(a.pad):
            n2 = near.copy(); n2[1:] |= near[:-1]; n2[:-1] |= near[1:]; n2[:, 1:] |= near[:, :-1]; n2[:, :-1] |= near[:, 1:]; near = n2
    alpha = np.where(near, alpha, 0)
    px = despill(px, alpha, blueness, sky)
    # Where the cloud runs into a cut (a clipped box edge, or the photo's own frame) the edge is
    # a straight line. Inside a band along it the cut is moved onto the darkest path through the
    # cloud (a seam: one pixel per row, stepping at most one column per row, the path of least
    # lightness), which runs along the shaded creases between the lobes, so the cut follows the
    # photo's own structure and only ever shows a lobe's edge. Trimming by a lightness threshold
    # instead left a ruler line wherever a lobe was uniformly bright up to the cut. Nothing drawn.
    cy, cx = np.nonzero(core)
    cw, ch = cx.max() - cx.min() + 1, cy.max() - cy.min() + 1
    lum = px.mean(2); lo_l, hi_l = np.percentile(lum[core], [5, 95])
    ln = ((lum - lo_l) / max(hi_l - lo_l, 1)).clip(0, 1)
    edges = []   # (axis, position, direction into the cloud)
    for pos, axis, d, size in ((x0 if a.clip else 0, 1, 1, cw), ((x1 if a.clip else px.shape[1]) - 1, 1, -1, cw), (y0 if a.clip else 0, 0, 1, ch), ((y1 if a.clip else px.shape[0]) - 1, 0, -1, ch)):
        coord = cx if axis == 1 else cy
        if np.abs(coord - pos).min() <= 2: edges.append((axis, pos, d, max(100, int(size * 0.22))))
    for axis, pos, d, B in edges:
        idx = np.arange(px.shape[1] if axis == 1 else px.shape[0])
        dist = ((idx - pos) * d).clip(0, B) / B          # 0 at the cut, 1 a band's width in
        dist = dist[None, :] if axis == 1 else dist[:, None]
        alpha = seam_cut(alpha, ln, axis, pos, d, B)
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
