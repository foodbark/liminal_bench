#!/usr/bin/env python3
"""Cut the cumulus in the config's "clouds" list out of the user's photographs into one sprite sheet.
  python3 tools/build_clouds.py [--art NAME]
Each entry of "clouds" in art/NAME.json names a photo under art/ and the cloud in it:
  {"photo": "clouds/cumulus_01.jpg", "box": [fx0, fy0, fx1, fy1], "clip": true, "scale": 0.4, "far": false}
box picks the cloud (fractions of the frame), clip also cuts along the box for a cloud joined to
its neighbors (tools/cut_cloud.py), scale is sprite pixels per photo pixel, far marks a small
cloud for the rows near the cloud horizon. Each cut-out goes through tools/pixelate.py as a
cloud. Writes assets/clouds.png (the sprites stacked top to bottom) and assets/clouds.json
(their rectangles), and the half-size copies in assets/small/. No drawing: every sprite pixel is
an average of the photo's own pixels.
"""
import argparse, json, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def halve(im):
    """Average 2x2 blocks of premultiplied color; a half pixel is kept where at least half of its block was cloud."""
    h, w = im.shape[:2]
    im = np.pad(im, ((0, h % 2), (0, w % 2), (0, 0)))
    f = im.astype(np.float64); a = f[..., 3:] / 255
    pre = np.concatenate([f[..., :3] * a, a], -1).reshape(im.shape[0] // 2, 2, im.shape[1] // 2, 2, 4).mean((1, 3))
    keep = pre[..., 3] >= 0.5
    out = np.zeros(pre.shape[:2] + (4,), np.uint8)
    out[..., :3] = (pre[..., :3] / np.maximum(pre[..., 3:], 1e-6) + 0.5).clip(0, 255).astype(np.uint8)
    out[~keep, :3] = 0; out[..., 3] = keep * 255
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--art', help='config name (default: art/current)')
    a = ap.parse_args()
    name = a.art or open(os.path.join(ROOT, 'art', 'current')).read().strip()
    cfg = json.load(open(os.path.join(ROOT, 'art', name + '.json')))
    entries = cfg.get('clouds')
    if not entries: sys.exit(f'no "clouds" in art/{name}.json')
    tmp = tempfile.mkdtemp(prefix='clouds-')
    sprites = []
    for i, e in enumerate(entries):
        cut, out = os.path.join(tmp, f'cut{i}.png'), os.path.join(tmp, f'sprite{i}.png')
        cmd = [sys.executable, '-I', os.path.join(ROOT, 'tools/cut_cloud.py'), os.path.join(ROOT, 'art', e['photo']), cut, '--box', ','.join(str(v) for v in e['box'])]
        if e.get('clip'): cmd.append('--clip')
        if 'sky' in e: cmd += ['--sky', str(e['sky'])]
        if 'cloud' in e: cmd += ['--cloud', str(e['cloud'])]
        if subprocess.run(cmd).returncode:
            print(f'  skipped cloud {i} ({e["photo"]} {e["box"]}): the cut failed, see above'); continue
        width = max(16, round(Image.open(cut).width * e.get('scale', 0.4) / 4) * 4)
        subprocess.run([sys.executable, os.path.join(ROOT, 'tools/pixelate.py'), cut, out, '--as', 'cloud', '--width', str(width)], check=True)
        im = np.asarray(Image.open(out).convert('RGBA'))
        ys, xs = np.nonzero(im[..., 3] > 0)
        im = im[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        sprites.append((im, e))
    W = max(s.shape[1] for s, _ in sprites); H = sum(s.shape[0] for s, _ in sprites) + 2 * (len(sprites) - 1)
    sheet = np.zeros((H, W, 4), np.uint8); rects = []; y = 0
    for im, e in sprites:
        h, w = im.shape[:2]
        sheet[y:y + h, :w] = im
        rects.append({'x': 0, 'y': y, 'w': w, 'h': h, 'far': bool(e.get('far')), 'photo': e['photo']})
        y += h + 2
    Image.fromarray(sheet, 'RGBA').save(os.path.join(ROOT, 'assets/clouds.png'), optimize=True)
    with open(os.path.join(ROOT, 'assets/clouds.json'), 'w') as f: json.dump({'sprites': rects}, f)
    small = os.path.join(ROOT, 'assets/small'); os.makedirs(small, exist_ok=True)
    Image.fromarray(halve(sheet), 'RGBA').save(os.path.join(small, 'clouds.png'), optimize=True)
    with open(os.path.join(small, 'clouds.json'), 'w') as f:
        json.dump({'sprites': [{**r, 'x': r['x'] // 2, 'y': r['y'] // 2, 'w': (r['w'] + 1) // 2, 'h': (r['h'] + 1) // 2} for r in rects]}, f)
    for r in rects: print(f"  {r['photo']}: {r['w']}x{r['h']}{' far' if r['far'] else ''}")
    print(f'assets/clouds.png {W}x{H}, {len(rects)} clouds')


if __name__ == '__main__':
    main()
