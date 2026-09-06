#!/usr/bin/env python3
"""Build the scene assets from a painting and its per-painting config.

  python3 tools/build_backdrop.py [--art NAME] [--debug DIR] [--scale N]

art/NAME.json describes the painting: which files (the scene with props, the same scene without
them, and optionally the props alone on black), the silhouettes traced on it, where the props and the cork are, hotspots, camera
targets and the numbers the renderer needs. Coordinates are in the config's "ref" size; a
painting that is an exact multiple of that size scales them automatically. Writes:

  assets/backdrop.png       the painting at native pixels, sky masked out (black), notes cleared off the cork
  assets/backdrop_mask.png  RGB: R = layer (0 sky, 1 peak, 2 range, 3 far hill, 4 flank, 5 trees, 6 near)
                                 G = material (0 none, 1 grass, 2 foliage, 3 rock, 4 snow, 5 dirt, 6 shrub, 7 prop)
                                 B = height within the layer's column (0 bottom .. 255 top)
  assets/backdrop.json      size, horizon and all scene geometry for the site (scaled)

--debug writes overlay PNGs (sky magenta, layers tinted, props cyan, polylines) into DIR.
--scale N upsamples the painting N times (nearest) to test a bigger scene.
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ART = 'concept_art_03'


def polyline_y(points, w):
    xs = np.array([p[0] for p in points], float); ys = np.array([p[1] for p in points], float)
    return np.interp(np.arange(w), xs, ys)


def majority(mask, k=5):
    """3x3 majority vote on a boolean mask (>= k of 9)."""
    p = np.pad(mask.astype(np.uint8), 1)
    s = sum(p[dy:dy + mask.shape[0], dx:dx + mask.shape[1]] for dy in range(3) for dx in range(3))
    return s >= k


def poly_mask(points, w, h):
    im = Image.new('L', (w, h), 0)
    if len(points) < 3: return np.array(im, bool)
    ImageDraw.Draw(im).polygon([tuple(p) for p in points], fill=1)
    return np.array(im, bool)


def classify(rgb):
    r, g, b = [rgb[..., i].astype(int) for i in range(3)]
    tan = (r > b + 40) & (r >= g)
    green = (g >= r) & (g > b + 12)
    dark = (np.maximum(np.maximum(r, g), b) < 90) & (b < r + 40)
    navy = (b < 135) & (b > r + 20) & (r < 90)
    return tan, green, dark, navy


def clear_cork(rgb, cork):
    """Replace the painted notes on the cork with cork texture sampled from the rest of the cork."""
    out = rgb.copy(); rs = np.random.RandomState(9)
    x0, y0, x1, y1 = cork
    sub = rgb[y0:y1, x0:x1].astype(int)
    lum = 0.299 * sub[..., 0] + 0.587 * sub[..., 1] + 0.114 * sub[..., 2]
    red = sub[..., 0] > sub[..., 1] + 50
    paper = majority((lum > 138) | red, 2)
    pool = sub[~paper & (lum > 55) & (lum < 130)]
    if len(pool):
        ys, xs = np.nonzero(paper)
        out[y0 + ys, x0 + xs] = pool[rs.randint(0, len(pool), len(xs))]
    return out


def boxcount(mask, rad, yy, xx, H, W):
    """Number of true pixels in the (2*rad+1) square window around each pixel."""
    ii = np.pad(np.cumsum(np.cumsum(mask.astype(np.int32), 0), 1), ((1, 0), (1, 0)))
    y0 = np.clip(yy - rad, 0, H); y1 = np.clip(yy + rad + 1, 0, H); x0 = np.clip(xx - rad, 0, W); x1 = np.clip(xx + rad + 1, 0, W)
    return ii[y1, x1] - ii[y0, x1] - ii[y1, x0] + ii[y0, x0]

def key_checker(im, tol=10):
    """Alpha for a JPEG whose transparent area was flattened to a gray/white checkerboard."""
    a = np.array(im.convert('RGB')).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    gray = (np.abs(r - g) < 8) & (np.abs(g - b) < 8)
    checker = gray & ((np.abs(r - 199) < tol) | (r > 245))
    solid = ~majority(checker, 3)
    solid = majority(solid, 5)
    # shave the edge: JPEG ringing against the checker leaves pale fringe pixels
    for _ in range(2): solid = majority(solid, 9)
    return solid

def fill_holes(mask, box):
    """Inside one box, mark as prop any non-prop pixel not connected to the box's border."""
    x0, y0, x1, y1 = box
    sub = mask[y0:y1, x0:x1]
    if sub.size == 0: return
    free = ~sub
    reach = np.zeros_like(free)
    reach[0, :] = free[0, :]; reach[-1, :] = free[-1, :]; reach[:, 0] = free[:, 0]; reach[:, -1] = free[:, -1]
    while True:
        p = np.pad(reach, 1)
        grown = (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:] | reach) & free
        if np.array_equal(grown, reach): break
        reach = grown
    mask[y0:y1, x0:x1] = sub | (free & ~reach)


