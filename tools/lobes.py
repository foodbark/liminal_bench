#!/usr/bin/env python3
"""Split a cut-out cloud (tools/cut_cloud.py) into its bumps along the shadow seams, for the
lobe library (tools/build_clouds.py, entries flagged "lobes"). A cumulus is a mass with bubbles
rising out of it: each bump is a thermal, and where two of them pressed together there is a
fold that light cannot get into. A watershed finds the candidates: the lightness is smoothed
(a round Gaussian; the square box blur lined the gradient up with the pixel rows), each local
crown becomes a seed, and the cloud floods out from the crowns. But a watershed puts a boundary
between every two crowns whether or not a fold is there, and on a smooth shoulder with no seam
the floods met along rows and columns (ruler-straight creases through flat interior, 2026-10-20).
So every boundary is then tested for a real seam, the lightness along it against the lightness
a few cells into each side, and two basins with no fold between them merge into one bump, the
weakest boundary first, until every cut left is a shadow seam. A bump's outline is then sky or
fold and nothing else; the straight line only ever ran where there was nothing to follow.
Basins too small to be a bump are merged into the neighbor they share the longest boundary
with. Nothing is drawn: a bump is the photo's own pixels under a mask.
  python3 tools/lobes.py CUT.png OUT_DEBUG.png     draws the lobes in colors to check the cuts
"""
import heapq, sys
import numpy as np


def box_blur(a, k):
    k = max(1, k | 1)
    p = np.pad(a, k // 2, mode='edge')
    c = np.cumsum(np.cumsum(p, 0), 1); c = np.pad(c, ((1, 0), (1, 0)))
    H, W = a.shape
    return (c[k:k + H, k:k + W] - c[:H, k:k + W] - c[k:k + H, :W] + c[:H, :W]) / (k * k)


def gauss_blur(a, sigma):
    """Separable Gaussian, edge-padded: round, so the smoothed field has no preferred axis."""
    r = max(1, int(sigma * 3)); x = np.arange(-r, r + 1)
    k = np.exp(-0.5 * (x / sigma) ** 2); k /= k.sum()
    p = np.pad(a, r, mode='edge')
    rows = np.apply_along_axis(lambda v: np.convolve(v, k, mode='valid'), 1, p)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode='valid'), 0, rows)


def grow_in(mask, within, steps):
    """mask dilated `steps` times (4-neighborhood), never leaving `within`."""
    out = mask & within
    for _ in range(steps):
        n = out.copy(); n[1:] |= out[:-1]; n[:-1] |= out[1:]; n[:, 1:] |= out[:, :-1]; n[:, :-1] |= out[:, 1:]
        out = n & within
    return out


def seam_contrast(labels, lum, i, j, near=2, far=6, fold=0.075, rng=1.0):
    """How much of the boundary between basins i and j is a shadow seam. At each boundary cell
    the lightness of the boundary near it is read against the lightness `near`..`far` steps into
    each basin within a window around it; the cell is seam where the boundary is clearly darker
    than both sides (a fold under an overhang is a broad shadow, not a line, so the sides are
    read well clear of it; a smooth shoulder between two crowns is darker than one side only).
    Judged cell by cell, since a boundary that is half fold and half shoulder kept its straight
    half when judged whole. Returns (fraction of the boundary that is seam, mean contrast over
    the seam cells as a fraction of rng, boundary length), or (None, 0, 0) if the two do not touch."""
    A, B = labels == i, labels == j
    nb = np.zeros_like(A)
    nb[1:] |= B[:-1]; nb[:-1] |= B[1:]; nb[:, 1:] |= B[:, :-1]; nb[:, :-1] |= B[:, 1:]
    ba = A & nb
    na = np.zeros_like(B)
    na[1:] |= A[:-1]; na[:-1] |= A[1:]; na[:, 1:] |= A[:, :-1]; na[:, :-1] |= A[:, 1:]
    bb = B & na
    if not ba.any(): return None, 0, 0
    edge = ba | bb
    bands = [grow_in(b, m, far) & ~grow_in(b, m, near) for b, m in ((ba, A), (bb, B))]
    R = far + near
    H, W = A.shape
    ys, xs = np.nonzero(ba)
    seam = []; contrast = []
    for y, x in zip(ys, xs):
        y0, y1, x0, x1 = max(0, y - R), min(H, y + R + 1), max(0, x - R), min(W, x + R + 1)
        e = lum[y0:y1, x0:x1][edge[y0:y1, x0:x1]].mean()
        sides = []
        for band, m in zip(bands, (A, B)):
            w = band[y0:y1, x0:x1]
            if not w.any(): w = m[y0:y1, x0:x1] & ~edge[y0:y1, x0:x1]
            if not w.any(): break
            sides.append(lum[y0:y1, x0:x1][w].mean())
        if len(sides) < 2: seam.append(False); continue
        c = (min(sides) - e) / rng
        seam.append(c >= fold)
        if c >= fold: contrast.append(c)
    seam = np.array(seam)
    return float(seam.mean()), (float(np.mean(contrast)) if contrast else 0.0), int(len(seam))


