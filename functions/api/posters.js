// Posters on the board: a picture someone brought, pixelated in their browser (src/pixelate.js)
// and pinned beside the notes. Stored in D1 as the small PNG the page made (base64 text), read
// back by id from posters/[id].js. Torn down through DELETE api/notes { poster }.
//
//   POST /api/posters { png }  -> pins one (201) and returns the board (?v=2 shape); 400 when the
//                                 picture is not a small PNG, 429 at the limits
//
// The limits are loose for now (the user's call, 2026-10-10): twenty an hour per address, sixty
// an hour in all; tearing down is the moderation. The size cap and the pixel cap are what the
// page produces, with a little room; anything else is refused.
import { board, json, wantsV2, whoHash, HOUR, LIFE_DAYS, DAY } from './_board.js';
const MAX_BYTES = 48 * 1024, MAX_SIDE = 224, MIN_SIDE = 16;
const PER_ADDRESS_HOUR = 20, ALL_HOUR = 60;

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const b64 = body && typeof body.png === 'string' ? body.png.replace(/^data:image\/png;base64,/, '') : '';
  if (!b64 || b64.length > MAX_BYTES * 1.4) return json({ error: 'that is not a poster the board can take' }, 400);
  let bytes;
  try { const bin = atob(b64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); } catch (e) { return json({ error: 'bad picture' }, 400); }
  if (bytes.length > MAX_BYTES) return json({ error: 'the poster is too heavy for the pin' }, 400);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || sig.some((v, i) => bytes[i] !== v)) return json({ error: 'the board takes only the posters the page makes' }, 400);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = dv.getUint32(16), h = dv.getUint32(20);
  if (w < MIN_SIDE || h < MIN_SIDE || w > MAX_SIDE || h > MAX_SIDE) return json({ error: 'the poster is the wrong size' }, 400);
  const now = Date.now(), since = now - HOUR, who = await whoHash(request, env);
  const [mine, all] = await Promise.all([
    env.DB.prepare('SELECT count(*) AS n FROM posters WHERE who = ?1 AND at > ?2').bind(who, since).first('n'),
    env.DB.prepare('SELECT count(*) AS n FROM posters WHERE at > ?1').bind(since).first('n'),
  ]);
  if (mine >= PER_ADDRESS_HOUR) return json({ error: 'you have papered the board enough for now. come back in a while.' }, 429, { 'retry-after': '3600' });
  if (all >= ALL_HOUR) return json({ error: 'the board is papered over for now. come back later.' }, 429, { 'retry-after': '3600' });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO posters (png, w, h, at, who) VALUES (?1, ?2, ?3, ?4, ?5)').bind(b64, w, h, now, who),
    env.DB.prepare('DELETE FROM posters WHERE at < ?1').bind(now - 2 * LIFE_DAYS * DAY),
  ]);
  return json(await board(env.DB, wantsV2(request)), 201);
}
