// The bulletin board's server side: a Cloudflare Pages Function over one D1 table (db/schema.sql).
// The page probes GET api/notes at load and, when this answers, every pin goes through here and
// the board is shared; where it is absent (GitHub Pages, the dev server) the board stays in the
// browser. See docs/deploy.md.
//
//   GET    /api/notes              -> the notes on the board, oldest first: [{ id, text, at }]
//   POST   /api/notes {text, x?, y?} -> pins one (201) and returns the board; 429 when the limits are hit,
//                                     409 when the board is full (FULL pieces of paper, notes and posters)
//   DELETE /api/notes {id | seed | poster}  -> tears one down (a posted note by id, a default note
//                                     by its slot, a poster by id) and returns the board; 429 at the limits
//   PATCH  /api/notes {id | seed | poster, x, y} -> picks one up and pins it at x, y (fractions of the
//                                     cork), on top of the pile; returns the board; no limit
//   ?v=2 on any of them returns { notes, torn: [{ seed, at }], posters: [{ id, w, h, at }] }, the
//   default notes torn down and not yet back and the posters (posters.js); without it the plain
//   array, for pages still holding the older script.
//
// Rate limits from the first commit: an anonymous public board will be found. Per address, by a
// salted daily hash so no address is stored; and a global cap so a crowd cannot flood it either.
// Tearing down is limited the same way, loosely: a person can clear the board in an hour, which
// is just life on a public board; a script cannot keep it bare. Moving (the user, 2026-10-29:
// pick up someone else's poster and move it to make room for mine, and dig through the old
// stuff without taking things down) is not limited at all: nothing is lost by a move, a moved
// piece only goes on top of the pile the way a re-pinned sheet does, and digging takes many.
import { board, json, wantsV2, whoHash, paperCount, placeOf, FULL, NO_PIN, LIFE_DAYS, DAY, HOUR } from './_board.js';
import { forgetPicture } from './_alert.js';
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
  if (await paperCount(env.DB) >= FULL) return json({ error: NO_PIN }, 409);
  const now = Date.now(), since = now - HOUR, who = await whoHash(request, env);
  const [mine, all] = await Promise.all([
    env.DB.prepare('SELECT count(*) AS n FROM notes WHERE who = ?1 AND at > ?2').bind(who, since).first('n'),
    env.DB.prepare('SELECT count(*) AS n FROM notes WHERE at > ?1').bind(since).first('n'),
  ]);
  if (mine >= PER_ADDRESS_HOUR) return json({ error: 'you have pinned enough for now. come back in a while.' }, 429, { 'retry-after': '3600' });
  if (all >= ALL_HOUR) return json({ error: 'the board is full for now. come back later.' }, 429, { 'retry-after': '3600' });
  // a note is never swept: it stays until it is torn down or buried (2026-10-27)
  const [x, y] = placeOf(body);
  await env.DB.prepare('INSERT INTO notes (text, at, who, x, y) VALUES (?1, ?2, ?3, ?4, ?5)').bind(text, now, who, x, y).run();
  return json(await board(env.DB, wantsV2(request)), 201);
}

export async function onRequestDelete(context) {
  const { request, env } = context;
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
  if (seed != null) ops.unshift(env.DB.prepare('DELETE FROM placed WHERE key = ?1').bind(key));   // it comes back at its slot
  ops.push(env.DB.prepare('DELETE FROM torn WHERE at < ?1').bind(now - 2 * LIFE_DAYS * DAY));
  await env.DB.batch(ops);
  if (poster != null) context.waitUntil(forgetPicture(env, new URL(request.url).origin, poster));   // out of the edge cache too
  return json(await board(env.DB, wantsV2(request)));
}

// Moving: the piece is picked up and pinned where the pointer let it go, on top of the pile.
// A posted note or a poster keeps its row and takes the new place and the move's time; a
// default note's place is a row in `placed` by its seed, cleared when it is torn down.
export async function onRequestPatch({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const id = body && Number.isInteger(body.id) ? body.id : null;
  const seed = body && Number.isInteger(body.seed) && body.seed >= 0 && body.seed < 64 ? body.seed : null;
  const poster = body && Number.isInteger(body.poster) ? body.poster : null;
  if (id == null && seed == null && poster == null) return json({ error: 'nothing to move' }, 400);
  const [x, y] = placeOf(body);
  if (x == null) return json({ error: 'nowhere to put it' }, 400);
  const now = Date.now();
  const op = id != null ? env.DB.prepare('UPDATE notes SET x = ?1, y = ?2, moved = ?3 WHERE id = ?4').bind(x, y, now, id)
    : poster != null ? env.DB.prepare('UPDATE posters SET x = ?1, y = ?2, moved = ?3 WHERE id = ?4').bind(x, y, now, poster)
      : env.DB.prepare('INSERT OR REPLACE INTO placed (key, x, y, at) VALUES (?1, ?2, ?3, ?4)').bind(`seed:${seed}`, x, y, now);
  await op.run();
  return json(await board(env.DB, wantsV2(request)));
}
