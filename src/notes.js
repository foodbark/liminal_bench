import { META } from './state.js';
import { makeNote, CORK, CLOSEUPS } from './render/props.js';
import { clamp } from './util/pixel.js';
import { hash2 } from './util/noise.js';

// Notes on the bulletin board. What you pin is kept in this browser (localStorage) unless the
// page is served with the notes API behind it (Cloudflare Pages with functions/api/notes.js, see
// docs/deploy.md), in which case the same calls go to the server and the board is shared. The
// API is probed once at load; GitHub Pages and the dev server answer 404 and the board stays
// single-player. A note yellows and curls over two weeks and is gone a couple of days after.
// Anyone can tear any note down, the way a real board works: a posted note goes for good, one
// of the painting's default notes stays down for a note's life and then comes back.
// A poster is a picture someone brought, pixelated here (src/pixelate.js) and pinned like a note:
// it takes a slot the same way, ages the same way, and is torn down the same way.
const KEY = 'liminal.notes', TORN_KEY = 'liminal.torn', POSTER_KEY = 'liminal.posters';
const API = 'api/notes';   // relative: the site may live at a path prefix
export const NOTE_MAX = 80;
const PILE = 24;   // posters the board carries: past the slots they pile up, newest on top
// A poster comes in one of three sizes, a handbill, a flyer or a big sheet (its picture at 1, 2
// or 3 close-up pixels per art pixel), chosen on the pin form (`k`), or picked by its id when
// nothing was chosen so a board is a mix; its box sits on the slot's center, held inside the
// cork, and a big one spills over its neighbors.
export const POSTER_SIZES_NAMED = [[1, 'handbill'], [2, 'flyer'], [3, 'big sheet']];
const POSTER_SCALES = [1, 2, 3], POSTER_ODDS = [0.3, 0.55, 0.15];
export function pickPosterSize(r = Math.random()) {
  let acc = 0;
  for (let i = 0; i < POSTER_ODDS.length; i++) { acc += POSTER_ODDS[i]; if (r < acc) return POSTER_SCALES[i]; }
  return POSTER_SCALES[2];
}
function posterBox(p, cx, cy) {
  const k = POSTER_SCALES.includes(p.k) ? p.k : pickPosterSize(hash2(p.id % 9973, 3, 4));
  const cu = CLOSEUPS.board, kk = cu ? Math.min(cu.cork.w / CORK.w, cu.cork.h / CORK.h) : 4;   // close-up pixels per scene pixel
  const w = Math.round((p.w || 160) * k / kk) + 2, h = Math.round((p.h || 212) * k / kk) + 2;
  const x = clamp(Math.round(cx - w / 2), CORK.x + 2, CORK.x + CORK.w - w - 2), y = clamp(Math.round(cy - h / 2), CORK.y + 2, CORK.y + CORK.h - h - 2);
  return { x, y, w, h, k };
}
export const NOTE_LIFE_DAYS = 16;
const FADE_DAYS = 14, DAY = 86400e3;
const SEED_TEXTS = ['lost: orange cat, answers to "biscuit"', 'free piano. you haul.', 'open mic thursdays', 'room for rent, quiet house', 'the river is low this year', 'call me'];

let mode = 'local';   // 'local' | 'api'
let posted = [];      // [{ id, text, at }], oldest first
let torn = [];        // default notes torn down: [{ seed, at }]
let posters = [];     // [{ id, w, h, at, src }], src the picture's URL (the API) or data URL (local)
const posterImgs = new Map();   // id -> Image, loading or loaded
let onPosterLoad = () => {};
export const whenPosterLoads = (fn) => { onPosterLoad = fn; };
export const notesMode = () => mode;
export const noteAge = (at, now = Date.now()) => clamp((now - at) / (FADE_DAYS * DAY), 0, 1);
const alive = (n, now) => now - n.at < NOTE_LIFE_DAYS * DAY;
export const cleanText = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);

function readJSON(key) { try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function readLocal() { return readJSON(KEY).filter((n) => n && typeof n.text === 'string' && typeof n.at === 'number').map((n) => ({ id: n.id ?? n.at, ...n })); }
function readTorn() { return readJSON(TORN_KEY).filter((t) => t && Number.isInteger(t.seed) && typeof t.at === 'number'); }
function readPosters() { return readJSON(POSTER_KEY).filter((p) => p && typeof p.src === 'string' && typeof p.at === 'number').map((p) => ({ id: p.id ?? p.at, ...p })); }
function writePosters(list) { try { localStorage.setItem(POSTER_KEY, JSON.stringify(list)); } catch (e) { /* the storage is full or absent: the session still has it */ } }
function writeLocal(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* no storage: the session still has it */ } }
function writeTorn(list) { try { localStorage.setItem(TORN_KEY, JSON.stringify(list)); } catch (e) { /* as above */ } }
const sortByAt = (list) => [...list].sort((a, b) => a.at - b.at);
// what the API answers: the board as { notes, torn }, or the plain array from the older function
function takeBoard(body) {
  if (Array.isArray(body)) { posted = sortByAt(body); torn = []; posters = []; return true; }
  if (body && Array.isArray(body.notes)) {
    posted = sortByAt(body.notes); torn = Array.isArray(body.torn) ? body.torn : [];
    posters = sortByAt(Array.isArray(body.posters) ? body.posters : []).map((p) => ({ ...p, src: `${POSTER_API}/${p.id}` }));
    return true;
  }
  return false;
}
const API_V2 = API + '?v=2', POSTER_API = 'api/posters';

