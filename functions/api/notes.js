// The bulletin board's server side: a Cloudflare Pages Function over one D1 table (db/schema.sql).
// The page probes GET api/notes at load and, when this answers, every pin goes through here and
// the board is shared; where it is absent (GitHub Pages, the dev server) the board stays in the
// browser. See docs/deploy.md.
//
//   GET  /api/notes         -> the notes still on the board, oldest first: [{ text, at }]
//   POST /api/notes {text}  -> pins one (201) and returns the board; 429 when the limits are hit
//
// Rate limits from the first commit: an anonymous public board will be found. Per address, by a
// salted daily hash so no address is stored; and a global cap so a crowd cannot flood it either.
const MAX_LEN = 80, LIFE_DAYS = 16, BOARD = 6;
const PER_ADDRESS_HOUR = 3, ALL_HOUR = 30;
const DAY = 86400e3, HOUR = 3600e3;

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);

async function board(db) {
  const { results } = await db.prepare('SELECT text, at FROM notes WHERE at > ?1 ORDER BY at DESC LIMIT ?2').bind(Date.now() - LIFE_DAYS * DAY, BOARD).all();
  return results.reverse();
}

async function whoHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.SALT || 'bench'}|${day}|${ip}`));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet({ env }) {
  return json(await board(env.DB));
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
  return json(await board(env.DB), 201);
}
