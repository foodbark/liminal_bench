// Shared by the board's functions (notes.js, posters.js, posters/[id].js): the board as the page
// reads it, the caller's daily hash for the rate limits, and the JSON response. Not a route.
export const LIFE_DAYS = 16, BOARD = 6, PILE = 24;   // notes on the board; posters, which pile up
export const DAY = 86400e3, HOUR = 3600e3;

export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});

export const wantsV2 = (request) => new URL(request.url).searchParams.get('v') === '2';

// The notes still up, oldest first; with v2 also the posters (their pictures fetched by id) and
// the default notes torn down and not yet back.
export async function board(db, v2) {
  const now = Date.now(), since = now - LIFE_DAYS * DAY;
  const { results } = await db.prepare('SELECT id, text, at FROM notes WHERE at > ?1 ORDER BY at DESC LIMIT ?2').bind(since, BOARD).all();
  const notes = results.reverse();
  if (!v2) return notes;
  const [t, p] = await db.batch([
    db.prepare("SELECT key, max(at) AS at FROM torn WHERE key LIKE 'seed:%' AND at > ?1 GROUP BY key").bind(since),
    db.prepare('SELECT id, w, h, at FROM posters WHERE at > ?1 ORDER BY at DESC LIMIT ?2').bind(since, PILE),
  ]);
  return { notes, torn: t.results.map((r) => ({ seed: Number(r.key.slice(5)), at: r.at })), posters: p.results.reverse() };
}

export async function whoHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.SALT || 'bench'}|${day}|${ip}`));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