def segment(alpha, rgb, s=4, blur=2.6, seed_r=None, min_frac=0.025, fold=0.075, seam_frac=0.8):
    """alpha, rgb: the cut-out at photo pixels (alpha 0..1, rgb 0..255). Returns the label grid
    at 1/s resolution (0 = not cloud, 1.. = lobes) and a list of lobe records."""
    H, W = alpha.shape
    h, w = H // s, W // s
    m = alpha[:h * s, :w * s].reshape(h, s, w, s).mean((1, 3)) >= 0.5
    lum = rgb.mean(2)[:h * s, :w * s].reshape(h, s, w, s).mean((1, 3))
    L = gauss_blur(lum, blur)
    L[~m] = -1e9
    lo_l, hi_l = np.percentile(lum[m], [5, 95]); rng = max(hi_l - lo_l, 1)
    ln = gauss_blur(lum, 1.0)   # the seam test reads a lightly smoothed lightness, so a narrow fold is not smeared away
    # the seam test's bands, scaled to the cloud: a fold under an overhang is a broad shadow, not
    # a line, so the sides are read well clear of it (on cumulus_01 the underside of the top
    # turret measured no darker than the cells beside it and a fifth darker than the cloud 6 to
    # 16 cells away; a smooth shoulder between two crowns is darker than one side only)
    near, far = max(2, round(0.015 * max(h, w))), max(5, round(0.04 * max(h, w)))
    if seed_r is None: seed_r = int(min(12, max(5, min(h, w) / 14)))   # a crown's window: about a dozen lobes across a cloud
    # seeds: the crowns, local maxima of the smoothed lightness over a window of seed_r cells
    mx = L.copy()
    for _ in range(seed_r):
        n = mx.copy()
        n[1:] = np.maximum(n[1:], mx[:-1]); n[:-1] = np.maximum(n[:-1], mx[1:])
        n[:, 1:] = np.maximum(n[:, 1:], mx[:, :-1]); n[:, :-1] = np.maximum(n[:, :-1], mx[:, 1:])
        mx = n
    seeds = m & (L >= mx - 1e-6)
    labels = np.zeros((h, w), np.int32)
    nxt = 1
    heap = []
    for y, x in zip(*np.nonzero(seeds)):
        if labels[y, x]: continue
        # one seed per plateau of equal maxima
        stack = [(y, x)]; labels[y, x] = nxt
        while stack:
            cy, cx = stack.pop()
            heapq.heappush(heap, (-L[cy, cx], cy, cx))
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and seeds[ny, nx] and not labels[ny, nx] and abs(L[ny, nx] - L[cy, cx]) < 1e-6:
                    labels[ny, nx] = nxt; stack.append((ny, nx))
        nxt += 1
    # the flood: brightest first, each cell handing its label to its unlabeled neighbors
    while heap:
        _, y, x = heapq.heappop(heap)
        lab = labels[y, x]
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not labels[ny, nx]:
                labels[ny, nx] = lab
                heapq.heappush(heap, (-L[ny, nx], ny, nx))
    # merge the crumbs into the neighbor across the longest crease
    total = int(m.sum())
    for _ in range(64):
        areas = np.bincount(labels.ravel(), minlength=nxt)
        small = [i for i in range(1, nxt) if 0 < areas[i] < total * min_frac]
        if not small: break
        for i in small:
            mine = labels == i
            shared = {}
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                a = np.roll(mine, (dy, dx), (0, 1)); b = labels[a]
                for v in b[(b != i) & (b != 0)]: shared[v] = shared.get(v, 0) + 1
            if shared: labels[mine] = max(shared, key=shared.get)
    # merge across every boundary that is not a shadow seam along (nearly) its whole length,
    # the least seam-like first, until each cut left is a fold; a crown on a smooth shoulder of a
    # bigger bump is part of that bump, and a bump is what sky and fold enclose
    strength = {}
    def pairs():
        ids = [i for i in np.unique(labels) if i]
        out = []
        for a in range(len(ids)):
            for b in range(a + 1, len(ids)):
                i, j = ids[a], ids[b]
                if (i, j) not in strength: strength[(i, j)] = seam_contrast(labels, ln, i, j, near, far, fold, rng)
                f, c, n = strength[(i, j)]
                if f is not None: out.append((f, c, n, i, j))
        return out
    while True:
        ps = pairs()
        weak = [p for p in ps if p[0] < seam_frac]
        if not weak: break
        f, c, n, i, j = min(weak)
        labels[labels == j] = i
        strength = {k: v for k, v in strength.items() if i not in k and j not in k}
    # renumber 1..n and gather the records
    ids = [i for i in np.unique(labels) if i]
    seam_of = {}
    for i in ids:
        cs = [(v[1], v[2]) for k, v in strength.items() if i in k and v[0] is not None]
        seam_of[i] = sum(c * n for c, n in cs) / max(1, sum(n for _, n in cs)) if cs else 0.0
    out = np.zeros_like(labels); recs = []
    ys_all, xs_all = np.nonzero(m)
    bottom = ys_all.max(); top = ys_all.min()
    for k, i in enumerate(ids, 1):
        mine = labels == i; out[mine] = k
        ys, xs = np.nonzero(mine)
        # the outline, edge by edge: the top cell of each column, the bottom cell, and the outer
        # cell of each row on the upper half's left and right, each against sky (free) or against
        # another bump (a seam cut). Counted over the whole upper half, a mass piece with a flat
        # seam on top and sky down both sides passed as a crown and stood on the bench with a
        # ruler-straight top (2026-10-20); the top edge is what a crown shows.
        cy0 = (ys.min() + ys.max()) / 2
        # a long straight run along an edge is a cut whatever lies beyond it: the photo's frame
        # (a cloud that ran out of the top of its photo had a flat top with sky above it and
        # stood on the bench as a block, 2026-10-20) or a clip box; a cloud's own edge never
        # runs straight for a tenth of its width
        straight = max(5, int(0.1 * min(xs.max() - xs.min(), ys.max() - ys.min()) + 1))
        def free_along(cells, dy, dx):
            cells = sorted(cells, key=lambda c: c[1] if dy else c[0])
            n = f = 0
            k = 0
            while k < len(cells):
                run = k + 1
                while run < len(cells) and cells[run][0 if dy else 1] == cells[k][0 if dy else 1] and cells[run][1 if dy else 0] == cells[run - 1][1 if dy else 0] + 1: run += 1
                cut = run - k >= straight
                for y, x in cells[k:run]:
                    ny, nx = y + dy, x + dx
                    n += 1; f += (not cut) and not (0 <= ny < h and 0 <= nx < w and m[ny, nx] and labels[ny, nx] != i)
                k = run
            return f / max(1, n)
        tops = [(ys[xs == x].min(), x) for x in np.unique(xs)]
        bots = [(ys[xs == x].max(), x) for x in np.unique(xs)]
        upper = [y for y in np.unique(ys) if y < cy0]
        lefts = [(y, xs[ys == y].min()) for y in upper]; rights = [(y, xs[ys == y].max()) for y in upper]
        free_top = free_along(tops, -1, 0); free_bot = free_along(bots, 1, 0)
        free_sides = (free_along(lefts, 0, -1) + free_along(rights, 0, 1)) / 2
        recs.append({
            'id': k, 'x0': int(xs.min()) * s, 'y0': int(ys.min()) * s, 'x1': int(xs.max() + 1) * s, 'y1': int(ys.max() + 1) * s,
            'area': int(mine.sum()) * s * s,
            'freeTop': free_top, 'freeBottom': free_bot, 'freeSides': free_sides,
            'onBase': bool(ys.max() >= bottom - (bottom - top) * 0.08),
            'seam': round(float(seam_of[i]), 3),   # how dark its folds are against the cloud beside them, 0 for a bump with no fold at all
        })
    return out, recs


if __name__ == '__main__':
    from PIL import Image
    im = np.asarray(Image.open(sys.argv[1]).convert('RGBA'), np.float64)
    labels, recs = segment(im[..., 3] / 255, im[..., :3])
    rs = np.random.RandomState(3)
    cols = rs.randint(60, 255, (labels.max() + 1, 3)); cols[0] = (40, 70, 120)
    pic = cols[labels].astype(np.uint8)
    # the photo's own lightness under the colors, so the lobes read against the cloud
    s = 4; h, w = labels.shape
    lum = im[..., :3].mean(2)[:h * s, :w * s].reshape(h, s, w, s).mean((1, 3)) / 255
    pic = (pic * (0.45 + 0.55 * lum[..., None])).astype(np.uint8)
    Image.fromarray(pic).save(sys.argv[2])
    for r in recs: print(r)
    print(len(recs), 'bumps')
