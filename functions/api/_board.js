// Shared by the board's functions (notes.js, posters.js, posters/[id].js): the board as the page
// reads it, the caller's daily hash for the rate limits, and the JSON response. Not a route.
export const LIFE_DAYS = 16;   // a torn default note's time down
// The board holds FULL pieces of paper, notes and posters together, and past that there is not
// a pin left and no bare cork: a pin is refused until someone pulls something down (the user,
// 2026-10-27: a limit, but part of the board). Nothing is ever swept; the oldest are only buried.
export const FULL = 40;
export const NO_PIN = 'there is not a pin left, and not a bare inch of cork. something will have to come down first.';
// Where a pin was placed by hand (2026-10-27): the paper's center as fractions of the cork,
// or nulls for a slot. A number out of range is a slot too.
export const placeOf = (body) => {
  const x = body && typeof body.x === 'number' && body.x >= 0 && body.x <= 1 ? Math.round(body.x * 1e4) / 1e4 : null;
  const y = body && typeof body.y === 'number' && body.y >= 0 && body.y <= 1 ? Math.round(body.y * 1e4) / 1e4 : null;
  return x != null && y != null ? [x, y] : [null, null];
};
export const paperCount = async (db) => {
  const [n, p] = await db.batch([db.prepare('SELECT count(*) AS n FROM notes'), db.prepare('SELECT count(*) AS n FROM posters')]);
  return (n.results[0].n || 0) + (p.results[0].n || 0);
};
export const DAY = 86400e3, HOUR = 3600e3;

export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});

export const wantsV2 = (request) => new URL(request.url).searchParams.get('v') === '2';

// The board, oldest first; with v2 also the posters (their pictures fetched by id), the
// default notes torn down and not yet back, and where the default notes that were moved now
// sit (`placed`, 2026-10-29). Nothing on the board ages off it (the user, 2026-10-27:
// everything lives forever, fading slowly, until someone tears it down or covers it):
// everything is served (FULL bounds it), and the page lays the older ones under the newer. A
// torn default note alone keeps a clock, LIFE_DAYS, and then comes back. `moved` is when a
// piece was last picked up and pinned elsewhere: the page orders the pile by the later of the
// posting and the move, so a moved piece lands on top, while the fade runs from the posting.
export async function board(db, v2) {
  const now = Date.now(), since = now - LIFE_DAYS * DAY;
  const { results } = await db.prepare('SELECT id, text, at, x, y, moved FROM notes ORDER BY at DESC LIMIT ?1').bind(FULL).all();
  const notes = results.reverse();
  if (!v2) return notes;
  const [t, p, pl] = await db.batch([
    db.prepare("SELECT key, max(at) AS at FROM torn WHERE key LIKE 'seed:%' AND at > ?1 GROUP BY key").bind(since),
    db.prepare('SELECT id, w, h, k, at, x, y, moved FROM posters ORDER BY at DESC LIMIT ?1').bind(FULL),
    db.prepare("SELECT key, x, y, at FROM placed WHERE key LIKE 'seed:%'"),
  ]);
  return {
    notes, torn: t.results.map((r) => ({ seed: Number(r.key.slice(5)), at: r.at })), posters: p.results.reverse(),
    placed: pl.results.map((r) => ({ seed: Number(r.key.slice(5)), x: r.x, y: r.y, at: r.at })), full: FULL,
  };
}

export async function whoHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.SALT || 'bench'}|${day}|${ip}`));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
