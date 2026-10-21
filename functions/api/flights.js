// The aircraft over the valley, for the specks and contrails in the sky (src/flights.js). The
// feed is adsb.lol, a community ADS-B network with a free API and no key: every aircraft within
// 120 nautical miles of the bench, which is the east-west corridor at cruise (Delta, UPS, FedEx,
// Alaska, 34,000 to 41,000 ft, a dozen at a time) and the traffic into Missoula. This serves it
// from the site's own origin, trimmed to what the page uses and cached at the edge for 30 s, so
// the feed is fetched once for everyone however many have the bench open. Nothing is stored.
//
//   GET /api/flights   -> { at, ac: [{ hex, flight, t, lat, lon, alt, gs, track, vr, seen }] }
//
// alt in feet ('ground' when parked), gs in knots, track in degrees, vr the vertical rate in
// ft/min, seen the seconds since the position was heard.
// the bench point, as LAT/LON in src/state.js (kept by hand: that module loads the painting's metadata at import)
const LAT = 46.852, LON = -113.988;
const RADIUS_NM = 120;
const TTL = 30;
const SOURCE = `https://api.adsb.lol/v2/point/${LAT}/${LON}/${RADIUS_NM}`;

export function trim(j) {
  const ac = [];
  for (const a of j.ac || []) {
    if (a.lat == null || a.lon == null) continue;
    ac.push({
      hex: a.hex, flight: (a.flight || '').trim(), t: a.t || '', r: a.r || '', lat: a.lat, lon: a.lon,
      alt: a.alt_baro === 'ground' ? 'ground' : (a.alt_baro ?? a.alt_geom ?? null),
      gs: a.gs ?? null, track: a.track ?? null, vr: a.baro_rate ?? a.geom_rate ?? 0, seen: a.seen_pos ?? a.seen ?? 0,
    });
  }
  return { at: j.now || Date.now(), ac };
}

export async function onRequestGet({ request, waitUntil }) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + '/api/flights');
  const hit = await cache.match(key);
  if (hit) return hit;
  let up;
  try {
    up = await fetch(SOURCE, { headers: { 'user-agent': 'liminalbench.net sky (+https://liminalbench.net/)', accept: 'application/json' } });
  } catch (err) {
    return new Response('feed unreachable', { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  if (!up.ok) return new Response('feed unavailable', { status: 502, headers: { 'cache-control': 'no-store' } });
  let body;
  try { body = JSON.stringify(trim(await up.json())); }
  catch (err) { return new Response('feed unreadable', { status: 502, headers: { 'cache-control': 'no-store' } }); }
  const res = new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${TTL}` } });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
