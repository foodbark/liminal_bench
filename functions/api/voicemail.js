// The answering machines behind the pay phone: one D1 table (db/schema.sql) beside the notes.
//
//   GET  /api/voicemail?number=NNNNNNNNNN   -> the messages on that machine, oldest first: [{ text, at }]
//   POST /api/voicemail {number, text}      -> leaves one (201) and returns the tape; 429 at the limits
//
// The same rate limits as the board, for the same reason: an anonymous public tape will be found.
const MAX_LEN = 120, LIFE_DAYS = 30, TAPE = 12;
const PER_ADDRESS_HOUR = 3, ALL_HOUR = 30;
const DAY = 86400e3, HOUR = 3600e3;

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
const digits = (s) => String(s ?? '').replace(/\D/g, '').slice(0, 16);

async function tape(db, number) {
  const { results } = await db.prepare('SELECT text, at FROM voicemail WHERE number = ?1 AND at > ?2 ORDER BY at DESC LIMIT ?3').bind(number, Date.now() - LIFE_DAYS * DAY, TAPE).all();
  return results.reverse();
}
async function whoHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.SALT || 'bench'}|${day}|${ip}`));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet({ request, env }) {
  const number = digits(new URL(request.url).searchParams.get('number'));
  if (!number) return json({ error: 'which number' }, 400);
  return json(await tape(env.DB, number));
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const number = digits(body && body.number), text = clean(body && body.text);
  if (!number) return json({ error: 'which number' }, 400);
  if (!text) return json({ error: 'nothing to say' }, 400);
  const now = Date.now(), since = now - HOUR, who = await whoHash(request, env);
  const [mine, all] = await Promise.all([
    env.DB.prepare('SELECT count(*) AS n FROM voicemail WHERE who = ?1 AND at > ?2').bind(who, since).first('n'),
    env.DB.prepare('SELECT count(*) AS n FROM voicemail WHERE at > ?1').bind(since).first('n'),
  ]);
  if (mine >= PER_ADDRESS_HOUR) return json({ error: 'the tape is full for you for now. call back in a while.' }, 429, { 'retry-after': '3600' });
  if (all >= ALL_HOUR) return json({ error: 'the tape is full for now. call back later.' }, 429, { 'retry-after': '3600' });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO voicemail (number, text, at, who) VALUES (?1, ?2, ?3, ?4)').bind(number, text, now, who),
    env.DB.prepare('DELETE FROM voicemail WHERE at < ?1').bind(now - 2 * LIFE_DAYS * DAY),
  ]);
  return json(await tape(env.DB, number), 201);
}
