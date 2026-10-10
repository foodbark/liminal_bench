// GET /api/posters/ID -> the poster's PNG, as the page made it. Ids are never reused, so the
// picture can be cached hard; a torn-down or blown-away poster is a 404 and nothing refers to it.
import { LIFE_DAYS, DAY } from '../_board.js';

export async function onRequestGet({ params, env }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return new Response('not found', { status: 404 });
  const row = await env.DB.prepare('SELECT png FROM posters WHERE id = ?1 AND at > ?2').bind(id, Date.now() - LIFE_DAYS * DAY).first();
  if (!row) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const bin = atob(row.png), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400, immutable' } });
}
