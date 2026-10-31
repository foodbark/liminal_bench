// The board's watch (2026-10-30, the user: a word the moment a poster goes up, so a bad one is
// seen within minutes and not whenever someone next happens to visit; and nothing of the picture
// in the mail, since it may be the kind of thing nobody wants arriving on a phone in public or
// unprepared). A plain text mail through Cloudflare's Email Sending REST API: the fact, the
// poster's number, and links to open when ready. Pages Functions have no send_email binding, so
// it is the REST call with a scoped token (docs/deploy.md section 7). Every piece is optional:
// with no token, account or address set the watch is silent, and a failure is logged and never
// reaches the person pinning (the mail is sent after the response, through waitUntil).
//
// Also here, since it serves the same end: the poster pictures' place in Cloudflare's cache.
// The CSAM Scanning Tool hashes images as they enter the edge cache, and a Function's response
// never did on its own (checked 2026-10-30: every picture came back DYNAMIC), so posters/[id].js
// puts each picture in through the Cache API, and a tear-down takes it out again, from this data
// center at once and everywhere through a purge of its URL when the token may purge the zone.
const API = 'https://api.cloudflare.com/client/v4';
const SITE = 'liminalbench.net';
export const pictureUrl = (origin, id) => `${origin}/api/posters/${id}`;
export const pictureKey = (origin, id) => new Request(pictureUrl(origin, id), { method: 'GET' });

const SIZES = { 1: 'a handbill', 2: 'a flyer', 3: 'a big sheet' };
const when = (t) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t));

// The words of the mail, apart so they can be read in a test. No picture, no preview, nothing
// from the poster but its number and its size.
export function posterMail({ id, w, h, k, who, at, count, origin }) {
  return {
    subject: '_THEBOARD_',   // the user's filter word, and nothing else in the subject (2026-10-30)
    text: [
      'a poster went up on the board.',
      '',
      `poster ${id}: ${SIZES[k] || 'sized by the board'}, ${w} by ${h} pixels, pinned ${when(at)} Missoula time`
        + ` by visitor ${String(who).slice(0, 6)} (today's hash of their address). the board holds ${count} pieces of paper now.`,
      '',
      'this mail carries no picture on purpose. look when you are ready:',
      `  ${pictureUrl(origin, id)}`,
      'the board:',
      `  ${origin}/`,
      'to take it down: open the board, tap the poster, tear it down. anyone can.',
    ].join('\n'),
  };
}

export async function posterPinned(env, poster) {
  const to = env.ALERT_TO, token = env.WATCH_TOKEN, account = env.CF_ACCOUNT_ID;
  if (!to || !token || !account) return;
  try {
    const { subject, text } = posterMail(poster);
    const res = await fetch(`${env.CF_API || API}/accounts/${account}/email/sending/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to, from: { address: env.ALERT_FROM || `board@${SITE}`, name: 'the bulletin board' }, subject, text }),
    });
    if (!res.ok) console.error('poster mail', res.status, (await res.text()).slice(0, 300));
  } catch (e) { console.error('poster mail', e && e.message); }
}

// A torn-down picture leaves the cache: here at once, everywhere by a purge of its URL when the
// token may purge the zone (CF_ZONE_ID set). Best effort, after the response.
export async function forgetPicture(env, origin, id) {
  try { await caches.default.delete(pictureKey(origin, id)); } catch (e) { /* no cache here */ }
  if (!env.WATCH_TOKEN || !env.CF_ZONE_ID) return;
  try {
    const res = await fetch(`${env.CF_API || API}/zones/${env.CF_ZONE_ID}/purge_cache`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.WATCH_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ files: [pictureUrl(origin, id)] }),
    });
    if (!res.ok) console.error('poster purge', res.status, (await res.text()).slice(0, 300));
  } catch (e) { console.error('poster purge', e && e.message); }
}
