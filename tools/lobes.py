#!/usr/bin/env python3
"""Split a cut-out cloud (tools/cut_cloud.py) into its lobes along the creases, for the lobe
library (tools/build_clouds.py, entries flagged "lobes"). A cumulus is a pile of rounded lobes
with dark folds between them, so a watershed does the work: the lightness is smoothed, each
local crown becomes a seed, and the cloud floods out from the crowns into the folds; where two
floods meet is a crease, and each basin is a lobe. Basins too small to be a lobe are merged
into the neighbor they share the longest crease with. Nothing is drawn: a lobe is the photo's
own pixels under a mask.
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


def segment(alpha, rgb, s=4, blur=9, seed_r=None, min_frac=0.025):
    """alpha, rgb: the cut-out at photo pixels (alpha 0..1, rgb 0..255). Returns the label grid
    at 1/s resolution (0 = not cloud, 1.. = lobes) and a list of lobe records."""
    H, W = alpha.shape
    h, w = H // s, W // s
    m = alpha[:h * s, :w * s].reshape(h, s, w, s).mean((1, 3)) >= 0.5
    lum = rgb.mean(2)[:h * s, :w * s].reshape(h, s, w, s).mean((1, 3))
    L = box_blur(lum, blur)
    L[~m] = -1e9
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
    # renumber 1..n and gather the records
    ids = [i for i in np.unique(labels) if i]
    out = np.zeros_like(labels); recs = []
    ys_all, xs_all = np.nonzero(m)
    bottom = ys_all.max(); top = ys_all.min()
    for k, i in enumerate(ids, 1):
        mine = labels == i; out[mine] = k
        ys, xs = np.nonzero(mine)
        # boundary cells: free (against sky) or crease (against another lobe); by upper and lower half
        free_top = crease_top = free_bot = crease_bot = 0
        cy0 = (ys.min() + ys.max()) / 2
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = np.roll(labels, (dy, dx), (0, 1)); nm = np.roll(m, (dy, dx), (0, 1))
            edge = mine & (nb != i)
            ey, ex = np.nonzero(edge)
            up = ey < cy0
            isfree = ~nm[ey, ex]
            free_top += int((isfree & up).sum()); crease_top += int((~isfree & up).sum())
            free_bot += int((isfree & ~up).sum()); crease_bot += int((~isfree & ~up).sum())
        recs.append({
            'id': k, 'x0': int(xs.min()) * s, 'y0': int(ys.min()) * s, 'x1': int(xs.max() + 1) * s, 'y1': int(ys.max() + 1) * s,
            'area': int(mine.sum()) * s * s,
            'freeTop': free_top / max(1, free_top + crease_top),
            'freeBottom': free_bot / max(1, free_bot + crease_bot),
            'onBase': bool(ys.max() >= bottom - (bottom - top) * 0.08),
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
    print(len(recs), 'lobes')
