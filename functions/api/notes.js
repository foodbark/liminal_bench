// The bulletin board's server side: a Cloudflare Pages Function over one D1 table (db/schema.sql).
// The page probes GET api/notes at load and, when this answers, every pin goes through here and
// the board is shared; where it is absent (GitHub Pages, the dev server) the board stays in the
// browser. See docs/deploy.md.
//
//   GET    /api/notes              -> the notes still on the board, oldest first: [{ id, text, at }]
//   POST   /api/notes {text}       -> pins one (201) and returns the board; 429 when the limits are hit
//   DELETE /api/notes {id | seed | poster}  -> tears one down (a posted note by id, a default note
//                                     by its slot, a poster by id) and returns the board; 429 at the limits
//   ?v=2 on any of them returns { notes, torn: [{ seed, at }], posters: [{ id, w, h, at }] }, the
//   default notes torn down and not yet back and the posters (posters.js); without it the plain
//   array, for pages still holding the older script.
//
// Rate limits from the first commit: an anonymous public board will be found. Per address, by a
// salted daily hash so no address is stored; and a global cap so a crowd cannot flood it either.
// Tearing down is limited the same way, loosely: a person can clear the board in an hour, which
// is just life on a public board; a script cannot keep it bare.
import { board, json, wantsV2, whoHash, LIFE_DAYS, DAY, HOUR } from './_board.js';
const MAX_LEN = 80;
const PER_ADDRESS_HOUR = 3, ALL_HOUR = 30;
const TEAR_HOUR = 6, ALL_TEAR_HOUR = 60;

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);

export async function onRequestGet({ request, env }) {
  return json(await board(env.DB, wantsV2(request)));
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const text = clean(body && body.text);
  if (!text) return json({ error: 'nothing to pin' }, 400);
  const now = Date.now(), since = now - HOUR, who = await whoHash(request, env);
  const [mine, all] = await Promise.all([
    env.DB.prepare('SELECT count(*) AS n FROM notes WHERE who = ?1 AND at > ?2').bind(who, since).first('n'),
    env.DB.prepare('SELECT count(*) AS n FROM notes WHERE at > ?1').bind(since).first('n'),
  ]);
  if (mine >= PER_ADDRESS_HOUR) return json({ error: 'you have pinned enough for now. come back in a while.' }, 429, { 'retry-after': '3600' });
  if (all >= ALL_HOUR) return json({ error: 'the board is full for now. come back later.' }, 429, { 'retry-after': '3600' });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO notes (text, at, who) VALUES (?1, ?2, ?3)').bind(text, now, who),
    env.DB.prepare('DELETE FROM notes WHERE at < ?1').bind(now - 2 * LIFE_DAYS * DAY),   // long since blown away
  ]);
  return json(await board(env.DB, wantsV2(request)), 201);
}

export async function onRequestDelete({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const id = body && Number.isInteger(body.id) ? body.id : null;
  const seed = body && Number.isInteger(body.seed) && body.seed >= 0 && body.seed < 64 ? body.seed : null;
  const poster = body && Number.isInteger(body.poster) ? body.poster : null;
  if (id == null && seed == null && poster == null) return json({ error: 'nothing to tear down' }, 400);
  const now = Date.now(), since = now - HOUR, who = await whoHash(request, env);
  const [mine, all] = await Promise.all([
    env.DB.prepare('SELECT count(*) AS n FROM torn WHERE who = ?1 AND at > ?2').bind(who, since).first('n'),
    env.DB.prepare('SELECT count(*) AS n FROM torn WHERE at > ?1').bind(since).first('n'),
  ]);
  if (mine >= TEAR_HOUR) return json({ error: 'you have torn down enough for now. come back in a while.' }, 429, { 'retry-after': '3600' });
  if (all >= ALL_TEAR_HOUR) return json({ error: 'the board has been picked over for now. come back later.' }, 429, { 'retry-after': '3600' });
  const key = id != null ? `note:${id}` : poster != null ? `poster:${poster}` : `seed:${seed}`;
  const ops = [env.DB.prepare('INSERT INTO torn (key, at, who) VALUES (?1, ?2, ?3)').bind(key, now, who)];
  if (id != null) ops.unshift(env.DB.prepare('DELETE FROM notes WHERE id = ?1').bind(id));
  if (poster != null) ops.unshift(env.DB.prepare('DELETE FROM posters WHERE id = ?1').bind(poster));
  ops.push(env.DB.prepare('DELETE FROM torn WHERE at < ?1').bind(now - 2 * LIFE_DAYS * DAY));
  await env.DB.batch(ops);
  return json(await board(env.DB, wantsV2(request)));
}
