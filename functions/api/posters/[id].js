// GET /api/posters/ID -> the poster's PNG, as the page made it. Ids are never reused, so the
// picture can be cached hard; a torn-down poster is a 404 and nothing refers to it. No age
// cutoff: nothing on the board ages off it (2026-10-27), and the sixteen-day clause left here
// from before would have blanked every poster's frame at sixteen days (found 2026-10-29).
// The picture goes into Cloudflare's edge cache through the Cache API (2026-10-30): a Function's
// response is never cached on its own, and the CSAM Scanning Tool only sees what enters the
// cache (_alert.js); a tear-down takes it out again (notes.js).
import { pictureKey } from '../_alert.js';
export async function onRequestGet(context) {
  const { request, params, env } = context;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return new Response('not found', { status: 404 });
  const key = pictureKey(new URL(request.url).origin, id);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const row = await env.DB.prepare('SELECT png FROM posters WHERE id = ?1').bind(id).first();
  if (!row) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const bin = atob(row.png), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const res = new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400, immutable' } });
  context.waitUntil(cache.put(key, res.clone()));
  return res;
}
