#!/usr/bin/env python3
"""Build the painted backdrop assets from the concept art.

  python3 tools/build_backdrop.py [--debug DIR]

The scene is art/concept_art_03.png at its native 1024x767 (padded to 768): the painted bench,
board, pay phone and pole are part of the backdrop. art/concept_art_01.jpg is the same painting
without the props; the difference between the two, inside known prop rectangles, marks the prop
pixels. The sky is separated from the terrain and the painted notes are cleared off the cork so
the site can pin its own. Writes:

  assets/backdrop.png       1024x768 painted scene, full color; sky pixels are black
  assets/backdrop_mask.png  1024x768 RGB: R = layer (0 sky, 1 peak, 2 range, 3 far hill, 4 flank, 5 trees, 6 near)
                                           G = material (0 none, 1 grass, 2 foliage, 3 rock, 4 snow, 5 dirt, 6 shrub, 7 prop)
                                           B = height within the layer's column (0 bottom .. 255 top)

--debug writes overlay PNGs (sky magenta, layers tinted, props cyan, polylines) into DIR.
"""
import argparse, os, sys
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 1024, 768
HORIZON = 550   # where the ground meets the trees, for the site's fog bands and shadows
OX, OY = 32, 190   # the silhouettes below were traced on an earlier 960x540 crop at this offset

# Hand-traced silhouettes in scene coordinates.
PEAK = [(735, 418), (760, 410), (778, 404), (787, 399), (795, 394), (805, 388), (815, 380), (824, 377), (834, 378),
        (846, 383), (860, 381), (872, 373), (880, 367), (886, 367), (895, 372), (905, 378), (915, 375), (925, 371),
        (935, 375), (946, 385), (960, 392), (978, 396), (992, 401), (1008, 404), (1024, 408), (1024, 490), (735, 490)]
FAR_MID = [(535, 430), (576, 440), (608, 452), (672, 470), (704, 477), (736, 466), (1024, 466)]
MEADOW = [(32, 536), (128, 548), (192, 540), (320, 543), (448, 537), (512, 530), (608, 526), (704, 526), (736, 549),
          (800, 564), (896, 561), (1024, 560)]
# Where the painted props are (art coordinates); the diff against the prop-less painting decides
# the exact pixels inside these boxes.
PROP_RECTS = [
    (145, 598, 432, 706), (448, 475, 652, 612), (703, 483, 810, 652),        # bench body, board frame, phone cabinet
    (825, 12, 1020, 72), (790, 80, 915, 182), (900, 115, 925, 178),      # crossarm, lantern, junction box
    (540, 0, 845, 72), (935, 20, 1024, 165),                                 # wires
]
# Legs, posts and the pedestal stand where the two paintings also differ in the grass, so there
# only dark pixels count.
PROP_RECTS_DARK = [(145, 706, 182, 768), (393, 706, 432, 768), (466, 612, 490, 768), (610, 612, 634, 768), (735, 652, 775, 768)]
# The pole runs through sky and clouds that differ a little between the paintings: only wood or dark pixels count.
PROP_RECTS_WOOD = [(890, 0, 965, 768)]
CORK = (462, 490, 640, 600)   # the board's cork; painted notes here are replaced by cork texture
PATCHES = []


def polyline_y(points, w=W):
    """Interpolate a polyline into a per-column y (float)."""
    xs = np.array([p[0] for p in points], float)
    ys = np.array([p[1] for p in points], float)
    return np.interp(np.arange(w), xs, ys)


def majority(mask, k=5):
    """3x3 majority vote on a boolean mask (>= k of 9)."""
    p = np.pad(mask.astype(np.uint8), 1)
    s = sum(p[dy:dy + mask.shape[0], dx:dx + mask.shape[1]] for dy in range(3) for dx in range(3))
    return s >= k


def poly_mask(points):
    im = Image.new('L', (W, H), 0)
    ImageDraw.Draw(im).polygon(points, fill=1)
    return np.array(im, bool)


