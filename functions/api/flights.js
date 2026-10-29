// The aircraft over the valley, for the specks and contrails in the sky (src/flights.js): every
// aircraft within 120 nautical miles of the bench, which is the east-west corridor at cruise
// (Delta, UPS, FedEx, Alaska, 34,000 to 41,000 ft, a dozen at a time) and the traffic into
// Missoula. Three feeds, tried in turn, the answer trimmed to one shape:
//
//   adsb.lol   community ADS-B, free, no key, the richest (type, registration), but 500 calls a
//              day per address, and a Function shares Cloudflare's egress addresses with the
//              world, so from here it is 429 most of the day (the first day in production,
//              2026-10-21)
//   adsb.fi    the same data; answers 403 to anything from a Worker; kept for the day it does not
//   OpenSky    the research network, 400 credits a day anonymous, 4000 with a free account's
//              OAuth2 client (OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET as Pages secrets);
//              no aircraft type, so the caption says "a plane"
//
// One copy of the feed is kept in the site's D1 database (the `kv` table, made on first use),
// so the upstream is asked once per interval for everyone everywhere, not once per edge
// location (the edge cache is per location, and each one asking was what burned adsb.lol's
// allowance); the edge cache sits in front of that. The interval is 30 s, or four minutes
// while anonymous OpenSky is paying for it (its budget is 400 a day), the page dead-reckoning
// in between. When no feed answers the last good copy is served, marked stale, for an hour.
//
//   GET /api/flights   -> { at, src, ttl, stale?, ac: [{ hex, flight, t, r, lat, lon, alt, gs, track, vr, seen }] }
//   GET /api/flights?src=NAME  asks one feed directly (adsb.lol, adsb.fi, opensky), uncached, for a
//                      check from the edge; it takes the same bearer key as the POST, since open
//                      it let anyone spend the feeds' daily budgets from here (2026-10-29)
//   POST /api/flights  the same shape, from a pusher with its own address (tools/push_flights.py
//                      on the user's machine, which the community feeds answer freely), with
//                      `authorization: Bearer FLIGHTS_PUSH_KEY` (a Pages secret); it becomes the
//                      shared copy, and the Function asks no feed while a pushed copy is fresh
//
// alt in feet ('ground' when parked), gs in knots, track in degrees, vr the vertical rate in
// ft/min, seen the seconds since the position was heard.

// the bench point, as LAT/LON in src/state.js (kept by hand: that module loads the painting's metadata at import)
const LAT = 46.852, LON = -113.988;
const RADIUS_NM = 120;
const TTL = 30;             // seconds the feed is good for
const TTL_ANON = 240;       // when anonymous OpenSky is the source
const STALE_MAX = 3600;     // seconds a last good copy is still worth serving
const UA = 'liminalbench.net sky (+https://liminalbench.net/)';
const DEG_LAT = RADIUS_NM * 1.852 / 111.2, DEG_LON = DEG_LAT / Math.cos(LAT * Math.PI / 180);
const OPENSKY = `https://opensky-network.org/api/states/all?lamin=${(LAT - DEG_LAT).toFixed(3)}&lomin=${(LON - DEG_LON).toFixed(3)}&lamax=${(LAT + DEG_LAT).toFixed(3)}&lomax=${(LON + DEG_LON).toFixed(3)}`;
const OPENSKY_TOKEN = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

