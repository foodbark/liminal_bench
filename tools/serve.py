#!/usr/bin/env python3
"""Static dev server with no-cache headers, so edits show on a plain reload.

  python3 tools/serve.py [port] [bind]      defaults: 5173 127.0.0.1
"""
import os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    bind = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'
    print(f'serving {ROOT} at http://{bind}:{port}')
    ThreadingHTTPServer((bind, port), Handler).serve_forever()
