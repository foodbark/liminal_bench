#!/usr/bin/env python3
"""Static dev server with no-cache headers, so edits show on a plain reload.

  python3 tools/serve.py [port] [bind]      defaults: 5173 127.0.0.1

It also stands in for the webcam proxy (functions/api/cam/[name].js) at /api/cam/NAME, so the
cam-read cumulus (src/cams.js) works on the dev server: each still is fetched at most every ten
minutes and held in memory. And for the aircraft feed (functions/api/flights.js) at /api/flights,
fetched from adsb.lol at most every 30 s.
"""
import json, os, re, sys, time, threading, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAMS = {
    'mp': 'https://wingsvirtualtours.com/webcams/missoula_valley/public_html/cam/streaming/mp/current.jpg',
    'kpax': 'https://mediaassets.kpax.com/weatherimages/Saint-Pats.jpg',
}
CAM_TTL = 600
_cam_cache = {}
_cam_lock = threading.Lock()


def cam_still(name):
    """The cam's latest still (bytes), fetched at most once per CAM_TTL; None when it fails."""
    with _cam_lock:
        hit = _cam_cache.get(name)
        if hit and time.time() - hit[0] < CAM_TTL: return hit[1]
        try:
            req = urllib.request.Request(CAMS[name], headers={'User-Agent': 'liminalbench.net sky check (dev)'})
            with urllib.request.urlopen(req, timeout=20) as r: data = r.read()
        except Exception as e:
            print('cam fetch failed', name, e); return hit[1] if hit else None
        _cam_cache[name] = (time.time(), data)
        return data


# the aircraft within 120 nm of the bench (the bench point from src/state.js, so the two agree)
_st = open(os.path.join(ROOT, 'src/state.js')).read()
LAT = re.search(r'LAT = ([-\d.]+)', _st).group(1); LON = re.search(r'LON = ([-\d.]+)', _st).group(1)
FLIGHTS_URL = f'https://api.adsb.lol/v2/point/{LAT}/{LON}/120'
FLIGHTS_TTL = 30
_fl_cache = None
_fl_lock = threading.Lock()


def flights():
    """The feed trimmed the way functions/api/flights.js trims it; None when it fails."""
    global _fl_cache
    with _fl_lock:
        if _fl_cache and time.time() - _fl_cache[0] < FLIGHTS_TTL: return _fl_cache[1]
        try:
            req = urllib.request.Request(FLIGHTS_URL, headers={'User-Agent': 'liminalbench.net sky (dev)', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=20) as r: j = json.loads(r.read())
        except Exception as e:
            print('flights fetch failed', e); return _fl_cache[1] if _fl_cache else None
        ac = []
        for a in j.get('ac', []):
            if a.get('lat') is None or a.get('lon') is None: continue
            alt = a.get('alt_baro'); alt = 'ground' if alt == 'ground' else (alt if alt is not None else a.get('alt_geom'))
            ac.append({'hex': a.get('hex'), 'flight': (a.get('flight') or '').strip(), 't': a.get('t') or '', 'r': a.get('r') or '', 'lat': a['lat'], 'lon': a['lon'],
                       'alt': alt, 'gs': a.get('gs'), 'track': a.get('track'), 'vr': a.get('baro_rate', a.get('geom_rate', 0)) or 0, 'seen': a.get('seen_pos', a.get('seen', 0)) or 0})
        data = json.dumps({'at': j.get('now', int(time.time() * 1000)), 'ac': ac}).encode()
        _fl_cache = (time.time(), data)
        return data


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path.startswith('/api/cam/'):
            name = self.path[len('/api/cam/'):].split('?')[0]
            data = cam_still(name) if name in CAMS else None
            if data is None:
                self.send_response(404 if name not in CAMS else 502); self.end_headers(); return
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg'); self.send_header('Content-Length', str(len(data)))
            self.end_headers(); self.wfile.write(data); return
        if self.path.split('?')[0] == '/api/flights':
            data = flights()
            if data is None: self.send_response(502); self.end_headers(); return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data)))
            self.end_headers(); self.wfile.write(data); return
        super().do_GET()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    bind = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'
    print(f'serving {ROOT} at http://{bind}:{port}')
    ThreadingHTTPServer((bind, port), Handler).serve_forever()
