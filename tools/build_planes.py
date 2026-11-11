#!/usr/bin/env python3
"""The low traffic's planes, cut from the user's photographs.

  python3 tools/build_planes.py [--debug DIR]

Reads art/planes/planes.json: a list of frames, each a crop of a photograph or a video frame
with one aircraft against open sky and a margin of sky all round, with what it is (`kind`: jet
or prop), which way its nose points in the frame (`faces`), how it is turned to the camera
(`aspect`, degrees: 0 coming straight at us, 90 side-on, 180 going straight away) and how wide
its sprite is at full size (`width`, pixels), with the airframe it belongs to (`model`) and the
traffic it stands for (`airlines`: callsign prefixes; `types`: ICAO type codes). For each frame:

  - the sky is keyed out: a plane fitted through the margin's pixels is the sky's color across
    the crop, anything far from it is aircraft, the biggest piece and its near neighbours are
    kept, the sky seen through a gap inside the outline stays aircraft, and one pixel comes off
    the edge, where a phone's sharpening leaves a pale halo;
  - it is graded: a video in HDR decodes flat and blue, so the brightest of the airframe goes
    to a near white and the darkest to a near black, all three channels by the same two points
    per channel (the photo's own pixels, moved, never painted);
  - tools/pixelate.py sets it as shaded pixel art with no ink and six tones (the user's pick,
    2026-11-11, over an inked four-tone version and a plain average), at the full width and at
    a half and a quarter of it, each from the photograph and not from the bigger sprite, so a
    plane drawn small on the page is an average of the photo and not every fourth pixel.

Writes assets/planes.png and planes.json ({ sprites: [{ kind, faces, aspect, model, airlines,
types, x, y, w, h, levels: [{ x, y, w, h }, ...] }] }, x/y/w/h the full-size level) and the same at half size in
assets/small/. src/render/flights.js picks the frame nearest a plane's turn to the bench.
"""
import argparse, json, os, subprocess, sys, tempfile
from collections import deque
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'art/planes')


def pieces(mask):
    """4-connected components of a small mask: the label image and each label's size."""
    h, w = mask.shape; lab = np.zeros((h, w), int); sizes = [0]
    for y, x in zip(*np.where(mask)):
        if lab[y, x]: continue
        n = len(sizes); q = deque([(y, x)]); lab[y, x] = n; c = 0
        while q:
            cy, cx = q.popleft(); c += 1
            for yy, xx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not lab[yy, xx]: lab[yy, xx] = n; q.append((yy, xx))
        sizes.append(c)
    return lab, sizes


def cut(path, shave=1):
    """The aircraft out of its sky, graded: RGBA, cropped to the aircraft."""
    c = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    h, w, _ = c.shape
    yy, xx = np.mgrid[0:h, 0:w]
    b = np.zeros((h, w), bool); b[:6] = b[-6:] = True; b[:, :6] = b[:, -6:] = True
    A = np.c_[xx[b], yy[b], np.ones(b.sum())]; full = np.c_[xx.ravel(), yy.ravel(), np.ones(h * w)]
    sky = np.stack([(full @ np.linalg.lstsq(A, c[..., k][b], rcond=None)[0]).reshape(h, w) for k in range(3)], -1)
    dist = np.sqrt(((c - sky) ** 2).sum(2))
    noise = dist[b].mean() + dist[b].std()
    m = dist > max(14, 3.2 * noise)
    lab, sizes = pieces(m); big = int(np.argmax(sizes))
    ys, xs = np.where(lab == big); pad = 12
    near = np.zeros_like(m); near[max(0, ys.min() - pad):ys.max() + pad, max(0, xs.min() - pad):xs.max() + pad] = True
    keep = np.zeros_like(m)
    for i, sz in enumerate(sizes):   # the airframe, and a wheel or a wingtip the key split off it
        if i and (i == big or (sz > 40 and (near & (lab == i)).any())): keep |= lab == i
    lab2, _ = pieces(~keep); outside = set(lab2[0]) | set(lab2[-1]) | set(lab2[:, 0]) | set(lab2[:, -1])
    keep |= ~keep & ~np.isin(lab2, list(outside))
    e = keep
    for _ in range(shave):   # a still's halo is wider than a video frame's: the config's `shave`, in pixels
        k = e; e = k.copy(); e[1:] &= k[:-1]; e[:-1] &= k[1:]; e[:, 1:] &= k[:, :-1]; e[:, :-1] &= k[:, 1:]
    p = c[e]; lum = p @ [.299, .587, .114]
    hi = p[lum >= np.percentile(lum, 96)].mean(0); lo = np.percentile(lum, 1.5)
    g = ((c - lo) / (hi - lo) * 235 + 12).clip(0, 255)
    out = np.dstack([g.astype(np.uint8), (e * 255).astype(np.uint8)])
    ys, xs = np.where(e)
    return out[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def pixelate(cutout, width, tmp):
    src = os.path.join(tmp, 'cut.png'); dst = os.path.join(tmp, f'px_{width}.png')
    Image.fromarray(cutout, 'RGBA').save(src)
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools/pixelate.py'), src, dst, '--as', 'prop', '--pixel', '1', '--width', str(width),
                        '--ink', '0', '--pop', '0', '--flatten', '0', '--steps', '6'], capture_output=True, text=True)
    if r.returncode: sys.exit('pixelate failed on ' + src + '\n' + r.stderr)
    return Image.open(dst).convert('RGBA')


def sheet(frames, scale, tmp, debug=None):
    """All the frames' levels packed in rows: the image and the sprites' boxes."""
    rows = []
    for i, f in enumerate(frames):
        cutout = cut(os.path.join(SRC, f['file']), f.get('shave', 1))
        if debug and scale == 1: Image.fromarray(cutout, 'RGBA').save(os.path.join(debug, f'plane_{i}_cut.png'))
        w0 = max(8, round(f['width'] * scale))
        rows.append((f, [pixelate(cutout, max(6, round(w0 / k)), tmp) for k in (1, 2, 4)]))
    W = max(sum(im.width + 1 for im in ims) for _, ims in rows) + 1
    H = sum(ims[0].height + 1 for _, ims in rows) + 1
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0)); sprites = []; y = 1
    for f, ims in rows:
        x = 1; levels = []
        for im in ims:
            out.paste(im, (x, y)); levels.append({'x': x, 'y': y, 'w': im.width, 'h': im.height}); x += im.width + 1
        sprites.append({'kind': f['kind'], 'faces': f.get('faces', 'right'), 'aspect': f['aspect'], 'model': f.get('model', f['file']),
                        'airlines': f.get('airlines', []), 'types': f.get('types', []), **levels[0], 'levels': levels})
        y += ims[0].height + 1
    return out, sprites


def main():
    ap = argparse.ArgumentParser(description='cut the plane sprites from art/planes')
    ap.add_argument('--debug', help='a folder for the keyed cut-outs, to look at')
    a = ap.parse_args()
    if a.debug: os.makedirs(a.debug, exist_ok=True)
    frames = json.load(open(os.path.join(SRC, 'planes.json')))['frames']
    with tempfile.TemporaryDirectory() as tmp:
        for scale, folder in ((1, 'assets'), (0.5, 'assets/small')):
            im, sprites = sheet(frames, scale, tmp, a.debug)
            im.save(os.path.join(ROOT, folder, 'planes.png'), optimize=True)
            with open(os.path.join(ROOT, folder, 'planes.json'), 'w') as f: json.dump({'sprites': sprites}, f)
            print(folder, im.size, [(s['model'], s['aspect'], s['w'], s['h']) for s in sprites])


if __name__ == '__main__':
    main()