// readsb's fields (adsb.lol, adsb.fi) to the page's
function fromReadsb(list, now) {
  const ac = [];
  for (const a of list) {
    if (a.lat == null || a.lon == null) continue;
    ac.push({
      hex: a.hex, flight: (a.flight || '').trim(), t: a.t || '', r: a.r || '', lat: a.lat, lon: a.lon,
      alt: a.alt_baro === 'ground' ? 'ground' : (a.alt_baro ?? a.alt_geom ?? null),
      gs: a.gs ?? null, track: a.track ?? null, vr: a.baro_rate ?? a.geom_rate ?? 0, seen: a.seen_pos ?? a.seen ?? 0,
    });
  }
  return ac;
}
// OpenSky's state vectors (metres and m/s) to the page's
function fromOpenSky(j) {
  const ac = [], t0 = j.time || Math.round(Date.now() / 1000);
  for (const s of j.states || []) {
    const [hex, callsign, , timePos, , lon, lat, baroAlt, onGround, vel, track, vr, , geoAlt] = s;
    if (lat == null || lon == null) continue;
    const altM = baroAlt ?? geoAlt;
    ac.push({
      hex, flight: (callsign || '').trim(), t: '', r: '', lat, lon,
      alt: onGround ? 'ground' : (altM == null ? null : Math.round(altM * 3.28084)),
      gs: vel == null ? null : Math.round(vel * 1.94384 * 10) / 10, track: track ?? null,
      vr: vr == null ? 0 : Math.round(vr * 196.85), seen: timePos ? Math.max(0, t0 - timePos) : 0,
    });
  }
  return ac;
}

const SOURCES = [
  { name: 'adsb.lol', url: `https://api.adsb.lol/v2/point/${LAT}/${LON}/${RADIUS_NM}`, parse: (j) => fromReadsb(j.ac || [], j.now) },
  { name: 'adsb.fi', url: `https://opendata.adsb.fi/api/v2/lat/${LAT}/lon/${LON}/dist/${RADIUS_NM}`, parse: (j) => fromReadsb(j.aircraft || j.ac || []) },
  { name: 'opensky', url: OPENSKY, parse: fromOpenSky, auth: true },
];

async function get(url, headers = {}, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

// OpenSky's bearer token for the account's API client, kept in the store until it is about to expire
async function openSkyToken(env, db) {
  if (!env || !env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  const row = await readStored(db, 'opensky_token');
  if (row && Date.now() < row.at) return row.value;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: env.OPENSKY_CLIENT_ID, client_secret: env.OPENSKY_CLIENT_SECRET });
  const r = await fetch(OPENSKY_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, body });
  if (!r.ok) throw new Error('token ' + r.status);
  const j = await r.json();
  await store(db, 'opensky_token', j.access_token, Date.now() + Math.max(60, (j.expires_in || 1800) - 120) * 1000);   // `at` is the expiry here
  return j.access_token;
}

// the feeds in turn; the first that answers with a list wins
async function fetchUpstream(env, db, sources = SOURCES) {
  const tried = [];
  for (const s of sources) {
    try {
      let headers = {}, authed = false;
      if (s.auth) {
        try { const tok = await openSkyToken(env, db); if (tok) { headers = { authorization: 'Bearer ' + tok }; authed = true; } }
        catch (err) { tried.push('opensky ' + err.message); }
      }
      const up = await get(s.url, headers, s.auth ? 25000 : 8000);   // OpenSky is slow, often ten seconds and more
      if (!up.ok) { tried.push(`${s.name} ${up.status}`); continue; }
      const j = await up.json();
      const src = s.name + (s.auth ? (authed ? ' (account)' : ' (anonymous)') : '');
      const ttl = s.auth && !authed ? TTL_ANON : TTL;
      return { body: { at: Date.now(), src, ttl, ac: s.parse(j) }, tried };
    } catch (err) { tried.push(`${s.name} ${err && err.name === 'AbortError' ? 'timeout' : 'error'}`); }
  }
  return { body: null, tried };
}

// the shared store, in D1 (key, value, at); nothing happens without the binding
async function readStored(db, key) {
  if (!db) return null;
  try { return await db.prepare('SELECT value, at FROM kv WHERE key = ?1').bind(key).first(); }
  catch (err) {
    try { await db.prepare('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)').run(); } catch (e) { /* no store */ }
    return null;
  }
}
async function store(db, key, value, at) {
  if (!db) return;
  const put = () => db.prepare('INSERT OR REPLACE INTO kv (key, value, at) VALUES (?1, ?2, ?3)').bind(key, value, at).run();
  try { await put(); }
  catch (err) {
    // the first write into a fresh database: make the table and try once more (a push into an
    // empty store was lost silently before this, 2026-10-21)
    try { await db.prepare('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)').run(); await put(); } catch (e) { /* no store */ }
  }
}

