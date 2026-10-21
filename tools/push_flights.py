#!/usr/bin/env python3
"""Push the aircraft feed to liminalbench.net from a machine with its own address.

  FLIGHTS_PUSH_KEY=... python3 tools/push_flights.py [--site https://liminalbench.net] [--every 30]

The community ADS-B feeds (adsb.lol, adsb.fi) answer a home connection freely but refuse or
ration Cloudflare's shared egress addresses, so the site's Function (functions/api/flights.js)
can go hours without a feed. This fetches the same query every half minute (adsb.fi first,
adsb.lol as the fallback, as the dev server does) and POSTs it to /api/flights with the push key
(the Pages secret FLIGHTS_PUSH_KEY, set with `npx wrangler pages secret put FLIGHTS_PUSH_KEY`);
the Function keeps it as the shared copy and asks no feed while it is fresh. Run it anywhere
that is up: the LAN server box, a Raspberry Pi. When it stops, the Function goes back to asking
the feeds itself (2026-10-21).
"""
import argparse, json, os, re, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_st = open(os.path.join(ROOT, 'src/state.js')).read()
LAT = re.search(r'LAT = ([-\d.]+)', _st).group(1); LON = re.search(r'LON = ([-\d.]+)', _st).group(1)
URLS = [('adsb.fi', f'https://opendata.adsb.fi/api/v2/lat/{LAT}/lon/{LON}/dist/120'), ('adsb.lol', f'https://api.adsb.lol/v2/point/{LAT}/{LON}/120')]
UA = 'liminalbench.net sky pusher (+https://liminalbench.net/)'


def fetch():
    for name, url in URLS:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=20) as r: j = json.loads(r.read())
            return name, j.get('aircraft') or j.get('ac') or []
        except Exception as e:
            print(time.strftime('%H:%M:%S'), name, 'failed:', e, file=sys.stderr)
    return None, None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--site', default='https://liminalbench.net')
    ap.add_argument('--every', type=float, default=30)
    ap.add_argument('--once', action='store_true')
    a = ap.parse_args()
    key = os.environ.get('FLIGHTS_PUSH_KEY')
    if not key: sys.exit('set FLIGHTS_PUSH_KEY in the environment (the Pages secret of the same name)')
    while True:
        name, ac = fetch()
        if ac is not None:
            body = json.dumps({'src': name, 'ttl': int(a.every * 2), 'ac': ac}).encode()
            req = urllib.request.Request(a.site.rstrip('/') + '/api/flights', data=body, method='POST',
                                         headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': UA})
            try:
                with urllib.request.urlopen(req, timeout=20) as r: print(time.strftime('%H:%M:%S'), name, len(ac), 'aircraft ->', r.read().decode()[:60])
            except Exception as e:
                print(time.strftime('%H:%M:%S'), 'push failed:', e, file=sys.stderr)
        if a.once: break
        time.sleep(a.every)


if __name__ == '__main__':
    main()