def patch_meadow(rgb, edges, rs):
    """Replace the rows between the given edges by mirroring the meadow just outside each side,
    so the texture stays coherent with its surroundings."""
    out = rgb.copy()
    ys = np.array([t[0] for t in edges], float)
    x0s = np.array([t[1] for t in edges], float) - 5; x1s = np.array([t[2] for t in edges], float) + 5
    top, bot = int(ys.min()), min(H, int(ys.max()) + 1)
    for y in range(top, bot):
        a = int(round(np.interp(y, ys, x0s))); b = int(round(np.interp(y, ys, x1s)))
        mid = (a + b) // 2
        jl, jr = int(rs.rand() * 10), int(rs.rand() * 10)
        if edges is TRAIL and y > 478: jl += 72   # skip the boulders left of the trail's foot
        for px in range(a, b + 1):
            sx = (a - 1 - (px - a) - jl) if px <= mid else (b + 1 + (b - px) + jr)
            sy = y + int(rs.rand() * 3) - 1
            sx = min(max(sx, 0), W - 1); sy = min(max(sy, top), H - 1)
            out[y, px] = rgb[sy, sx]
    return out


def remove_trail(rgb):
    rs = np.random.RandomState(5)
    for edges in PATCHES: rgb = patch_meadow(rgb, edges, rs)
    return rgb


def clear_cork(rgb):
    """Replace the painted notes on the cork with cork texture sampled from the rest of the cork."""
    out = rgb.copy(); rs = np.random.RandomState(9)
    x0, y0, x1, y1 = CORK
    sub = rgb[y0:y1, x0:x1].astype(int)
    lum = 0.299 * sub[..., 0] + 0.587 * sub[..., 1] + 0.114 * sub[..., 2]
    red = sub[..., 0] > sub[..., 1] + 50
    paper = majority((lum > 138) | red, 2)
    pool = sub[~paper & (lum > 55) & (lum < 130)]
    ys, xs = np.nonzero(paper)
    out[y0 + ys, x0 + xs] = pool[rs.randint(0, len(pool), len(xs))]
    return out


def fill_holes(mask, box):
    """Inside one box, mark as prop any non-prop pixel not connected to the box's border."""
    x0, y0, x1, y1 = box
    sub = mask[y0:y1, x0:x1]
    free = ~sub
    reach = np.zeros_like(free)
    reach[0, :] = free[0, :]; reach[-1, :] = free[-1, :]; reach[:, 0] = free[:, 0]; reach[:, -1] = free[:, -1]
    while True:
        p = np.pad(reach, 1)
        grown = (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:] | reach) & free
        if np.array_equal(grown, reach): break
        reach = grown
    mask[y0:y1, x0:x1] = sub | (free & ~reach)


def prop_mask(with_props, without):
    d = np.abs(with_props.astype(int) - without.astype(int)).max(2) > 40
    lum = 0.299 * with_props[..., 0] + 0.587 * with_props[..., 1] + 0.114 * with_props[..., 2]
    boxes = np.zeros((H, W), bool)
    for x0, y0, x1, y1 in PROP_RECTS: boxes[y0:y1, x0:x1] = True
    dark = np.zeros((H, W), bool)
    for x0, y0, x1, y1 in PROP_RECTS_DARK: dark[y0:y1, x0:x1] = True
    wood = np.zeros((H, W), bool)
    for x0, y0, x1, y1 in PROP_RECTS_WOOD: wood[y0:y1, x0:x1] = True
    woody = (with_props[..., 0].astype(int) > with_props[..., 2].astype(int) + 20) | (lum < 100)
    m = majority(d & (boxes | (dark & (lum < 140)) | (wood & woody)), 3)
    m = majority(m, 1) & (boxes | dark | wood)   # dilate a pixel for the soft edges
    for box in PROP_RECTS + PROP_RECTS_DARK + PROP_RECTS_WOOD: fill_holes(m, box)
    return m