const reply = (body, maxAge, extra = {}) => new Response(body, {
  status: 200,
  headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge}`, ...extra },
});
const ttlOf = (text) => { try { return JSON.parse(text).ttl || TTL; } catch (e) { return TTL; } };

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  // ?src=adsb.lol|adsb.fi|opensky asks one feed directly, for checking a feed from the edge;
  // nothing is stored or cached on that path, so it is for the holder of the push key only
  const force = url.searchParams.get('src');
  if (force) {
    if (!keyed(request, env)) return new Response('no', { status: 401, headers: { 'cache-control': 'no-store' } });
    const s = SOURCES.find((x) => x.name === force);
    if (!s) return new Response('no such feed', { status: 404, headers: { 'cache-control': 'no-store' } });
    const { body, tried } = await fetchUpstream(env, env && env.DB, [s]);
    if (!body) return new Response('no answer: ' + tried.join(', '), { status: 503, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-flights': body.src } });
  }
  const cache = caches.default;
  const key = new Request(url.origin + '/api/flights');
  const hit = await cache.match(key);
  if (hit) return hit;
  const db = env && env.DB;
  const now = Date.now();
  const row = await readStored(db, 'flights');
  // a copy fresh enough: everyone shares it
  if (row && now - row.at < ttlOf(row.value) * 1000) {
    const res = reply(row.value, Math.max(1, Math.round(ttlOf(row.value) - (now - row.at) / 1000)), { 'x-flights': 'stored' });
    waitUntil(cache.put(key, res.clone()));
    return res;
  }
  const { body, tried } = await fetchUpstream(env, db);
  if (body) {
    const text = JSON.stringify(body);
    waitUntil(store(db, 'flights', text, now));
    const res = reply(text, body.ttl, { 'x-flights': body.src + (tried.length ? ' after ' + tried.join(', ') : '') });
    waitUntil(cache.put(key, res.clone()));
    return res;
  }
  console.log('flights: no feed answered: ' + tried.join(', '));
  // the last good copy, marked stale, for a while
  if (row && now - row.at < STALE_MAX * 1000) {
    let stale = row.value;
    try { const j = JSON.parse(row.value); j.stale = true; stale = JSON.stringify(j); } catch (e) { /* as is */ }
    const res = reply(stale, 10, { 'x-flights': 'stale after ' + tried.join(', ') });
    waitUntil(cache.put(key, res.clone()));
    return res;
  }
  return new Response('no feed answered: ' + tried.join(', '), { status: 503, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' } });
}

// a pushed copy from a machine with its own address: the best feed there is, while it runs
// the push key, `authorization: Bearer FLIGHTS_PUSH_KEY`; nothing opens without the secret set
const keyed = (request, env) => {
  const want = env && env.FLIGHTS_PUSH_KEY;
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return !!want && !!got && got === want;
};

export async function onRequestPost({ request, env }) {
  if (!keyed(request, env)) return new Response('no', { status: 401, headers: { 'cache-control': 'no-store' } });
  let j;
  try { j = await request.json(); } catch (err) { return new Response('not json', { status: 400, headers: { 'cache-control': 'no-store' } }); }
  if (!j || !Array.isArray(j.ac)) return new Response('no ac', { status: 400, headers: { 'cache-control': 'no-store' } });
  const now = Date.now();
  const body = { at: now, src: (j.src || 'pushed') + ' (pushed)', ttl: Math.min(120, Math.max(TTL, j.ttl || TTL)), ac: fromReadsb(j.ac, now).concat() };
  await store(env && env.DB, 'flights', JSON.stringify(body), now);
  return new Response(JSON.stringify({ ok: true, ac: body.ac.length }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
