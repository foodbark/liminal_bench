#!/usr/bin/env python3
"""Build the painted backdrop assets from the concept art.

  python3 tools/build_backdrop.py [--debug DIR]

Reads art/concept_art_01.jpg (backdrop) and art/concept_art_02.jpg (with props), crops both to the
960x540 scene window at native pixels, separates sky from terrain, and writes:

  assets/backdrop.png       960x540 painted terrain, 256 colors; sky pixels are black
  assets/backdrop_mask.png  960x540 RGB: R = layer (0 sky, 1 far, 2 flank, 3 trees, 4 near)
                                          G = material (0 none, 1 grass, 2 foliage, 3 rock, 4 snow, 5 dirt, 6 shrub)
                                          B = height within the layer's column (0 bottom .. 255 top)
  art/ref_props_960.png     concept_art_02 at scene scale, for drawing props against

--debug writes overlay PNGs (sky magenta, layers tinted, polylines) into DIR for eyeballing the masks.
"""
import argparse, os, sys
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 960, 540
CROP = (32, 190, 32 + W, 190 + H)   # scene = art01 pixel - (32, 190)

# Hand-traced silhouettes in scene coordinates.
PEAK = [(703, 228), (728, 220), (746, 214), (755, 209), (763, 204), (773, 198), (783, 190), (792, 187), (802, 188),
        (814, 193), (828, 191), (840, 183), (848, 177), (854, 177), (863, 182), (873, 188), (883, 185), (893, 181),
        (903, 185), (914, 195), (928, 202), (946, 206), (960, 211), (960, 300), (703, 300)]
FAR_MID = [(503, 240), (544, 250), (576, 262), (640, 280), (672, 287), (704, 276), (960, 276)]
MEADOW = [(0, 346), (96, 358), (160, 350), (288, 353), (416, 347), (480, 340), (576, 336), (672, 336), (704, 359),
          (768, 374), (864, 371), (960, 370)]
# Regions patched over with meadow, each as measured left/right edges per row [y, x0, x1]:
# the painted trail (so the props sit on one plane instead of along a path into the distance)
# and the boulder that the bulletin board's right post would otherwise stand in.
TRAIL = [(340, 574, 598), (360, 561, 614), (380, 537, 638), (400, 494, 634), (420, 461, 596), (440, 437, 562),
         (470, 394, 522), (500, 351, 494), (540, 324, 506)]