export async function loadPosted() {
  try {
    const r = await fetch(API_V2, { headers: { accept: 'application/json' } });
    if (r.ok && (r.headers.get('content-type') || '').includes('json') && takeBoard(await r.json())) { mode = 'api'; return posted; }
  } catch (e) { /* no API here */ }
  mode = 'local';
  const now = Date.now();
  posted = sortByAt(readLocal()).filter((n) => alive(n, now));
  torn = readTorn().filter((t) => alive(t, now));
  posters = sortByAt(readPosters()).filter((p) => alive(p, now));
  writeLocal(posted); writeTorn(torn); writePosters(posters);
  return posted;
}

// Pinning a poster: `png` is the data URL of the art pixels the page made, `w` by `h`.
export async function postPoster(png, w, h, k = 0) {
  if (!/^data:image\/png;base64,/.test(png || '')) throw new Error('nothing to pin');
  if (mode === 'api') {
    const r = await fetch(POSTER_API + '?v=2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ png, k }) });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body && body.error) || 'the pin would not go in');
    takeBoard(body);
    return posters;
  }
  const now = Date.now();
  posters = [...posters, { id: now, w, h, k, at: now, src: png }].filter((p) => alive(p, now)).slice(-PILE);
  writePosters(posters);
  return posters;
}

// The poster's picture, loading on first ask; `whenPosterLoads` hears when one lands.
export function posterImage(p) {
  let im = posterImgs.get(p.id);
  if (!im) {
    im = new Image(); im.decoding = 'async';
    im.onload = () => { im.ready = true; onPosterLoad(p); };
    im.src = p.src; posterImgs.set(p.id, im);
  }
  return im.ready ? im : null;
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
  const what = note.poster ? { poster: note.poster.id } : note.id != null ? { id: note.id } : Number.isInteger(note.seed) ? { seed: note.seed } : null;
  if (!what) throw new Error('it will not come off');
  if (mode === 'api') {
    const r = await fetch(API_V2, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(what) });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body && body.error) || 'it will not come off');
    takeBoard(body);
    return posted;
  }
  const now = Date.now();
  if (what.poster != null) { posters = posters.filter((p) => p.id !== what.poster); writePosters(posters); }
  else if (what.id != null) { posted = posted.filter((n) => n.id !== what.id); writeLocal(posted); }
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
  // notes and posters share the slots, in the order they went up: the latest take the slots,
  // and older posters past that pile up beneath them, each a little askew, newest on top (an old
  // text note simply blows away)
  const items = sortByAt([...posted.filter((n) => alive(n, now)), ...posters.filter((p) => alive(p, now)).map((p) => ({ ...p, poster: p }))]);
  const top = items.slice(-slots.length), under = items.slice(0, Math.max(0, items.length - slots.length)).filter((n) => n.poster);
  const placed = (n, s, dx = 0, dy = 0) => {
    const box = n.poster ? posterBox(n.poster, s.x + s.w / 2 + dx, s.y + s.h / 2 + dy) : { x: s.x + dx, y: s.y + dy };
    return { ...s, ...box, text: n.poster ? '' : n.text, age: noteAge(n.at, now), paper: Math.floor(n.at / 1000) % 6, mine: true, at: n.at, id: n.poster ? null : n.id, seed: null, poster: n.poster || null };
  };
  const pile = under.map((n, k) => {
    const s = slots[order[k % slots.length]];
    const dx = Math.round((hash2(n.poster.id % 9973, 1, 2) - 0.5) * 20), dy = Math.round((hash2(n.poster.id % 9973, 2, 3) - 0.5) * 16);
    return { ...placed(n, s, dx, dy), under: true };
  });
  top.forEach((n, k) => { slots[order[k]] = placed(n, slots[order[k]]); });
  const make = (s) => Object.assign(makeNote(s.text, s), { mine: !!s.mine, at: s.at, id: s.id ?? null, seed: s.mine ? null : s.seed, poster: s.poster || null, under: !!s.under, k: s.k });
  return [...pile.map(make), ...slots.filter((s) => s.mine || !down.has(s.seed)).map(make)];
}