def prop_mask(with_props, without, rects, rects_dark, rects_wood, H, W):
    """Prop pixels: where the scene differs from the prop-less painting, inside known boxes.
    Dark boxes (legs, posts, distant poles) only count dark pixels; wood boxes (the pole) only
    wood-colored or dark ones, since sky and clouds differ a little between the two paintings."""
    d = np.abs(with_props.astype(int) - without.astype(int)).max(2) > 40
    lum = 0.299 * with_props[..., 0] + 0.587 * with_props[..., 1] + 0.114 * with_props[..., 2]
    boxes = np.zeros((H, W), bool)
    for x0, y0, x1, y1 in rects: boxes[y0:y1, x0:x1] = True
    dark = np.zeros((H, W), bool)
    for x0, y0, x1, y1 in rects_dark: dark[y0:y1, x0:x1] = True
    wood = np.zeros((H, W), bool)
    for x0, y0, x1, y1 in rects_wood: wood[y0:y1, x0:x1] = True
    woody = (with_props[..., 0].astype(int) > with_props[..., 2].astype(int) + 20) | (lum < 100)
    m = majority(d & (boxes | (dark & (lum < 140)) | (wood & woody)), 3)
    m = majority(m, 1) & (boxes | dark | wood)
    for box in rects + rects_dark + rects_wood: fill_holes(m, box)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--art', default=None, help='config name under art/ (default: the one in art/current)')
    ap.add_argument('--debug', metavar='DIR')
    ap.add_argument('--scale', type=int, default=1, help='upsample the painting N times (nearest) to test a bigger scene')
    args = ap.parse_args()
    name = args.art or (open(os.path.join(ROOT, 'art/current')).read().strip() if os.path.exists(os.path.join(ROOT, 'art/current')) else DEFAULT_ART)
    cfg = json.load(open(os.path.join(ROOT, 'art', name + '.json')))
    art = Image.open(os.path.join(ROOT, 'art', cfg['art'])).convert('RGB')
    bare = Image.open(os.path.join(ROOT, 'art', cfg['bare'])).convert('RGB')
    ref_w, ref_h = cfg['ref']
    # a painting a couple of pixels off the reference size (export rounding) is snapped to it
    if art.size != (ref_w, ref_h) and abs(art.size[0] - ref_w) <= 4 and abs(art.size[1] - ref_h) <= 4:
        art = art.resize((ref_w, ref_h), Image.NEAREST)
    if bare.size != (ref_w, ref_h) and abs(bare.size[0] - ref_w) <= 4 and abs(bare.size[1] - ref_h) <= 4:
        bare = bare.resize((ref_w, ref_h), Image.NEAREST)
    # scale: the painting may be an exact multiple of the config's reference size
    k = args.scale
    if k == 1 and art.size[0] != ref_w:
        k = art.size[0] // ref_w
        assert art.size[0] == ref_w * k and abs(art.size[1] - ref_h * k) <= k, 'art must be the ref size or an exact multiple of it'
    elif k != 1:
        art = art.resize((art.size[0] * k, art.size[1] * k), Image.NEAREST)
    if bare.size != art.size: bare = bare.resize(art.size, Image.LANCZOS)
    W, H = ref_w * k, ref_h * k
    S = lambda v: int(round(v * k))
    pts = lambda L: [(S(p[0]), S(p[1])) for p in L]
    rects = lambda L: [tuple(S(v) for v in r) for r in L]

    def pad(im):
        a = np.array(im)
        while a.shape[0] < H: a = np.concatenate([a, a[-1:]], 0)
        return a[:H, :W]
    rgb = pad(art); bare_np = pad(bare)
    # An optional front painting (the near hills, trees and meadow with a transparent sky, here
    # flattened to a checkerboard) sits over the back painting; it may come at a lower resolution
    # and is pixel-doubled, never resampled.
    front = None
    if cfg.get('front'):
        fc = cfg['front']
        fim = Image.open(os.path.join(ROOT, 'art', fc['file']))
        alpha = key_checker(fim) if fc.get('key') == 'checker' else np.array(fim.convert('RGBA'))[..., 3] > 128
        fr = np.array(fim.convert('RGB'))
        sc = int(fc.get('scale', 1))
        if sc > 1:
            fr = np.repeat(np.repeat(fr, sc, 0), sc, 1); alpha = np.repeat(np.repeat(alpha, sc, 0), sc, 1)
        def fit(a):
            out = np.zeros((H, W) + a.shape[2:], a.dtype)
            hh, ww = min(H, a.shape[0]), min(W, a.shape[1]); out[:hh, :ww] = a[:hh, :ww]
            if ww < W: out[:, ww:] = out[:, ww - 1:ww]
            if hh < H: out[hh:] = out[hh - 1:hh]
            return out
        fr = fit(fr); front = fit(alpha)
        rgb = rgb.copy(); rgb[front] = fr[front]
        bare_np = bare_np.copy(); bare_np[front] = fr[front]

    PEAK = pts(cfg['peak']); FAR_MID = pts(cfg['far_mid']); MEADOW = pts(cfg['meadow'])
    PROP_RECTS = rects(cfg['prop_rects']); PROP_DARK = rects(cfg['prop_rects_dark']); PROP_WOOD = rects(cfg['prop_rects_wood'])
    CORK = tuple(S(v) for v in cfg['cork'])
    ridge_min_y = S(cfg['ridge_min_y']); snow_max_y = S(cfg['snow_max_y'])
    far_x = S(cfg['far_x']); farhill_x = S(cfg['farhill_x'])

    if cfg.get('props_only'):
        # the props alone on a near-black background: anything brighter than that is a prop
        po = Image.open(os.path.join(ROOT, 'art', cfg['props_only'])).convert('RGB')
        if po.size != art.size: po = po.resize(art.size, Image.NEAREST)
        po = pad(po).astype(int)
        plum = 0.299 * po[..., 0] + 0.587 * po[..., 1] + 0.114 * po[..., 2]
        prop = majority(plum > 26, 3)
        prop = majority(prop, 2)
    else:
        prop = prop_mask(rgb, bare_np, PROP_RECTS, PROP_DARK, PROP_WOOD, H, W)
    if cfg.get('props_from'):
        # a prop-less painting plus the props copied from another painting of the same scene
        pf = Image.open(os.path.join(ROOT, 'art', cfg['props_from'])).convert('RGB')
        if pf.size != art.size: pf = pf.resize(art.size, Image.NEAREST)
        pf = pad(pf)
        rgb = rgb.copy(); rgb[prop] = pf[prop]
    rgb = clear_cork(rgb, CORK)
    yy, xx = np.mgrid[0:H, 0:W]
    peak = poly_mask(PEAK, W, H)

    # --- sky: bright blue or white, above the crest. The crest comes from a traced skyline when
    # the config has one, else from a column scan of the prop-less painting.
    br, bg, bb = [bare_np[..., i].astype(int) for i in range(3)]
    blum = 0.299 * br + 0.587 * bg + 0.114 * bb
    ridgey = (bb > br + 35) & (br < 195) & (blum < 200)          # hazy lavender of a distant range
    skyish = ((bb > 176) | (blum > 170)) & ~ridgey
    if cfg.get('skyline'):
        # the traced line, raised wherever a scan finds hillside or trees above it
        top = polyline_y(pts(cfg['skyline']), W)
        tan, green, dark, navy = classify(bare_np)
        near_line = yy > (top[None, :] - 24 * k)          # crest pines are dark; the upper sky is too, so only near the trace
        solid = majority(tan | green | (dark & near_line))
        run = np.zeros(W, int); scan = np.full(W, H, int)
        for y in range(H):
            run = np.where(solid[y], run + 1, 0)
            hit = (run >= 6 * k) & (scan == H)
            scan[hit] = y - (6 * k - 1)
        # on the grass-and-trees side the scan is the truth; the trace only covers the ranges and peak
        scan = scan.astype(float)
        use_scan = (np.arange(W) < far_x) & (scan < H) & (np.abs(scan - top) < 60 * k)
        top = np.where(use_scan, scan, top)
    else:
        tan, green, dark, navy = classify(bare_np)
        hazy = (bb < 176) & (bb > br + 8) & (blum < 150) & (yy >= ridge_min_y)
        terrain = majority(tan | green | dark | navy) if cfg.get('scan_simple') else majority(tan | green | dark | navy | hazy)
        run = np.zeros(W, int); top = np.full(W, H, int)
        for y in range(H):
            run = np.where(terrain[y], run + 1, 0)
            hit = (run >= 6 * k) & (top == H)
            top[hit] = y - (6 * k - 1)
        top = top.astype(float)
    # sky-colored pixels just under the traced crest are sky (clouds resting on a ridge, gaps
    # between tree tips); the band is deeper across the distant ranges, where the snowy summits
    # are protected by the peak polygon
    band = np.where(np.arange(W) >= far_x, 48 * k, 8 * k)
    sky = skyish & (yy < top[None, :] + band[None, :]) & (~peak)
    if cfg.get('skyline'):
        # left of the ranges, everything above the first real hillside row that is not hillside is
        # sky: painted cloud tufts sitting on Sentinel's crest go with the sky
        # Sentinel's crest carries semi-transparent painted cloud. Per column, the true crest is
        # where the 9x9 window turns mostly tan; everything above it is sky, and cloud-colored
        # pixels just below it are repainted from the clean hillside further down.
        r4 = 4 * k
        tanfrac = boxcount(tan, r4, yy, xx, H, W) / float((2 * r4 + 1) ** 2)
        # the crest is searched only a little below the first solid hillside/tree row (scan), so
        # a column that goes sky, trees, meadow keeps its trees
        crest = np.array(scan, int).copy()
        for x in range(min(W, far_x)):
            lo = max(0, int(top[x]) - 40 * k); hi = min(H, int(scan[x]) + 24 * k)
            hit = np.nonzero(tanfrac[lo:hi, x] >= 0.6)[0]
            crest[x] = lo + hit[0] if len(hit) else int(scan[x])
        leftside = (np.arange(W) < far_x)[None, :]
        sky |= (yy < crest[None, :]) & leftside & (~peak) & ~(dark | green)   # crest pines may stand above the crest
        cloudy = skyish | ((bb > br + 30) & (blum > 120) & ~tan)
        strip = leftside & (yy >= crest[None, :]) & (yy < crest[None, :] + 40 * k) & cloudy & ~tan
        # repaint each strip pixel from the nearest clean tan pixel below it in the same column
        nxt = np.full((H, W), H - 1, int)
        for y in range(H - 2, -1, -1):
            nxt[y] = np.where(tan[y + 1], y + 1, nxt[y + 1])
        ys_, xs_ = np.nonzero(strip)
        src = np.minimum(H - 1, nxt[ys_, xs_] + np.random.RandomState(3).randint(0, 6 * k, len(ys_)))
        rgb[ys_, xs_] = rgb[src, xs_]
        top = np.where(leftside[0], np.minimum(top, crest), top)
        if args.debug: np.save(os.path.join(args.debug, 'crest.npy'), crest); np.save(os.path.join(args.debug, 'scan.npy'), scan); np.save(os.path.join(args.debug, 'trace.npy'), polyline_y(pts(cfg['skyline']), W))
    sky |= (yy < top[None, :] - 1) & (~peak)
    sky = majority(sky)
    # thin dark things standing on the crest (radio masts, lone pines) survive the filter
    dark_raw = blum < 80
    sky &= ~(dark_raw & (yy > top[None, :] - 70 * k) & (yy >= ridge_min_y))
    # pale patches below the crest are cloud between tree crowns (sky) or snow on a summit
    # (terrain): decide by the neighborhood, foliage around it vs rock around it
    # (judged on the scene painting: the prop-less export can differ around the props)
    tan0, green0, dark0, navy0 = classify(rgb)
    sr0, sg0, sb0 = [rgb[..., i].astype(int) for i in range(3)]
    ridgey0 = (sb0 > sr0 + 35) & (sr0 < 195) & (0.299 * sr0 + 0.587 * sg0 + 0.114 * sb0 < 200)
    # what a pale pixel rests on decides it: the first foliage or rock pixel below it in its column
    cls = np.where(green0 | dark0, 1, np.where(ridgey0 | navy0, 2, 0)).astype(np.int8)
    below = np.zeros((H, W), np.int8)
    for y in range(H - 2, -1, -1):
        below[y] = np.where(cls[y + 1] != 0, cls[y + 1], below[y + 1])
    slum0 = 0.299 * sr0 + 0.587 * sg0 + 0.114 * sb0
    skyish_s = ((sb0 > 176) | (slum0 > 170)) & ~ridgey0
    sky |= skyish_s & (below == 1) & (yy < top[None, :] + 90 * k) & (yy >= ridge_min_y)
    sky &= ~prop
    if front is not None: sky &= ~front

    # --- layers, far to near
    far_mid = polyline_y(FAR_MID, W); meadow = polyline_y(MEADOW, W)
    tan, green, dark, navy = classify(rgb)
    foliage = majority(green | dark)
    sr, sg, sb = [rgb[..., i].astype(int) for i in range(3)]
    slum = 0.299 * sr + 0.587 * sg + 0.114 * sb
    navyish = majority(navy | ((sb < 176) & (sb > sr + 8) & (slum < 150) & (yy >= ridge_min_y)) | ((sb > sr + 35) & (sr < 195) & (slum < 200) & (xx >= far_x) & (yy >= ridge_min_y)), 5)
    above_meadow = yy < meadow[None, :]
    farzone = (xx >= far_x) & (yy < far_mid[None, :]) & (~foliage if not cfg.get('far_is_forest') else True)
    if front is not None: farzone = (~front) & above_meadow   # the back painting wherever the front lets it show
    L_PEAK, L_RANGE, L_FARHILL, L_FLANK, L_TREES, L_NEAR = 1, 2, 3, 4, 5, 6
    layer = np.zeros((H, W), np.uint8)
    mid = above_meadow & ~farzone & ~peak
    layer[mid & ~foliage & (xx < farhill_x)] = L_FLANK
    layer[mid & ~foliage & (xx >= farhill_x)] = L_FARHILL
    layer[mid & foliage] = L_TREES
    if cfg.get('far_is_forest'):
        # the far range is a forested dome: everything in the far zone that is not grass is range
        layer[farzone & ~tan] = L_RANGE
        layer[farzone & tan & (xx >= farhill_x)] = L_FARHILL
        layer[farzone & tan & (xx < farhill_x)] = L_FLANK
    else:
        layer[farzone & ~navyish & (xx >= farhill_x)] = L_FARHILL
        layer[farzone & ~navyish & (xx < farhill_x)] = L_FLANK
        layer[(farzone | mid | peak) & navyish & ~foliage] = L_RANGE
    layer[peak & ~navyish] = L_PEAK
    layer[~above_meadow] = L_NEAR
    left = (layer == 0) & above_meadow
    layer[left & peak] = L_RANGE
    layer[left & ~peak & foliage] = L_TREES
    layer[left & ~peak & ~foliage & (xx < farhill_x)] = L_FLANK
    layer[left & ~peak & ~foliage & (xx >= farhill_x)] = L_FARHILL
    layer[sky] = 0
    layer[prop] = L_NEAR

    # --- materials
    q = rgb.copy(); q[sky] = 0
    r, g, b = [q[..., i].astype(int) for i in range(3)]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    tan, green, dark, navy = classify(q)
    tan_m, green_m = majority(tan), majority(green | dark)
    dirt = majority((np.abs(r - g) < 30) & (r - b > 10) & (r - b < 60) & (r > 100) & (r < 200))
    mat = np.zeros((H, W), np.uint8)
    mat[layer == L_PEAK] = 3
    mat[(layer == L_PEAK) & (lum > 182) & (sat < 0.3) & (yy < snow_max_y)] = 4
    mat[layer == L_RANGE] = 2 if cfg.get('far_is_forest') else 3   # a forested range takes canopy snow
    mat[(layer == L_FARHILL) | (layer == L_FLANK)] = 1
    mat[layer == L_TREES] = 2
    nearm = layer == L_NEAR
    mat[nearm & tan_m] = 1
    mat[nearm & dirt & ~tan_m] = 5
    mat[nearm & green_m] = 6
    mat[nearm & (mat == 0)] = 1
    mat[prop] = 7

    # --- height fraction within the layer column: 0 at the layer's bottom line, 255 at its top
    hf = np.zeros((H, W), np.float32)
    peak_top = np.minimum(top, polyline_y(PEAK[:-2], W)) if len(PEAK) >= 3 else top
    for lid, (top_line, bot_line) in {
        L_PEAK: (peak_top, far_mid), L_RANGE: (top, far_mid), L_FARHILL: (top, meadow),
        L_FLANK: (top, meadow), L_TREES: (top, meadow), L_NEAR: (meadow, np.full(W, H, float)),
    }.items():
        sel = layer == lid
        t = np.clip((bot_line[None, :] - yy) / np.maximum(bot_line[None, :] - top_line[None, :], 1), 0, 1)
        hf[sel] = t[sel]
    mask = np.stack([layer, mat, (hf * 255).astype(np.uint8)], -1)

    # --- outputs
    os.makedirs(os.path.join(ROOT, 'assets'), exist_ok=True)
    Image.fromarray(q).save(os.path.join(ROOT, 'assets/backdrop.png'), optimize=True)
    Image.fromarray(mask).save(os.path.join(ROOT, 'assets/backdrop_mask.png'), optimize=True)
    props = {}
    for pid, p in cfg['props'].items():
        props[pid] = { 'x': S(p['rect'][0]), 'y': S(p['rect'][1]), 'w': S(p['rect'][2]), 'h': S(p['rect'][3]),
                       'label': p.get('label'), 'baseY': S(p['baseY']), 'footprint': [S(p['footprint'][0]), S(p['footprint'][1])],
                       'height': S(p['height']), 'hot': p['hot'] }
    meta = {
        'w': W, 'h': H, 'horizon': S(cfg['horizon']), 'art': name,
        'props': props,
        'cork': { 'x': CORK[0], 'y': CORK[1], 'w': CORK[2] - CORK[0], 'h': CORK[3] - CORK[1] },
        'lamp': { 'x': S(cfg['lamp'][0]), 'y': S(cfg['lamp'][1]) }, 'lampPoolY': S(cfg['lamp_pool_y']),
        'views': { v: { 'cx': S(d['cx']), 'cy': S(d['cy']), 's': d['s'], 'dock': d['dock'] } for v, d in cfg['views'].items() },
        'inversionTop': S(cfg['inversion_top']), 'nearHazeY': S(cfg['near_haze_y']), 'hazeScale': cfg.get('haze_scale', 1),
        'inversionReachX': [S(v) for v in cfg['inversion_reach_x']], 'bankReachX': [S(v) for v in cfg['bank_reach_x']],
        'snowCaps': [[S(v) for v in c] for c in cfg['snow_caps']],
        'notes': [[S(n[0]), S(n[1]), S(n[2]), S(n[3]), n[4], n[5]] for n in cfg['notes']],
    }
    with open(os.path.join(ROOT, 'assets/backdrop.json'), 'w') as f: json.dump(meta, f)
    print(name, W, 'x', H, 'sky px', int(sky.sum()), 'layers', {i: int((layer == i).sum()) for i in range(7)},
          'materials', {i: int((mat == i).sum()) for i in range(8)})

    if args.debug:
        os.makedirs(args.debug, exist_ok=True)
        ov = rgb.copy()
        ov[sky] = (255, 0, 255)
        tint = {1: (255, 0, 0), 2: (255, 0, 128), 3: (255, 160, 0), 4: (255, 255, 0), 5: (0, 255, 0), 6: (0, 0, 255)}
        for lid, c in tint.items():
            sel = layer == lid
            ov[sel] = (ov[sel] * 0.6 + np.array(c) * 0.4).astype(np.uint8)
        ov[prop] = (ov[prop] * 0.5 + np.array((0, 255, 255)) * 0.5).astype(np.uint8)
        im = Image.fromarray(ov); d = ImageDraw.Draw(im)
        if len(PEAK) >= 3: d.line(PEAK[:-2], fill=(255, 255, 255))
        d.line(FAR_MID, fill=(0, 255, 255)); d.line(MEADOW, fill=(255, 128, 0))
        d.line([(x, int(top[x])) for x in range(W)], fill=(0, 0, 0))
        im.save(os.path.join(args.debug, 'overlay.png'))
        mv = np.zeros((H, W, 3), np.uint8)
        pal = {0: (0, 0, 0), 1: (200, 170, 90), 2: (40, 120, 40), 3: (120, 120, 130), 4: (240, 245, 255), 5: (130, 100, 70), 6: (110, 130, 80), 7: (0, 200, 220)}
        for m, c in pal.items(): mv[mat == m] = c
        Image.fromarray(mv).save(os.path.join(args.debug, 'materials.png'))
        Image.fromarray(mask[..., 2]).save(os.path.join(args.debug, 'height.png'))
        Image.fromarray(q).save(os.path.join(args.debug, 'backdrop_preview.png'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
