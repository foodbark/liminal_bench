#!/usr/bin/env python3
"""Cut the cumulus in the config's "clouds" list out of the user's photographs into one sprite sheet.
  python3 tools/build_clouds.py [--art NAME]
Each entry of "clouds" in art/NAME.json names a photo under art/ and the cloud in it:
  {"photo": "clouds/cumulus_01.jpg", "box": [fx0, fy0, fx1, fy1], "clip": true, "scale": 0.4, "far": false}
box picks the cloud (fractions of the frame), clip also cuts along the box for a cloud joined to
its neighbors, all keeps every cloud in the box (tools/cut_cloud.py), scale is sprite pixels per photo pixel, far marks a small
cloud for the rows near the cloud horizon, cb a cumulonimbus (the storm's cell, never in the cumulus pools),
lobes that the cloud also feeds the lobe library: its pixelated sprite is split along its creases
(tools/lobes.py) into lobes that share its palette, packed into assets/lobes.png and lobes.json,
for the page to build cumulus from by the drawn clouds' grammar. Each cut-out goes through tools/pixelate.py as a
cloud. Writes assets/clouds.png (the sprites stacked top to bottom) and assets/clouds.json
(their rectangles), and the half-size copies in assets/small/. No drawing: every sprite pixel is
an average of the photo's own pixels.
"""
import argparse, json, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageOps
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lobes import segment
from cut_cloud import key_sky, despill
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