BOULDER = [(422, 262, 318), (430, 252, 328), (446, 248, 332), (460, 250, 330), (470, 258, 322)]
PATCHES = [TRAIL, BOULDER]


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
    art2 = Image.open(os.path.join(ROOT, 'art/concept_art_02.jpg')).convert('RGB')
    assert art1.size == (1024, 767), art1.size
    crop = art1.crop(CROP)
    ref = art2.resize((1024, 767), Image.LANCZOS).crop(CROP)
    ref.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(os.path.join(ROOT, 'art/ref_props_960.png'), optimize=True)

    rgb = np.array(crop)
    rgb = remove_trail(rgb)
    tan, green, dark, navy = classify(rgb)
    terrain = majority(tan | green | dark | navy)

    # First row in each column where 6 consecutive rows are terrain.
    run = np.zeros(W, int); top = np.full(W, H, int)
    for y in range(H):
        run = np.where(terrain[y], run + 1, 0)
        hit = (run >= 6) & (top == H)
        top[hit] = y - 5
    yy, xx = np.mgrid[0:H, 0:W]
    peak = poly_mask(PEAK)
    sky = (~terrain) & (yy < top[None, :] + 8) & (~peak)
    sky = majority(sky)
    # Cloud/sky pockets fully enclosed by terrain below the ridge would be holes; nothing above the
    # scan line is terrain, so also force everything strictly above the scan line (minus peak) to sky.
    sky |= (yy < top[None, :] - 1) & (~peak)

    # Layers.
    far_mid = polyline_y(FAR_MID)
    meadow = polyline_y(MEADOW)
    foliage = majority(green | dark)
    layer = np.zeros((H, W), np.uint8)
    above_meadow = yy < meadow[None, :]
    far = (xx >= 503) & (yy < far_mid[None, :]) & (~foliage) | peak
    near = ~above_meadow
    mid = above_meadow & ~far
    layer[far] = 1
    layer[mid & ~foliage] = 2
    layer[mid & foliage] = 3
    layer[near] = 4
    layer[sky] = 0

    # Quantize the painting to 256 colors (cleans JPEG noise, halves the PNG).
    out_np = rgb.copy(); out_np[sky] = 0
    outq = Image.fromarray(out_np).quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    q = np.array(outq.convert('RGB'))

    # Materials from the quantized colors.
    r, g, b = [q[..., i].astype(int) for i in range(3)]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    tan, green, dark, navy = classify(q)
    tan_m, green_m = majority(tan), majority(green | dark)
    dirt = majority((np.abs(r - g) < 30) & (r - b > 10) & (r - b < 60) & (r > 100) & (r < 200))
    mat = np.zeros((H, W), np.uint8)
    mat[layer == 1] = 3
    mat[(layer == 1) & peak & (lum > 182) & (sat < 0.3)] = 4   # summit snow only; the ranges' pale haze is rock
    mat[(layer == 2)] = 1
    mat[(layer == 3)] = 2
    nearm = layer == 4
    mat[nearm & tan_m] = 1
    mat[nearm & dirt & ~tan_m] = 5
    mat[nearm & green_m] = 6
    mat[nearm & (mat == 0)] = 1

    # Height fraction within the layer column: 0 at the layer's bottom line, 255 at its top.
    hf = np.zeros((H, W), np.float32)
    for lid, (top_line, bot_line) in {
        1: (np.minimum(top, polyline_y(PEAK[:23])), far_mid),
        2: (top, meadow), 3: (top, meadow), 4: (meadow, np.full(W, H, float)),
    }.items():
        sel = layer == lid
        t = np.clip((bot_line[None, :] - yy) / np.maximum(bot_line[None, :] - top_line[None, :], 1), 0, 1)
        hf[sel] = t[sel]
    mask = np.stack([layer, mat, (hf * 255).astype(np.uint8)], -1)

    os.makedirs(os.path.join(ROOT, 'assets'), exist_ok=True)
    outq.save(os.path.join(ROOT, 'assets/backdrop.png'), optimize=True)
    Image.fromarray(mask).save(os.path.join(ROOT, 'assets/backdrop_mask.png'), optimize=True)
    print('sky px', int(sky.sum()), 'layers', {i: int((layer == i).sum()) for i in range(5)},
          'materials', {i: int((mat == i).sum()) for i in range(7)})

    if args.debug:
        os.makedirs(args.debug, exist_ok=True)
        ov = np.array(crop).copy()
        ov[sky] = (255, 0, 255)
        tint = {1: (255, 0, 0), 2: (255, 255, 0), 3: (0, 255, 0), 4: (0, 0, 255)}
        for lid, c in tint.items():
            sel = layer == lid
            ov[sel] = (ov[sel] * 0.6 + np.array(c) * 0.4).astype(np.uint8)
        im = Image.fromarray(ov); d = ImageDraw.Draw(im)
        d.line(PEAK[:23], fill=(255, 255, 255)); d.line(FAR_MID, fill=(0, 255, 255)); d.line(MEADOW, fill=(255, 128, 0))
        d.line([(x, int(top[x])) for x in range(W)], fill=(0, 0, 0))
        im.save(os.path.join(args.debug, 'overlay.png'))
        im.resize((W * 2, H * 2), Image.NEAREST).crop((600, 300, 1920, 700)).save(os.path.join(args.debug, 'overlay_peak_2x.png'))
        im.resize((W * 2, H * 2), Image.NEAREST).crop((500, 250, 1200, 500)).save(os.path.join(args.debug, 'overlay_pines_2x.png'))
        mv = np.zeros((H, W, 3), np.uint8)
        pal = {0: (0, 0, 0), 1: (200, 170, 90), 2: (40, 120, 40), 3: (120, 120, 130), 4: (240, 245, 255), 5: (130, 100, 70), 6: (110, 130, 80)}
        for m, c in pal.items(): mv[mat == m] = c
        Image.fromarray(mv).save(os.path.join(args.debug, 'materials.png'))
        Image.fromarray(mask[..., 2]).save(os.path.join(args.debug, 'height.png'))
        outq.convert('RGB').save(os.path.join(args.debug, 'backdrop_preview.png'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
