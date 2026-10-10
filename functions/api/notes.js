// The bulletin board's server side: a Cloudflare Pages Function over one D1 table (db/schema.sql).
// The page probes GET api/notes at load and, when this answers, every pin goes through here and
// the board is shared; where it is absent (GitHub Pages, the dev server) the board stays in the
// browser. See docs/deploy.md.
//
//   GET    /api/notes              -> the notes still on the board, oldest first: [{ id, text, at }]
//   POST   /api/notes {text}       -> pins one (201) and returns the board; 429 when the limits are hit
//   DELETE /api/notes {id | seed}  -> tears one down (a posted note by id, a default note by its
//                                     slot) and returns the board; 429 at the tearing limits
//   ?v=2 on any of them returns { notes, torn: [{ seed, at }] }, the default notes torn down and
//   not yet back; without it the plain array, for pages still holding the older script.
//
// Rate limits from the first commit: an anonymous public board will be found. Per address, by a
// salted daily hash so no address is stored; and a global cap so a crowd cannot flood it either.
// Tearing down is limited the same way, loosely: a person can clear the board in an hour, which
// is just life on a public board; a script cannot keep it bare.
const MAX_LEN = 80, LIFE_DAYS = 16, BOARD = 6;
const PER_ADDRESS_HOUR = 3, ALL_HOUR = 30;
const TEAR_HOUR = 6, ALL_TEAR_HOUR = 60;
const DAY = 86400e3, HOUR = 3600e3;

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);

async function board(db, v2) {
  const now = Date.now();
  const { results } = await db.prepare('SELECT id, text, at FROM notes WHERE at > ?1 ORDER BY at DESC LIMIT ?2').bind(now - LIFE_DAYS * DAY, BOARD).all();
  const notes = results.reverse();
  if (!v2) return notes;
  const t = await db.prepare("SELECT key, max(at) AS at FROM torn WHERE key LIKE 'seed:%' AND at > ?1 GROUP BY key").bind(now - LIFE_DAYS * DAY).all();
  return { notes, torn: t.results.map((r) => ({ seed: Number(r.key.slice(5)), at: r.at })) };
}
const wantsV2 = (request) => new URL(request.url).searchParams.get('v') === '2';

async function whoHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.SALT || 'bench'}|${day}|${ip}`));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
  if (id == null && seed == null) return json({ error: 'nothing to tear down' }, 400);
  const now = Date.now(), since = now - HOUR, who = await whoHash(request, env);
  const [mine, all] = await Promise.all([
    env.DB.prepare('SELECT count(*) AS n FROM torn WHERE who = ?1 AND at > ?2').bind(who, since).first('n'),
    env.DB.prepare('SELECT count(*) AS n FROM torn WHERE at > ?1').bind(since).first('n'),
  ]);
  if (mine >= TEAR_HOUR) return json({ error: 'you have torn down enough for now. come back in a while.' }, 429, { 'retry-after': '3600' });
  if (all >= ALL_TEAR_HOUR) return json({ error: 'the board has been picked over for now. come back later.' }, 429, { 'retry-after': '3600' });
  const key = id != null ? `note:${id}` : `seed:${seed}`;
  const ops = [env.DB.prepare('INSERT INTO torn (key, at, who) VALUES (?1, ?2, ?3)').bind(key, now, who)];
  if (id != null) ops.unshift(env.DB.prepare('DELETE FROM notes WHERE id = ?1').bind(id));
  ops.push(env.DB.prepare('DELETE FROM torn WHERE at < ?1').bind(now - 2 * LIFE_DAYS * DAY));
  await env.DB.batch(ops);
  return json(await board(env.DB, wantsV2(request)));
}