def label_cells(mask, s=4):
    """4-connected components of a mask on a coarse grid of s-pixel cells: the label grid (0 none) and the cell count per label."""
    H, W = mask.shape
    small = mask[:H // s * s, :W // s * s].reshape(H // s, s, W // s, s).mean((1, 3)) > 0.5
    labels = np.zeros(small.shape, np.int32); sizes = [0]; n = 0
    for sy, sx in zip(*np.nonzero(small)):
        if labels[sy, sx]: continue
        n += 1; labels[sy, sx] = n; stack = [(sy, sx)]; cnt = 0
        while stack:
            y, x = stack.pop(); cnt += 1
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < small.shape[0] and 0 <= nx < small.shape[1] and small[ny, nx] and not labels[ny, nx]:
                    labels[ny, nx] = n; stack.append((ny, nx))
        sizes.append(cnt)
    return labels, sizes


def build_cirrus(cfg, small):
    """Cirrus tiles from photographs (the config's "fields" entries of type "cirrus"): the whole
    frame keyed against the sky's own blueness row by row (cirrus is thin, and the clouds' key,
    set for a cumulus against blue, left all of it as sky), the key's soft alpha averaged onto
    the art grid and kept as the tile's alpha: how dense the cirrus is in each cell, from haze
    to core. The page (drawField in src/render/photoclouds.js) repeats the tile across the sky
    and turns density into the hour's veil tones, the feed's high cover deciding how thin a
    density still shows. No color is kept: cirrus is white, its only color the sky's and the
    sun's, which the page puts on. assets/cirrus.png and cirrus.json, halved by averaging for
    assets/small (the clouds' halve snaps alpha, which a translucent tile cannot take)."""
    entries = [e for e in (cfg.get('fields') or []) if e.get('type') == 'cirrus']
    if not entries: return
    tiles = []; rects = []
    for e in entries:
        im = ImageOps.exif_transpose(Image.open(os.path.join(ROOT, 'art', e['photo']))).convert('RGB')
        W, H = im.size
        fx0, fy0, fx1, fy1 = e.get('box', [0, 0, 1, 1])
        x0, y0, x1, y1 = int(fx0 * W), int(fy0 * H), int(fx1 * W), int(fy1 * H)
        px = np.asarray(im, np.float64)[y0:y1, x0:x1]
        r, b = px[..., 0], px[..., 2]
        bl = (b - r) / np.maximum(b, 1)
        # the sky behind the cirrus, row by row: the upper end of each row's blueness, smoothed
        rows = np.percentile(bl, 80, axis=1)
        k = 201; bg = np.convolve(np.pad(rows, k // 2, mode='edge'), np.ones(k) / k, mode='valid')
        span = e.get('span', 0.2)   # how far below the sky's blueness a cell is wholly cirrus
        a = np.clip((bg[:, None] - bl) / span, 0, 1)
        scale = e.get('scale', 0.25)
        cs = max(2, round(4 / scale))   # photo pixels per art cell: a cell is 4 page pixels
        gh, gw = a.shape[0] // cs, a.shape[1] // cs
        A = a[:gh * cs, :gw * cs].reshape(gh, cs, gw, cs).mean((1, 3))
        tile = np.zeros((gh * 4, gw * 4, 4), np.uint8); tile[..., :3] = 255
        tile[..., 3] = (A * 255 + 0.5).astype(np.uint8).repeat(4, 0).repeat(4, 1)
        tiles.append(tile)
        print(f"  cirrus {e['photo']}: {gw}x{gh} cells, {round(float((A >= 0.12).mean()) * 100)}% of the sky has cirrus at or over haze density")
    Wt = max(t.shape[1] for t in tiles); Ht = sum(t.shape[0] for t in tiles) + 2 * (len(tiles) - 1)
    sheet = np.zeros((Ht, Wt, 4), np.uint8); y = 0
    for t, e in zip(tiles, entries):
        h, w = t.shape[:2]; sheet[y:y + h, :w] = t
        rects.append({'x': 0, 'y': y, 'w': w, 'h': h, 'photo': e['photo'], 'scale': e.get('scale', 0.25), 'dy': e.get('dy', 0)}); y += h + 2   # dy: where the tile's top goes, as a fraction of its height (a photo shot looking up has its band low in the frame)
    Image.fromarray(sheet, 'RGBA').save(os.path.join(ROOT, 'assets/cirrus.png'), optimize=True)
    with open(os.path.join(ROOT, 'assets/cirrus.json'), 'w') as f: json.dump({'tiles': rects}, f)
    # the half-size copy averages 2x2 blocks (the sheet's rows and columns are even: cells of 4)
    h2, w2 = sheet.shape[0] // 2 * 2, sheet.shape[1] // 2 * 2
    sm = sheet[:h2, :w2].reshape(h2 // 2, 2, w2 // 2, 2, 4).astype(np.float64).mean((1, 3))
    sm[..., :3] = 255
    Image.fromarray((sm + 0.5).astype(np.uint8), 'RGBA').save(os.path.join(small, 'cirrus.png'), optimize=True)
    with open(os.path.join(small, 'cirrus.json'), 'w') as f:
        json.dump({'tiles': [{**r, 'x': r['x'] // 2, 'y': r['y'] // 2, 'w': r['w'] // 2, 'h': r['h'] // 2} for r in rects]}, f)
    print(f'assets/cirrus.png {Wt}x{Ht}, {len(rects)} cirrus tile(s)')


def build_fields(cfg, tmp, small):
    """A cloud field from one photograph (the config's "fields": a photo, the box of sky that holds
    the field, the photo's horizon as a fraction of its height, and the sprite scale): every
    cloudlet in the box is keyed and cut on its own, pixelated as a cloud, and packed into
    assets/field.png with where it sat in the photo's sky (u across the frame, v from the top of
    the box down to the horizon) and how crowded its neighborhood was, so the page can lay the
    field out by the photo's own arrangement and thin it by the feed's cover (src/render/photoclouds.js).
    The drawn altocumulus was identical ovals on a grid; a real field is cloudlets of every size
    in irregular rippled rows with open sky between them, which is what the photo has."""
    fields = [e for e in (cfg.get('fields') or []) if e.get('type', 'alto') != 'cirrus']
    pieces = []
    for fi, e in enumerate(fields):
        im = ImageOps.exif_transpose(Image.open(os.path.join(ROOT, 'art', e['photo']))).convert('RGB')
        W, H = im.size
        fx0, fy0, fx1, fy1 = e['box']
        x0, y0, x1, y1 = int(fx0 * W), int(fy0 * H), int(fx1 * W), int(fy1 * H)
        px = np.asarray(im, np.float64)
        alpha, blueness, sky = key_sky(px, x0, y0, x1, y1, e.get('cloud', 0.28), e.get('sky'))
        px = despill(px, alpha, blueness, sky)
        inbox = np.zeros(alpha.shape, bool); inbox[y0:y1, x0:x1] = True
        # the photo's horizon: one fraction of the height, or a polyline of [u, y] fractions
        # where hills rise into the box (they are not blue, so they key as cloud); nothing
        # below it is a cloudlet, and v is measured to it column by column
        hz = e.get('horizon', fy1)
        if isinstance(hz, list):
            us = np.array([p[0] for p in hz]) * W; vs = np.array([p[1] for p in hz]) * H
            hline = np.interp(np.arange(W), us, vs)
        else: hline = np.full(W, hz * H)
        inbox &= np.arange(H)[:, None] < hline[None, :]
        core = (alpha >= 0.6) & inbox
        labels, sizes = label_cells(core)
        s4 = 4; minpx = e.get('min', 300)
        # The whole band is pixelated as one image, one palette and one lift for the field, and
        # the cloudlets are sliced out of it afterward by their labels: pixelated one by one,
        # each cloudlet's own brightest pixel went to white and its bit of shade was stretched
        # toward it, and the field came out as white blobs with no mass (the user, 2026-10-20);
        # together, a cloudlet in shade stays gray beside one in sun, as the photo had them.
        keep = [k for k in range(1, len(sizes)) if sizes[k] * s4 * s4 >= minpx]
        kept = np.isin(labels, keep)
        grown = kept.copy(); grown[1:] |= kept[:-1]; grown[:-1] |= kept[1:]; grown[:, 1:] |= kept[:, :-1]; grown[:, :-1] |= kept[:, 1:]
        own = np.zeros(alpha.shape, bool); own[:grown.shape[0] * s4, :grown.shape[1] * s4] = grown.repeat(s4, 0).repeat(s4, 1)
        band = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
        band[..., :3] = px[y0:y1, x0:x1].astype(np.uint8); band[..., 3] = (np.where(own, alpha, 0)[y0:y1, x0:x1] * 255 + 0.5).astype(np.uint8)
        cpath, opath = os.path.join(tmp, f'field{fi}.png'), os.path.join(tmp, f'fieldsprite{fi}.png')
        Image.fromarray(band).save(cpath)
        scale = e.get('scale', 0.4)
        width = max(16, round((x1 - x0) * scale / 4) * 4)
        subprocess.run([sys.executable, os.path.join(ROOT, 'tools/pixelate.py'), cpath, opath, '--as', 'cloud', '--width', str(width)] + (['--lift', str(e['lift'])] if 'lift' in e else []), check=True, stdout=subprocess.DEVNULL)
        sp = np.asarray(Image.open(opath).convert('RGBA'))
        gh, gw = sp.shape[0] // 4, sp.shape[1] // 4
        ay, ax = np.mgrid[0:gh, 0:gw]
        ly = (y0 + (ay + 0.5) * (y1 - y0) / gh).astype(int) // s4; lx = (x0 + (ax + 0.5) * (x1 - x0) / gw).astype(int) // s4
        art = labels[ly.clip(0, labels.shape[0] - 1), lx.clip(0, labels.shape[1] - 1)].repeat(4, 0).repeat(4, 1)
        art = art[:sp.shape[0], :sp.shape[1]]
        found = []
        for k in keep:
            mask = (art == k) & (sp[..., 3] > 0)
            if not mask.any(): continue
            ys, xs = np.nonzero(mask)
            piece = sp[ys.min():ys.max() + 1, xs.min():xs.max() + 1].copy()
            piece[~mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]] = 0
            cy, cx = np.nonzero(labels == k)
            ccx, ccy = (cx.min() + cx.max() + 1) * s4 / 2, (cy.min() + cy.max() + 1) * s4 / 2
            yhor = hline[min(W - 1, int(ccx))]
            found.append((piece, {'field': fi, 'u': round(ccx / W, 4), 'v': round((ccy - y0) / max(1, yhor - y0), 4), 'area': int(sizes[k] * s4 * s4), 'cx': ccx, 'cy': ccy}))
        # how crowded each cloudlet's neighborhood is: the core area of the others within a tenth
        # of the frame, against the most crowded; a thin field keeps the clumps and loses the
        # strays first, the way a few patches of altocumulus sit in an otherwise clear sky
        R = 0.1 * W
        dens = []
        for sp, m in found:
            d = sum(o['area'] for _, o in found if o is not m and (o['cx'] - m['cx']) ** 2 + (o['cy'] - m['cy']) ** 2 < R * R)
            dens.append(d)
        top = max(dens) if dens else 1
        order = sorted(range(len(found)), key=lambda i: dens[i])
        rank = {i: k / max(1, len(found) - 1) for k, i in enumerate(order)}
        for i, ((sp, m), d) in enumerate(zip(found, dens)):
            m['density'] = round(d / max(1, top), 3); m['rank'] = round(rank[i], 3); del m['cx']; del m['cy']
            pieces.append((sp, m))
        print(f"  field {fi} {e['photo']}: {len(found)} cloudlets (sky blueness {sky:.2f})")
    if not pieces: return
    pieces.sort(key=lambda t: -t[0].shape[0])
    MAXW = 1024; rows = []; row = []; rw = 0
    for piece, meta in pieces:
        if rw + piece.shape[1] + 2 > MAXW and row: rows.append(row); row = []; rw = 0
        row.append((piece, meta)); rw += piece.shape[1] + 2
    if row: rows.append(row)
    LW = max(sum(p.shape[1] + 2 for p, _ in r_) for r_ in rows); LH = sum(max(p.shape[0] for p, _ in r_) + 2 for r_ in rows)
    sheet = np.zeros((LH, LW, 4), np.uint8); rects = []; y = 0
    for r_ in rows:
        x = 0; rh = max(p.shape[0] for p, _ in r_)
        for piece, meta in r_:
            h, w = piece.shape[:2]
            sheet[y:y + h, x:x + w] = piece
            rects.append({**meta, 'x': x, 'y': y, 'w': w, 'h': h})
            x += w + 2
        y += rh + 2
    info = [{'photo': e['photo'], 'type': e.get('type', 'alto'), 'scale': e.get('scale', 0.4), 'width': ImageOps.exif_transpose(Image.open(os.path.join(ROOT, 'art', e['photo']))).width} for e in fields]
    Image.fromarray(sheet, 'RGBA').save(os.path.join(ROOT, 'assets/field.png'), optimize=True)
    with open(os.path.join(ROOT, 'assets/field.json'), 'w') as f: json.dump({'fields': info, 'cloudlets': rects}, f)
    Image.fromarray(halve(sheet), 'RGBA').save(os.path.join(small, 'field.png'), optimize=True)
    with open(os.path.join(small, 'field.json'), 'w') as f:
        json.dump({'fields': [{**i, 'width': i['width'] / 2} for i in info], 'cloudlets': [{**r, 'x': r['x'] // 2, 'y': r['y'] // 2, 'w': (r['w'] + 1) // 2, 'h': (r['h'] + 1) // 2} for r in rects]}, f)
    print(f'assets/field.png {LW}x{LH}, {len(rects)} cloudlets from {len(fields)} field photo(s)')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--art', help='config name (default: art/current)')
    a = ap.parse_args()
    name = a.art or open(os.path.join(ROOT, 'art', 'current')).read().strip()
    cfg = json.load(open(os.path.join(ROOT, 'art', name + '.json')))
    entries = cfg.get('clouds')
    if not entries: sys.exit(f'no "clouds" in art/{name}.json')
    tmp = tempfile.mkdtemp(prefix='clouds-')
    sprites = []; lobes = []
    for i, e in enumerate(entries):
        cut, out = os.path.join(tmp, f'cut{i}.png'), os.path.join(tmp, f'sprite{i}.png')
        cmd = [sys.executable, '-I', os.path.join(ROOT, 'tools/cut_cloud.py'), os.path.join(ROOT, 'art', e['photo']), cut, '--box', ','.join(str(v) for v in e['box'])]
        if e.get('clip'): cmd.append('--clip'); cmd.append(e['clip'] if isinstance(e['clip'], str) else 'lrtb')
        if e.get('all'): cmd.append('--all')
        for f in e.get('fill', []): cmd += ['--fill', ','.join(str(v) for v in f)]
        if 'sky' in e: cmd += ['--sky', str(e['sky'])]
        if 'cloud' in e: cmd += ['--cloud', str(e['cloud'])]
        if subprocess.run(cmd).returncode:
            print(f'  skipped cloud {i} ({e["photo"]} {e["box"]}): the cut failed, see above'); continue
        width = max(16, round(Image.open(cut).width * e.get('scale', 0.4) / 4) * 4)
        subprocess.run([sys.executable, os.path.join(ROOT, 'tools/pixelate.py'), cut, out, '--as', 'cloud', '--width', str(width)], check=True)
        im = np.asarray(Image.open(out).convert('RGBA'))
        if e.get('lobes'):
            # the lobes, from the cut-out's creases, mapped onto the sprite's art pixels
            cutim = np.asarray(Image.open(cut).convert('RGBA'), np.float64)
            labels, recs = segment(cutim[..., 3] / 255, cutim[..., :3])
            gh, gw = im.shape[0] // 4, im.shape[1] // 4
            ch, cw = cutim.shape[:2]
            ay, ax = np.mgrid[0:gh, 0:gw]
            ly = ((ay + 0.5) * ch / gh / 4).astype(int).clip(0, labels.shape[0] - 1); lx = ((ax + 0.5) * cw / gw / 4).astype(int).clip(0, labels.shape[1] - 1)
            art = labels[ly, lx].repeat(4, 0).repeat(4, 1)
            for rec in recs:
                mask = (art == rec['id']) & (im[..., 3] > 0)
                if mask.sum() < 16 * 6: continue
                ys, xs = np.nonzero(mask)
                piece = im[ys.min():ys.max() + 1, xs.min():xs.max() + 1].copy()
                piece[~mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]] = 0
                if piece.shape[1] < 8 or piece.shape[0] < 8: continue
                lobes.append((piece, {'cloud': len(sprites), 'freeTop': round(rec['freeTop'], 2), 'freeBottom': round(rec['freeBottom'], 2), 'freeSides': round(rec['freeSides'], 2), 'onBase': rec['onBase'], 'seam': rec['seam']}))
        ys, xs = np.nonzero(im[..., 3] > 0)
        im = im[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        sprites.append((im, e))
    W = max(s.shape[1] for s, _ in sprites); H = sum(s.shape[0] for s, _ in sprites) + 2 * (len(sprites) - 1)
    sheet = np.zeros((H, W, 4), np.uint8); rects = []; y = 0
    for im, e in sprites:
        h, w = im.shape[:2]
        sheet[y:y + h, :w] = im
        rects.append({'x': 0, 'y': y, 'w': w, 'h': h, 'far': bool(e.get('far')), 'cb': bool(e.get('cb')), 'photo': e['photo']})
        y += h + 2
    Image.fromarray(sheet, 'RGBA').save(os.path.join(ROOT, 'assets/clouds.png'), optimize=True)
    with open(os.path.join(ROOT, 'assets/clouds.json'), 'w') as f: json.dump({'sprites': rects}, f)
    small = os.path.join(ROOT, 'assets/small'); os.makedirs(small, exist_ok=True)
    Image.fromarray(halve(sheet), 'RGBA').save(os.path.join(small, 'clouds.png'), optimize=True)
    with open(os.path.join(small, 'clouds.json'), 'w') as f:
        json.dump({'sprites': [{**r, 'x': r['x'] // 2, 'y': r['y'] // 2, 'w': (r['w'] + 1) // 2, 'h': (r['h'] + 1) // 2} for r in rects]}, f)
    for r in rects: print(f"  {r['photo']}: {r['w']}x{r['h']}{' far' if r['far'] else ''}")
    print(f'assets/clouds.png {W}x{H}, {len(rects)} clouds')
    if lobes:
        # shelf-packed: rows of lobes, tallest first, up to 1024 wide
        lobes.sort(key=lambda t: -t[0].shape[0])
        MAXW = 1024; rows = []; row = []; rw = 0
        for piece, meta in lobes:
            if rw + piece.shape[1] + 2 > MAXW and row: rows.append(row); row = []; rw = 0
            row.append((piece, meta)); rw += piece.shape[1] + 2
        if row: rows.append(row)
        LW = max(sum(p.shape[1] + 2 for p, _ in rw_) for rw_ in rows); LH = sum(max(p.shape[0] for p, _ in rw_) + 2 for rw_ in rows)
        lsheet = np.zeros((LH, LW, 4), np.uint8); lrects = []; y = 0
        for rw_ in rows:
            x = 0; rh = max(p.shape[0] for p, _ in rw_)
            for piece, meta in rw_:
                h, w = piece.shape[:2]
                lsheet[y:y + h, x:x + w] = piece
                lrects.append({**meta, 'x': x, 'y': y, 'w': w, 'h': h})
                x += w + 2
            y += rh + 2
        Image.fromarray(lsheet, 'RGBA').save(os.path.join(ROOT, 'assets/lobes.png'), optimize=True)
        with open(os.path.join(ROOT, 'assets/lobes.json'), 'w') as f: json.dump({'lobes': lrects}, f)
        Image.fromarray(halve(lsheet), 'RGBA').save(os.path.join(small, 'lobes.png'), optimize=True)
        with open(os.path.join(small, 'lobes.json'), 'w') as f:
            json.dump({'lobes': [{**r, 'x': r['x'] // 2, 'y': r['y'] // 2, 'w': (r['w'] + 1) // 2, 'h': (r['h'] + 1) // 2} for r in lrects]}, f)
        print(f'assets/lobes.png {LW}x{LH}, {len(lrects)} lobes from {len({m["cloud"] for _, m in lobes})} clouds')
    build_fields(cfg, tmp, small)
    build_cirrus(cfg, small)


if __name__ == '__main__':
    main()
