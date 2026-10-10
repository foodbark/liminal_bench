import { META } from './state.js';
import { makeNote } from './render/props.js';
import { clamp } from './util/pixel.js';

// Notes on the bulletin board. What you pin is kept in this browser (localStorage) unless the
// page is served with the notes API behind it (Cloudflare Pages with functions/api/notes.js, see
// docs/deploy.md), in which case the same calls go to the server and the board is shared. The
// API is probed once at load; GitHub Pages and the dev server answer 404 and the board stays
// single-player. A note yellows and curls over two weeks and is gone a couple of days after.
// Anyone can tear any note down, the way a real board works: a posted note goes for good, one
// of the painting's default notes stays down for a note's life and then comes back.
const KEY = 'liminal.notes', TORN_KEY = 'liminal.torn';
const API = 'api/notes';   // relative: the site may live at a path prefix
export const NOTE_MAX = 80;
export const NOTE_LIFE_DAYS = 16;
const FADE_DAYS = 14, DAY = 86400e3;
const SEED_TEXTS = ['lost: orange cat, answers to "biscuit"', 'free piano. you haul.', 'open mic thursdays', 'room for rent, quiet house', 'the river is low this year', 'call me'];

let mode = 'local';   // 'local' | 'api'
let posted = [];      // [{ id, text, at }], oldest first
let torn = [];        // default notes torn down: [{ seed, at }]
export const notesMode = () => mode;
export const noteAge = (at, now = Date.now()) => clamp((now - at) / (FADE_DAYS * DAY), 0, 1);
const alive = (n, now) => now - n.at < NOTE_LIFE_DAYS * DAY;
export const cleanText = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);

function readJSON(key) { try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function readLocal() { return readJSON(KEY).filter((n) => n && typeof n.text === 'string' && typeof n.at === 'number').map((n) => ({ id: n.id ?? n.at, ...n })); }
function readTorn() { return readJSON(TORN_KEY).filter((t) => t && Number.isInteger(t.seed) && typeof t.at === 'number'); }
function writeLocal(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* no storage: the session still has it */ } }
function writeTorn(list) { try { localStorage.setItem(TORN_KEY, JSON.stringify(list)); } catch (e) { /* as above */ } }
const sortByAt = (list) => [...list].sort((a, b) => a.at - b.at);
// what the API answers: the board as { notes, torn }, or the plain array from the older function
function takeBoard(body) {
  if (Array.isArray(body)) { posted = sortByAt(body); torn = []; return true; }
  if (body && Array.isArray(body.notes)) { posted = sortByAt(body.notes); torn = Array.isArray(body.torn) ? body.torn : []; return true; }
  return false;
}
const API_V2 = API + '?v=2';

export async function loadPosted() {
  try {
    const r = await fetch(API_V2, { headers: { accept: 'application/json' } });
    if (r.ok && (r.headers.get('content-type') || '').includes('json') && takeBoard(await r.json())) { mode = 'api'; return posted; }
  } catch (e) { /* no API here */ }
  mode = 'local';
  const now = Date.now();
  posted = sortByAt(readLocal()).filter((n) => alive(n, now));
  torn = readTorn().filter((t) => alive(t, now));
  writeLocal(posted); writeTorn(torn);
  return posted;
}

export async function postNote(text) {
  text = cleanText(text);
  if (!text) throw new Error('nothing to pin');
  if (mode === 'api') {
    const r = await fetch(API_V2, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body && body.error) || 'the pin would not go in');
    if (!takeBoard(body)) posted = sortByAt([...posted, { id: Date.now(), text, at: Date.now() }]);
    return posted;
  }
  const now = Date.now();
  posted = [...posted, { id: now, text, at: now }].filter((n) => alive(n, now)).slice(-META.notes.length);
  writeLocal(posted);
  return posted;
}

// Tearing a note down: a posted note by its id, a default note by its slot (`seed`).
export async function tearDown(note) {
  const what = note.id != null ? { id: note.id } : Number.isInteger(note.seed) ? { seed: note.seed } : null;
  if (!what) throw new Error('it will not come off');
  if (mode === 'api') {
    const r = await fetch(API_V2, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(what) });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body && body.error) || 'it will not come off');
    takeBoard(body);
    return posted;
  }
  const now = Date.now();
  if (what.id != null) { posted = posted.filter((n) => n.id !== what.id); writeLocal(posted); }
  else { torn = [...torn.filter((t) => t.seed !== what.seed), { seed: what.seed, at: now }]; writeTorn(torn); }
  return posted;
}

// The notes on the cork right now: the painting's default notes fill the slots the config lays
// out, and what people have pinned takes those slots over, empty slots first (where a default
// note was torn down), then most faded first, so a fresh note always covers the oldest paper.
// Ages are computed from the time of posting. A torn-down slot with nothing pinned is bare cork.
export function buildNotes(now = Date.now()) {
  const slots = META.notes.map(([x, y, w, h, paper, age], i) => ({ x, y, w, h, paper, age, text: SEED_TEXTS[i % SEED_TEXTS.length], seed: i }));
  const down = new Set(torn.filter((t) => alive(t, now)).map((t) => t.seed));
  const order = slots.map((s, i) => i).sort((a, b) => (down.has(b) - down.has(a)) || (slots[b].age - slots[a].age));
  const mine = posted.filter((n) => alive(n, now)).slice(-slots.length);
  mine.forEach((n, k) => {
    const s = slots[order[k]];
    slots[order[k]] = { ...s, text: n.text, age: noteAge(n.at, now), paper: Math.floor(n.at / 1000) % 6, mine: true, at: n.at, id: n.id, seed: null };
  });
  return slots.filter((s) => s.mine || !down.has(s.seed)).map((s) => Object.assign(makeNote(s.text, s), { mine: !!s.mine, at: s.at, id: s.id ?? null, seed: s.mine ? null : s.seed }));
}
