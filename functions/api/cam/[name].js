// A valley webcam still, proxied for the sky reader (src/cams.js). The cams send no CORS headers,
// so the page cannot read their pixels straight from the source; this serves the still from the
// site's own origin and caches it at the edge for ten minutes, so the cam is fetched once for
// everyone, gently (docs/webcams.md: stills only, every 10 to 15 minutes at most). The page
// measures the cloud; nothing is stored here.
//
//   GET /api/cam/mp     -> the Mountain Press cam (South Hills, looking north over the valley)
//   GET /api/cam/kpax   -> the KPAX cam (downtown, looking east at Mount Sentinel)
const CAMS = {
  mp: 'https://wingsvirtualtours.com/webcams/missoula_valley/public_html/cam/streaming/mp/current.jpg',
  kpax: 'https://mediaassets.kpax.com/weatherimages/Saint-Pats.jpg',
};
const TTL = 600;   // seconds; the cams refresh every few minutes, the sky changes slower than that

export async function onRequestGet({ request, params, waitUntil }) {
  const url = CAMS[params.name];
  if (!url) return new Response('no such cam', { status: 404, headers: { 'cache-control': 'no-store' } });
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + '/api/cam/' + params.name);
  const hit = await cache.match(key);
  if (hit) return hit;
  let up;
  try {
    up = await fetch(url, { headers: { 'user-agent': 'liminalbench.net sky check (+https://liminalbench.net/)' }, cf: { cacheTtl: TTL, cacheEverything: true } });
  } catch (err) {
    return new Response('cam unreachable', { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  if (!up.ok) return new Response('cam unavailable', { status: 502, headers: { 'cache-control': 'no-store' } });
  const res = new Response(up.body, {
    status: 200,
    headers: {
      'content-type': up.headers.get('content-type') || 'image/jpeg',
      'cache-control': `public, max-age=${TTL}`,
      'x-cam-modified': up.headers.get('last-modified') || '',
    },
  });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