def classify(rgb):
    r, g, b = [rgb[..., i].astype(int) for i in range(3)]
    tan = (r > b + 40) & (r >= g)
    green = (g >= r) & (g > b + 12)
    dark = (np.maximum(np.maximum(r, g), b) < 90) & (b < r + 40)
    navy = (b < 135) & (b > r + 20) & (r < 90)
    return tan, green, dark, navy


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--debug', metavar='DIR')
    args = ap.parse_args()

    art1 = Image.open(os.path.join(ROOT, 'art/concept_art_01.jpg')).convert('RGB')
    art3 = Image.open(os.path.join(ROOT, 'art/concept_art_03.png')).convert('RGB')
    assert art1.size == (1024, 767) and art3.size == (1024, 767), (art1.size, art3.size)
    pad = lambda im: np.concatenate([np.array(im), np.array(im)[-1:]], 0)   # 767 -> 768 rows
    bare = pad(art1)
    rgb = pad(art3)
    prop = prop_mask(rgb, bare)
    rgb = clear_cork(remove_trail(rgb))
    crop = Image.fromarray(rgb)
    tan, green, dark, navy = classify(bare)   # the sky boundary comes from the painting without props
    br, bg, bb = [bare[..., i].astype(int) for i in range(3)]
    blum = 0.299 * br + 0.587 * bg + 0.114 * bb
    yy0 = np.mgrid[0:H, 0:W][0]
    hazy = (bb < 176) & (bb > br + 8) & (blum < 150) & (yy0 >= 380)   # distant ridges fading into the sky (never the dark upper sky)
    skyish = (bb > 176) | (blum > 170)                        # sky blue and cloud white
    terrain = majority(tan | green | dark | navy | hazy)

    # First row in each column where 6 consecutive rows are terrain.
    run = np.zeros(W, int); top = np.full(W, H, int)
    for y in range(H):
        run = np.where(terrain[y], run + 1, 0)
        hit = (run >= 6) & (top == H)
        top[hit] = y - 5
    yy, xx = np.mgrid[0:H, 0:W]
    peak = poly_mask(PEAK)
    sky = skyish & (yy < top[None, :] + 8) & (~peak)
    sky |= (yy < top[None, :] - 1) & (~peak)   # nothing above the crest is terrain
    sky = majority(sky)
    sky &= ~prop

    # Layers, far to near: the snowy peak, the forested navy range in front of it, the distant
    # grass hill beyond the trees, Sentinel's flank at the left, the tree band, the meadow.
    far_mid = polyline_y(FAR_MID)
    meadow = polyline_y(MEADOW)
    foliage = majority(green | dark)
    sr, sg, sb = [rgb[..., i].astype(int) for i in range(3)]
    slum = 0.299 * sr + 0.587 * sg + 0.114 * sb
    navyish = majority(navy | ((sb < 176) & (sb > sr + 8) & (slum < 150) & (yy >= 380)), 5)
    above_meadow = yy < meadow[None, :]
    farzone = (xx >= 503 + OX) & (yy < far_mid[None, :]) & (~foliage)
    L_PEAK, L_RANGE, L_FARHILL, L_FLANK, L_TREES, L_NEAR = 1, 2, 3, 4, 5, 6
    layer = np.zeros((H, W), np.uint8)
    mid = above_meadow & ~farzone & ~peak
    layer[mid & ~foliage & (xx < 600)] = L_FLANK
    layer[mid & ~foliage & (xx >= 600)] = L_FARHILL
    layer[mid & foliage] = L_TREES
    layer[farzone & ~navyish] = L_FARHILL
    layer[(farzone | mid | peak) & navyish & ~foliage] = L_RANGE
    layer[peak & ~navyish] = L_PEAK
    layer[~above_meadow] = L_NEAR
    # anything left over (dark forest at the foot of the peak, odd colors) joins its neighbors
    left = (layer == 0) & above_meadow
    layer[left & peak] = L_RANGE
    layer[left & ~peak & foliage] = L_TREES
    layer[left & ~peak & ~foliage & (xx < 600)] = L_FLANK
    layer[left & ~peak & ~foliage & (xx >= 600)] = L_FARHILL
    layer[sky] = 0
    layer[prop] = L_NEAR
    # Keep the painting's true colors: a 256-color quantize flattens the distant ranges' pale haze.
    out_np = rgb.copy(); out_np[sky] = 0
    outq = Image.fromarray(out_np)
    q = out_np

    # Materials.
    r, g, b = [q[..., i].astype(int) for i in range(3)]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    tan, green, dark, navy = classify(q)
    tan_m, green_m = majority(tan), majority(green | dark)
    dirt = majority((np.abs(r - g) < 30) & (r - b > 10) & (r - b < 60) & (r > 100) & (r < 200))
    mat = np.zeros((H, W), np.uint8)
    mat[layer == L_PEAK] = 3
    mat[(layer == L_PEAK) & (lum > 182) & (sat < 0.3) & (yy < 445)] = 4   # summit snow (the pale haze at the foot is rock)
    mat[layer == L_RANGE] = 3
    mat[(layer == L_FARHILL) | (layer == L_FLANK)] = 1
    mat[layer == L_TREES] = 2
    nearm = layer == L_NEAR
    mat[nearm & tan_m] = 1
    mat[nearm & dirt & ~tan_m] = 5
    mat[nearm & green_m] = 6
    mat[nearm & (mat == 0)] = 1
    mat[prop] = 7

    # Height fraction within the layer column: 0 at the layer's bottom line, 255 at its top.
    hf = np.zeros((H, W), np.float32)
    peak_top = np.minimum(top, polyline_y(PEAK[:-2]))
    for lid, (top_line, bot_line) in {
        L_PEAK: (peak_top, far_mid), L_RANGE: (top, far_mid), L_FARHILL: (top, meadow),
        L_FLANK: (top, meadow), L_TREES: (top, meadow), L_NEAR: (meadow, np.full(W, H, float)),
    }.items():
        sel = layer == lid
        t = np.clip((bot_line[None, :] - yy) / np.maximum(bot_line[None, :] - top_line[None, :], 1), 0, 1)
        hf[sel] = t[sel]
    mask = np.stack([layer, mat, (hf * 255).astype(np.uint8)], -1)

    os.makedirs(os.path.join(ROOT, 'assets'), exist_ok=True)
    with open(os.path.join(ROOT, 'assets/backdrop.json'), 'w') as f:
        f.write('{"w": %d, "h": %d, "horizon": %d}\n' % (W, H, HORIZON))
    outq.save(os.path.join(ROOT, 'assets/backdrop.png'), optimize=True)
    Image.fromarray(mask).save(os.path.join(ROOT, 'assets/backdrop_mask.png'), optimize=True)
    print('sky px', int(sky.sum()), 'layers', {i: int((layer == i).sum()) for i in range(7)},
          'materials', {i: int((mat == i).sum()) for i in range(8)})

    if args.debug:
        os.makedirs(args.debug, exist_ok=True)
        ov = np.array(crop).copy()
        ov[sky] = (255, 0, 255)
        ov[prop] = (ov[prop] * 0.5 + np.array((0, 255, 255)) * 0.5).astype(np.uint8)
        tint = {1: (255, 0, 0), 2: (255, 0, 128), 3: (255, 160, 0), 4: (255, 255, 0), 5: (0, 255, 0), 6: (0, 0, 255)}
        for lid, c in tint.items():
            sel = layer == lid
            ov[sel] = (ov[sel] * 0.6 + np.array(c) * 0.4).astype(np.uint8)
        im = Image.fromarray(ov); d = ImageDraw.Draw(im)
        d.line(PEAK[:-2], fill=(255, 255, 255)); d.line(FAR_MID, fill=(0, 255, 255)); d.line(MEADOW, fill=(255, 128, 0))
        d.line([(x, int(top[x])) for x in range(W)], fill=(0, 0, 0))
        im.save(os.path.join(args.debug, 'overlay.png'))
        im.crop((760, 0, 1024, 200)).resize((792, 600), Image.NEAREST).save(os.path.join(args.debug, 'overlay_pole_3x.png'))
        im.crop((120, 460, 830, 768)).resize((1420, 616), Image.NEAREST).save(os.path.join(args.debug, 'overlay_props_2x.png'))
        mv = np.zeros((H, W, 3), np.uint8)
        pal = {0: (0, 0, 0), 1: (200, 170, 90), 2: (40, 120, 40), 3: (120, 120, 130), 4: (240, 245, 255), 5: (130, 100, 70), 6: (110, 130, 80), 7: (0, 200, 220)}
        for m, c in pal.items(): mv[mat == m] = c
        Image.fromarray(mv).save(os.path.join(args.debug, 'materials.png'))
        Image.fromarray(mask[..., 2]).save(os.path.join(args.debug, 'height.png'))
        outq.convert('RGB').save(os.path.join(args.debug, 'backdrop_preview.png'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
