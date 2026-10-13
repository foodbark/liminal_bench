#!/usr/bin/env python3
"""Static dev server with no-cache headers, so edits show on a plain reload.

  python3 tools/serve.py [port] [bind]      defaults: 5173 127.0.0.1

It also stands in for the webcam proxy (functions/api/cam/[name].js) at /api/cam/NAME, so the
cam-read cumulus (src/cams.js) works on the dev server: each still is fetched at most every ten
minutes and held in memory.
"""
import os, sys, time, threading, urllib.request
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
        super().do_GET()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    bind = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'
    print(f'serving {ROOT} at http://{bind}:{port}')
    ThreadingHTTPServer((bind, port), Handler).serve_forever()
