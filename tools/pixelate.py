#!/usr/bin/env python3
"""Turn a photograph into shaded pixel art for the scene. No model, no generated pixels: every
output pixel is an average of the photo's own pixels, snapped to a palette taken from the photo.

  python3 tools/pixelate.py PHOTO OUT.png [--as mountain|trees|prop|photo] [--size WxH | --width W]
                            [--pixel N] [--flatten N] [--hues N] [--steps N] [--shift K] [--ink K]
                            [--dither K] [--pop K] [--colors N]
                            [--crop x0,y0,x1,y1] [--focus fx,fy] [--matte r,g,b]

Representation first, then beauty. The photo is cropped, never stretched; the palette is picked
from the photo with rare colors given extra weight, so a red phone or a strip of summit snow
keeps its own color instead of being averaged into its surroundings. The drawn, lo-fi feel comes
from flat shapes and short color ramps, not from bigger pixels.

--as picks the starting values for what the photo is of; any option given overrides them:

  mountain   far slopes: flattened hard into tone bands, few hues, dither across the slow
             gradients, no ink (distant things have no outlines)
  trees      foreground trees: foliage gathered into shadow, body and light masses, inked
             only around a cut-out's silhouette (ink inside foliage turns to speckle), no dither
  prop       built things: barely flattened so thin parts and lettering survive, more hues,
             inked, no dither
  photo      no drawing at all: a free palette of --colors and dither everywhere

  --size WxH   output size; the photo is cropped to that aspect around --focus. Default: the
               "ref" size of the config named in art/current (the scene's size).
  --width W    output width instead, height following the photo's aspect (for a prop on its own).
  --pixel N    each art pixel is N x N output pixels (default 4; keep it even, so the half-size
               phone copy of the scene still has whole art pixels).
  --flatten N  passes of an edge-keeping blur over the art pixels: texture inside a shape settles
               to one tone, and anything that differs enough from its surroundings (a ridge, a
               pole, a letter) is left alone.
  --hues N     the palette is N hue families found in the photo, each a ramp of --steps tones
               from its darkest to its lightest. 0 = a free palette of --colors instead.
  --shift K    ramps lean cool in their shadows and warm in their lights (0 = same hue throughout).
  --ink K      a darker line of the same hue on the dark side of every strong edge; bigger K inks
               weaker edges (0 = none). Trees and props always get the line around a cut-out's silhouette.
  --dither K   ordered 4x4 Bayer dither between neighboring tones, held back from edges (0 = flat).
  --pop K      contrast and saturation lift, 0 = the photo as shot (default 1).
  --crop       box in the photo's pixels, applied before anything else.
  --focus      where the aspect crop sits, as fractions of the spare room (default 0.5,0.5).
  --matte      a cut-out photo (PNG with alpha) keeps a hard-edged alpha; this flattens it onto a
               color instead, e.g. 0,0,0 for the build's props-on-black and close-up paintings.
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAYER4 = (np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) + 0.5) / 16
PRESETS = {
    'mountain': dict(flatten=2, hues=6, steps=5, shift=1.0, ink=0.0, dither=0.3, rim=False),
    'trees':    dict(flatten=3, hues=4, steps=5, shift=1.0, ink=0.0, dither=0.0, rim=True),
    'prop':     dict(flatten=1, hues=8, steps=4, shift=0.5, ink=1.0, dither=0.0, rim=True),
    'photo':    dict(flatten=0, hues=0, steps=0, shift=0.0, ink=0.0, dither=0.4, rim=False),
}


def to_oklab(rgb):
    """sRGB 0..1 -> Oklab, where equal distances look like equal differences."""
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return np.stack([0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                     1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                     0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s], -1)


def from_oklab(lab):
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    lin = np.stack([4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s], -1).clip(0, 1)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)


def pop(lab, k):
    """Stretch the lightness to the full range, lift a dim photo to a daylight middle, add a gentle
    S-curve, deepen the chroma. Hue is untouched. The renderer supplies the dusk and the night,
    so what it wants from a photo is the place in plain bright daylight."""
    if k <= 0: return lab
    L = lab[..., 0]
    lo, hi = np.percentile(L, [0.5, 99.5])
    t = ((L - lo) / max(hi - lo, 1e-6)).clip(0, 1)
    med = np.median(t)
    if 0 < med < 0.45: t = t ** (np.log(0.45) / np.log(med))    # only ever brightens
    t = t + 0.25 * k * (t * t * (3 - 2 * t) - t)
    out = lab.copy()
    out[..., 0] = L + min(k, 1) * ((0.16 + t * 0.81) - L)       # off pure black and pure white so the light has room
    out[..., 1:] *= 1 + 0.35 * k
    return out


def neighbors(a, r=1, mode='edge'):
    """Yield (dy, dx, a shifted so each pixel sees its neighbor at that offset)."""
    H, W = a.shape[:2]
    p = np.pad(a, ((r, r), (r, r)) + ((0, 0),) * (a.ndim - 2), mode=mode)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dy or dx: yield dy, dx, p[r + dy:r + dy + H, r + dx:r + dx + W]


def flatten(lab, solid, passes, r=2, tol=0.025):
    """Bilateral blur: each art pixel moves toward the neighbors that already look like it and
    ignores the ones that do not, so shapes go flat and their edges stay exactly where they were."""
    for _ in range(passes):
        acc = lab.copy(); wsum = np.ones(lab.shape[:2])
        for (dy, dx, nb), (_, _, ok) in zip(neighbors(lab, r), neighbors(solid, r, 'constant')):
            w = np.exp(-((nb - lab) ** 2).sum(2) / (2 * tol * tol) - (dx * dx + dy * dy) / (2.0 * r * r)) * ok
            acc += nb * w[..., None]; wsum += w
        lab = acc / wsum[..., None]
    return lab


def distinct(lab):
    """The photo's distinct colors and a weight each. count^0.6 instead of count lets a small
    accent hold its place against a large field of grass or forest."""
    q = (from_oklab(lab) * 31 + 0.5).astype(np.int32)
    key = (q[:, 0] << 10) | (q[:, 1] << 5) | q[:, 2]
    _, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
    return np.stack([np.bincount(inv, lab[:, i]) / cnt for i in range(3)], -1), cnt ** 0.6


def kmeans(pts, wt, n):
    n = min(n, len(pts))
    rs = np.random.RandomState(9)
    cen = [pts[np.argmax(wt)]]
    d = ((pts - cen[0]) ** 2).sum(1)
    for _ in range(n - 1):                                        # k-means++ seeding
        if not (d * wt).sum() > 0: break
        cen.append(pts[rs.choice(len(pts), p=d * wt / (d * wt).sum())])
        d = np.minimum(d, ((pts - cen[-1]) ** 2).sum(1))
    cen = np.array(cen)
    for _ in range(24):
        near = ((pts[:, None] - cen[None]) ** 2).sum(2).argmin(1)
        for j in range(len(cen)):
            m = near == j
            if m.any(): cen[j] = (pts[m] * wt[m, None]).sum(0) / wt[m].sum()
    return cen, near


def ramp_palette(lab, hues, steps, shift):
    """Hue families from the photo (clustered on hue and chroma, not lightness, so dark and light
    forest are one family), each laid out as evenly spaced tones between its own darkest and lightest. Returns
    the palette as rows of [ink, tone 1 .. tone steps] per family; ink is the darkest tone deepened."""
    pts, wt = distinct(lab)
    # Square-rooting the chroma spreads the muted colors apart, or a dull forest green and a
    # dull brown both fall in with gray while one vivid field of grass takes every family.
    c = np.hypot(pts[:, 1], pts[:, 2])[:, None]
    _, fam = kmeans(pts[:, 1:] / np.sqrt(np.maximum(c, 1e-4)), wt, hues)
    rows = []
    for f in np.unique(fam):
        p, w = pts[fam == f], wt[fam == f]
        o = np.argsort(p[:, 0]); cw = np.cumsum(w[o]) / w.sum()
        lo, hi = p[o][np.searchsorted(cw, [0.03, 0.97]).clip(0, len(p) - 1), 0]
        mean = (p * w[:, None]).sum(0) / w.sum()
        ramp = []
        for i in range(steps):
            t = (i + 0.5) / steps
            L = lo + (hi - lo) * t
            m = np.abs(p[:, 0] - L) <= max((hi - lo) / steps, 0.02)
            ab = (p[m, 1:] * w[m, None]).sum(0) / w[m].sum() if m.any() else mean[1:]
            ab = ab + shift * (t - 0.5) * np.array([0.012, 0.035])   # lights toward warm yellow, shadows toward blue
            ramp.append([L, ab[0], ab[1]])
        ink = [ramp[0][0] * 0.62, ramp[0][1] * 0.9, ramp[0][2] * 0.9 - 0.01 * shift]
        rows.append([ink] + ramp)
    return np.array(rows)


def snap(lab, pal, dither, calm):
    """Nearest palette color per pixel, after pushing the lightness up or down by the Bayer
    threshold so a tone between two palette colors becomes a pattern of both. `calm` is 1 where
    the picture is smooth and 0 on edges, which stay undithered."""
    H, W = lab.shape[:2]
    gap = np.sqrt(((pal[:, None] - pal[None]) ** 2).sum(2) + np.eye(len(pal)) * 9)
    spread = np.median(gap.min(1))
    th = (np.tile(BAYER4, (H // 4 + 1, W // 4 + 1))[:H, :W] - 0.5) * spread * dither * 2 * calm
    out = np.empty((H, W), np.int32)
    for y in range(0, H, 64):
        px = lab[y:y + 64].copy(); px[..., 0] += th[y:y + 64]
        out[y:y + 64] = ((px[:, :, None] - pal[None, None]) ** 2).sum(3).argmin(2)
    return out


def edges(lab, solid):
    """Per pixel: how far its most different 4-neighbor is, and whether it is the darker of the two."""
    far = np.zeros(lab.shape[:2]); darker = np.zeros(lab.shape[:2], bool); rim = np.zeros(lab.shape[:2], bool)
    for (dy, dx, nb), (_, _, ok) in zip(neighbors(lab), neighbors(solid)):      # the frame's edge is not a silhouette
        if dy and dx: continue
        d = np.sqrt(((nb - lab) ** 2).sum(2)) * ok
        darker = np.where(d > far, lab[..., 0] < nb[..., 0], darker); far = np.maximum(far, d)
        rim |= ~ok
    return far, darker, rim & solid


def scene_size():
    name = open(os.path.join(ROOT, 'art', 'current')).read().strip()
    return tuple(json.load(open(os.path.join(ROOT, 'art', name + '.json')))['ref'])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('photo'); ap.add_argument('out')
    ap.add_argument('--as', dest='kind', choices=list(PRESETS), default='mountain')
    ap.add_argument('--size', help='WxH (default: the current scene size)')
    ap.add_argument('--width', type=int, help='output width, height from the photo')
    ap.add_argument('--pixel', type=int, default=4)
    for k in ('flatten', 'hues', 'steps'): ap.add_argument('--' + k, type=int)
    for k in ('shift', 'ink', 'dither'): ap.add_argument('--' + k, type=float)
    ap.add_argument('--colors', type=int, default=48)
    ap.add_argument('--pop', type=float, default=1.0)
    ap.add_argument('--crop', help='x0,y0,x1,y1 in photo pixels')
    ap.add_argument('--focus', default='0.5,0.5')
    ap.add_argument('--matte', help='r,g,b to flatten a cut-out onto')
    a = ap.parse_args()
    for k, v in PRESETS[a.kind].items():
        if getattr(a, k, None) is None: setattr(a, k, v)

    im = ImageOps.exif_transpose(Image.open(a.photo)).convert('RGBA')
    if a.crop: im = im.crop(tuple(int(v) for v in a.crop.split(',')))
    p = a.pixel
    if a.width:
        W, H = a.width, round(a.width * im.height / im.width / p) * p
    else:
        W, H = (int(v) for v in a.size.lower().split('x')) if a.size else scene_size()
        fx, fy = (float(v) for v in a.focus.split(','))
        k = min(im.width / W, im.height / H)                      # crop to the aspect, never stretch
        cw, ch = round(W * k), round(H * k)
        x0, y0 = round((im.width - cw) * fx), round((im.height - ch) * fy)
        im = im.crop((x0, y0, x0 + cw, y0 + ch))
    if W % p or H % p: sys.exit(f'{W}x{H} is not a multiple of --pixel {p}')
    gw, gh = W // p, H // p
    if im.width < gw: print(f'warning: the photo is {im.width} wide, smaller than the {gw}-wide pixel grid; it will be soft')

    # BOX averages every photo pixel under an art pixel; alpha is premultiplied so a cut-out's
    # edge pixels take the color of the object, not of whatever was erased around it.
    src = np.asarray(im, np.float64) / 255
    pre = np.concatenate([src[..., :3] * src[..., 3:], src[..., 3:]], -1)
    small = np.stack([np.asarray(Image.fromarray(pre[..., i].astype(np.float32), 'F').resize((gw, gh), Image.BOX))
                      for i in range(4)], -1).astype(np.float64)
    solid = small[..., 3] >= 0.5
    if not solid.any(): sys.exit('nothing opaque in the photo')
    rgb = (small[..., :3] / np.maximum(small[..., 3:], 1e-6)).clip(0, 1)

    lab = to_oklab(rgb)
    lab[solid] = pop(lab[solid], a.pop)
    lab = flatten(lab, solid, a.flatten)
    far, darker, rim = edges(lab, solid)
    calm = 1 - ((far - 0.02) / 0.04).clip(0, 1)
    if a.hues:
        rows = ramp_palette(lab[solid], a.hues, a.steps, a.shift)
        n = rows.shape[1]
        tones = rows[:, 1:].reshape(-1, 3)
        idx = snap(lab, tones, a.dither, calm)
        idx = idx // (n - 1) * n + idx % (n - 1) + 1              # index into the palette with inks
        line = rim & a.rim                                        # a cut-out's silhouette
        if a.ink > 0: line = line | (darker & (far > 0.09 / a.ink))
        idx[line] = idx[line] // n * n                            # the family's ink
        pal = rows.reshape(-1, 3)
    else:
        pal = kmeans(*distinct(lab[solid]), a.colors)[0]
        idx = snap(lab, pal, a.dither, calm)
    out = np.zeros((gh, gw, 4), np.uint8)
    out[..., :3] = (from_oklab(pal) * 255 + 0.5).astype(np.uint8)[idx]
    out[..., 3] = solid * 255
    if a.matte:
        out[~solid, :3] = [int(v) for v in a.matte.split(',')]; out[..., 3] = 255
    elif not solid.all():
        out[~solid, :3] = 0
    out = out.repeat(p, 0).repeat(p, 1)
    Image.fromarray(out if not solid.all() and not a.matte else out[..., :3]).save(a.out)
    used = len(np.unique(idx[solid]))
    print(f'{a.photo} -> {a.out}  as {a.kind}: {W}x{H}, {gw}x{gh} art pixels, {used} colors')


if __name__ == '__main__':
    main()
