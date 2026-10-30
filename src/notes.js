import { META, SMALL } from './state.js';
import { makeNote, scrapFor, CORK, CLOSEUPS } from './render/props.js';
import { clamp } from './util/pixel.js';
import { hash2 } from './util/noise.js';

// Notes on the bulletin board. What you pin is kept in this browser (localStorage) unless the
// page is served with the notes API behind it (Cloudflare Pages with functions/api/notes.js, see
// docs/deploy.md), in which case the same calls go to the server and the board is shared. The
// API is probed once at load; GitHub Pages and the dev server answer 404 and the board stays
// single-player. Nothing on the board ages off it (the user, 2026-10-27: notes, posters,
// everything lives forever and just gets more faded, slowly): a note yellows and curls over a
// year and is still readable at the end of it, and stays until someone tears it down or newer
// paper buries it. Anyone can tear any note down, the way a real board works: a posted note
// goes for good, one of the painting's default notes stays down for a while (TORN_DAYS) and
// then comes back. A poster is a picture someone brought, pixelated here (src/pixelate.js) and
// pinned like a note: it takes a slot the same way, bleaches on the same clock, and is torn
// down the same way. Paper is placed by hand (the user, 2026-10-27: "place them very
// specifically"; write first, then place): a pin carries `x`, `y`, the paper's center as
// fractions of the cork, so it survives a repaint and the half-size build, and a placed note or
// poster sits exactly there, over whatever is there, newest on top; paper with no position (the
// default notes, what was pinned before, an old page's pin) takes a slot as before. Anything can
// be picked up and pinned elsewhere (the user, 2026-10-29: "pick up someone else's poster and
// move it to make room for mine"): a moved piece keeps its words, its paper and its age, takes
// the new place, and goes on top of the pile the way a re-pinned sheet does (`moved`, the time
// of the move; the pile is ordered by the later of the posting and the move); a moved default
// note keeps its place (`placedSeeds`) until it is torn down, when it comes back at its slot.
const KEY = 'liminal.notes', TORN_KEY = 'liminal.torn', POSTER_KEY = 'liminal.posters', PLACED_KEY = 'liminal.placed';
const API = 'api/notes';   // relative: the site may live at a path prefix
export const NOTE_MAX = 80;
// The board holds FULL pieces of paper, notes and posters together: past the slots they pile up,
// newest on top, the oldest buried, and at FULL there is not a pin left and no bare cork, so a
// pin is refused until someone pulls something down (the user, 2026-10-27: a limit, but part of
// the board; the server says the same, functions/api/_board.js).
export const FULL = 40;
export const NO_PIN = 'there is not a pin left, and not a bare inch of cork. something will have to come down first.';
export const paperCount = () => posted.length + posters.length;
export const boardFull = () => paperCount() >= FULL;
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
// A posted note's scrap: its size and paper from a hash of its words, since both are needed
// before the server has given it a time or an id, and the same everywhere it is seen.
export function noteBox(text, cx, cy) {
  const { w, h, paper } = scrapFor(text);   // sized to its words, in its hand
  const x = clamp(Math.round(cx - w / 2), CORK.x + 2, CORK.x + CORK.w - w - 2), y = clamp(Math.round(cy - h / 2), CORK.y + 2, CORK.y + CORK.h - h - 2);
  return { x, y, w, h, paper };
}
// Where a position's fractions fall on the scene's cork.
export const corkPoint = (fx, fy) => ({ cx: CORK.x + clamp(fx, 0, 1) * CORK.w, cy: CORK.y + clamp(fy, 0, 1) * CORK.h });
const hasPlace = (n) => typeof n.x === 'number' && typeof n.y === 'number' && n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1;
function posterBox(p, cx, cy) {
  // the size is set in the full build's close-up pixels; the half-size build (phones) has half
  // the pixels, and a poster sized in its own pixels came out twice as big against the board
  const k = (POSTER_SCALES.includes(p.k) ? p.k : pickPosterSize(hash2(p.id % 9973, 3, 4))) * (SMALL ? 0.5 : 1);
  const cu = CLOSEUPS.board, kk = cu ? Math.min(cu.cork.w / CORK.w, cu.cork.h / CORK.h) : 4;   // close-up pixels per scene pixel
  const w = Math.round((p.w || 160) * k / kk) + 2, h = Math.round((p.h || 212) * k / kk) + 2;
  const x = clamp(Math.round(cx - w / 2), CORK.x + 2, CORK.x + CORK.w - w - 2), y = clamp(Math.round(cy - h / 2), CORK.y + 2, CORK.y + CORK.h - h - 2);
  return { x, y, w, h, k };
}
export const TORN_DAYS = 16;   // a default note torn down comes back after this
const FADE_DAYS = 365, DAY = 86400e3;   // a note is fully faded, still readable, after a year
const SEED_TEXTS = ['lost: orange cat, answers to "biscuit"', 'free piano. you haul.', 'open mic thursdays', 'room for rent, quiet house', 'the river is low this year', 'call me'];

let mode = 'local';   // 'local' | 'api'
let posted = [];      // [{ id, text, at }], oldest first
let torn = [];        // default notes torn down: [{ seed, at }]
let posters = [];     // [{ id, w, h, at, src }], src the picture's URL (the API) or data URL (local)
let placedSeeds = []; // default notes moved by hand: [{ seed, x, y, at }]
let lifted = null;    // the key of the piece being carried, off the cork until it is pinned again
const posterImgs = new Map();   // id -> Image, loading or loaded
let onPosterLoad = () => {};
export const whenPosterLoads = (fn) => { onPosterLoad = fn; };
export const notesMode = () => mode;
export const noteAge = (at, now = Date.now()) => clamp((now - at) / (FADE_DAYS * DAY), 0, 1);
const stillDown = (t, now) => now - t.at < TORN_DAYS * DAY;
export const cleanText = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);

function readJSON(key) { try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function readLocal() { return readJSON(KEY).filter((n) => n && typeof n.text === 'string' && typeof n.at === 'number').map((n) => ({ id: n.id ?? n.at, ...n })); }
function readTorn() { return readJSON(TORN_KEY).filter((t) => t && Number.isInteger(t.seed) && typeof t.at === 'number'); }
function readPosters() { return readJSON(POSTER_KEY).filter((p) => p && typeof p.src === 'string' && typeof p.at === 'number').map((p) => ({ id: p.id ?? p.at, ...p })); }
function readPlaced() { return readJSON(PLACED_KEY).filter((t) => t && Number.isInteger(t.seed) && typeof t.at === 'number' && hasPlace(t)); }
function writePlaced(list) { try { localStorage.setItem(PLACED_KEY, JSON.stringify(list)); } catch (e) { /* as above */ } }
function writePosters(list) { try { localStorage.setItem(POSTER_KEY, JSON.stringify(list)); } catch (e) { /* the storage is full or absent: the session still has it */ } }
function writeLocal(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* no storage: the session still has it */ } }
function writeTorn(list) { try { localStorage.setItem(TORN_KEY, JSON.stringify(list)); } catch (e) { /* as above */ } }
// where a piece stands in the pile: when it went up, or when it was last moved, whichever is later
const rankOf = (n) => Math.max(n.at || 0, n.moved || 0);
const sortByAt = (list) => [...list].sort((a, b) => rankOf(a) - rankOf(b));
// the key a piece is carried and moved by: a posted note by id, a poster by id, a default note by its slot
export const paperKey = (n) => n.poster ? `poster:${n.poster.id}` : n.id != null ? `note:${n.id}` : Number.isInteger(n.seed) ? `seed:${n.seed}` : null;
// what the API answers: the board as { notes, torn, posters, placed }, or the plain array from the older function
function takeBoard(body) {
  if (Array.isArray(body)) { posted = sortByAt(body); torn = []; posters = []; placedSeeds = []; return true; }
  if (body && Array.isArray(body.notes)) {
    posted = sortByAt(body.notes); torn = Array.isArray(body.torn) ? body.torn : [];
    posters = sortByAt(Array.isArray(body.posters) ? body.posters : []).map((p) => ({ ...p, src: `${POSTER_API}/${p.id}` }));
    placedSeeds = Array.isArray(body.placed) ? body.placed.filter((t) => Number.isInteger(t.seed) && hasPlace(t)) : [];
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
  posted = sortByAt(readLocal()).slice(-FULL);
  torn = readTorn().filter((t) => stillDown(t, now));
  posters = sortByAt(readPosters()).slice(-FULL);
  placedSeeds = readPlaced();
  writeLocal(posted); writeTorn(torn); writePosters(posters); writePlaced(placedSeeds);
  return posted;
}

// The API is probed once at load; if that probe failed (a deploy in progress, a hiccup) the
// board stayed in the browser for the whole visit and a note pinned then went nowhere shared
// (a visitor's pin "didn't work", 2026-10-22). So a pin asks again first.
async function ensureApi() {
  if (mode !== 'api') await loadPosted();
  return mode === 'api';
}
const OUT_OF_REACH = 'the board is out of reach right now. try again in a minute.';

// Pinning a poster: `png` is the data URL of the art pixels the page made, `w` by `h`.
// `place` is { x, y }, the paper's center as fractions of the cork, or null for a slot.
export async function postPoster(png, w, h, k = 0, place = null) {
  if (!/^data:image\/png;base64,/.test(png || '')) throw new Error('nothing to pin');
  if (boardFull()) throw new Error(NO_PIN);
  const at = place && hasPlace(place) ? { x: place.x, y: place.y } : {};
  if (await ensureApi()) {
    let r;
    try { r = await fetch(POSTER_API + '?v=2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ png, k, ...at }) }); }
    catch (e) { throw new Error(OUT_OF_REACH); }
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body && body.error) || 'the pin would not go in');
    takeBoard(body);
    return posters;
  }
  const now = Date.now();
  posters = [...posters, { id: now, w, h, k, at: now, src: png, ...at }];
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

export async function postNote(text, place = null) {
  text = cleanText(text);
  if (!text) throw new Error('nothing to pin');
  if (boardFull()) throw new Error(NO_PIN);
  const at = place && hasPlace(place) ? { x: place.x, y: place.y } : {};
  if (await ensureApi()) {
    let r;
    try { r = await fetch(API_V2, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...at }) }); }
    catch (e) { throw new Error(OUT_OF_REACH); }
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body && body.error) || 'the pin would not go in');
    if (!takeBoard(body)) posted = sortByAt([...posted, { id: Date.now(), text, at: Date.now(), ...at }]);
    return posted;
  }
  const now = Date.now();
  posted = [...posted, { id: now, text, at: now, ...at }];
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
  else {
    torn = [...torn.filter((t) => t.seed !== what.seed), { seed: what.seed, at: now }]; writeTorn(torn);
    placedSeeds = placedSeeds.filter((t) => t.seed !== what.seed); writePlaced(placedSeeds);   // it comes back at its slot
  }
  return posted;
}

// Carrying a piece: it is off the cork while it rides on the pointer (`buildNotes` leaves it
// out), and back on it, where it was or where it was dropped, when the carrying ends.
export function liftPaper(n) { lifted = paperKey(n); }
export function dropPaper() { lifted = null; }
// Moving a piece to `place` ({ x, y }, the paper's center as fractions of the cork): a posted
// note or a poster by id, a default note by its slot. It lands on top of the pile.
export async function movePaper(note, place) {
  const what = note.poster ? { poster: note.poster.id } : note.id != null ? { id: note.id } : Number.isInteger(note.seed) ? { seed: note.seed } : null;
  if (!what) throw new Error('it will not come off');
  if (!place || !hasPlace(place)) throw new Error('nowhere to put it');
  const at = { x: place.x, y: place.y };
  if (mode === 'api') {
    let r;
    try { r = await fetch(API_V2, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...what, ...at }) }); }
    catch (e) { throw new Error(OUT_OF_REACH); }
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body && body.error) || 'the pin would not go in');
    takeBoard(body);
    return posted;
  }
  const now = Date.now();
  if (what.poster != null) { posters = sortByAt(posters.map((p) => (p.id === what.poster ? { ...p, ...at, moved: now } : p))); writePosters(posters); }
  else if (what.id != null) { posted = sortByAt(posted.map((n) => (n.id === what.id ? { ...n, ...at, moved: now } : n))); writeLocal(posted); }
  else { placedSeeds = [...placedSeeds.filter((t) => t.seed !== what.seed), { seed: what.seed, ...at, at: now }]; writePlaced(placedSeeds); }
  return posted;
}

// The notes on the cork right now: the painting's default notes fill the slots the config lays
// out, and what people have pinned takes those slots over, empty slots first (where a default
// note was torn down), then most faded first, so a fresh note always covers the oldest paper.
// Ages are computed from the time of posting. A torn-down slot with nothing pinned is bare cork.
// Paper placed by hand sits where it was put, in posting order with the slots' newest, so the
// newest piece on the board is always on top.
// One pinned item as a note on the scene's cork, in a slot `s` (askew by dx, dy) or at the
// point (cx, cy) it was placed; `ghost` is the draft while it is being placed.
function placedItem(n, now, s, dx = 0, dy = 0, cx = null, cy = null) {
  const atPoint = cx != null;
  const box = n.poster ? posterBox(n.poster, atPoint ? cx : s.x + s.w / 2 + dx, atPoint ? cy : s.y + s.h / 2 + dy)
    : noteBox(n.text, atPoint ? cx : s.x + s.w / 2 + dx, atPoint ? cy : s.y + s.h / 2 + dy);   // a note in a slot is sized to its words too, on the slot's center
  // a posted note's paper is its words' (scrapFor), in a slot or placed, so a move never recolors it
  const paper = n.poster ? 0 : box.paper;
  return { ...(s || {}), ...box, text: n.poster ? '' : n.text, age: noteAge(n.at, now), paper, mine: true, at: n.at, rank: rankOf(n), id: n.poster ? null : n.id, seed: null, poster: n.poster || null, placed: atPoint };
}
export function ghostNote(draft, fx, fy, now = Date.now()) {
  const { cx, cy } = corkPoint(fx, fy);
  if (draft.moving) {   // a piece picked up off the board: the same paper, words and age, at the pointer
    const m = draft.moving;
    if (Number.isInteger(m.seed)) {
      const s = { ...m, ...noteBox(m.text, cx, cy), paper: m.paper, age: m.age };
      return Object.assign(makeNote(s.text, s), { mine: false, at: m.at, id: null, seed: m.seed, poster: null, placed: true, ghost: true });
    }
    const n = m.poster ? { id: m.poster.id, at: m.at, poster: m.poster } : { id: m.id, at: m.at, text: m.text };
    const s = placedItem(n, now, null, 0, 0, cx, cy);
    return Object.assign(makeNote(s.text, s), { mine: true, at: s.at, id: s.id, seed: null, poster: s.poster, placed: true, k: s.k, ghost: true });
  }
  // the draft's picture is cached by id like any poster's, so each draft carries its own
  const gid = draft.ghostId ?? -1;
  const n = draft.poster ? { id: gid, at: now, poster: { id: gid, w: draft.poster.w, h: draft.poster.h, k: draft.poster.k, src: draft.poster.png } } : { id: gid, at: now, text: cleanText(draft.text) };
  const s = placedItem(n, now, null, 0, 0, cx, cy);
  return Object.assign(makeNote(s.text, s), { mine: true, at: s.at, id: null, seed: null, poster: s.poster, placed: true, k: s.k, ghost: true });
}
// The slots in the order a pin takes them: a bare one first, then the most faded.
function slotOrder(now) {
  const slots = META.notes.map(([x, y, w, h, paper, age], i) => ({ x, y, w, h, paper, age, text: SEED_TEXTS[i % SEED_TEXTS.length], seed: i }));
  const down = new Set(torn.filter((t) => stillDown(t, now)).map((t) => t.seed));
  const order = slots.map((s, i) => i).sort((a, b) => (down.has(b) - down.has(a)) || (slots[b].age - slots[a].age));
  return { slots, down, order };
}
// Where a fresh pin would land if nobody placed it: the slot the board would give it, as
// fractions of the cork. The paper in the hand starts there (the user, 2026-10-30: on a phone
// nothing showed until a tap), so there is something to see and to drag.
export function firstSpot(now = Date.now()) {
  const { slots, order } = slotOrder(now);
  const inSlots = [...posted, ...posters].filter((n) => !hasPlace(n) && paperKey(n) !== lifted).length;
  const s = slots[order[Math.min(inSlots, slots.length - 1)]];
  return { fx: clamp((s.x + s.w / 2 - CORK.x) / CORK.w, 0, 1), fy: clamp((s.y + s.h / 2 - CORK.y) / CORK.h, 0, 1) };
}
export function buildNotes(now = Date.now()) {
  const { slots, down, order } = slotOrder(now);
  // notes and posters share the slots, in the order they went up: the latest take the slots,
  // and everything older piles up beneath them, each a little askew, newest on top; nothing
  // blows away, the oldest is only buried
  const all = sortByAt([...posted, ...posters.map((p) => ({ ...p, poster: p }))]).filter((n) => paperKey(n) !== lifted);
  const byHand = all.filter(hasPlace), items = all.filter((n) => !hasPlace(n));
  const top = items.slice(-slots.length), under = items.slice(0, Math.max(0, items.length - slots.length));
  const placed = (n, s, dx = 0, dy = 0) => placedItem(n, now, s, dx, dy);
  const pile = under.map((n, k) => {
    const s = slots[order[k % slots.length]];
    const seed = Math.abs(Math.round(n.id ?? n.at)) % 9973;
    const dx = Math.round((hash2(seed, 1, 2) - 0.5) * 20), dy = Math.round((hash2(seed, 2, 3) - 0.5) * 16);
    return { ...placed(n, s, dx, dy), under: true };
  });
  top.forEach((n, k) => { slots[order[k]] = placed(n, slots[order[k]]); });
  const make = (s0) => { const s = s0.mine || s0.poster || s0.placed ? s0 : { ...s0, ...noteBox(s0.text, s0.x + s0.w / 2, s0.y + s0.h / 2), paper: s0.paper }; return Object.assign(makeNote(s.text, s), { mine: !!s.mine, at: s.at, id: s.id ?? null, seed: s.mine ? null : s.seed, poster: s.poster || null, under: !!s.under, k: s.k, placed: !!s.placed }); };
  // the pile, then the painting's own flyers still in their slots, then everything pinned or
  // moved by hand in the order it went up or was last moved, so the newest piece is on top;
  // the piece being carried is off the cork
  const movedSeed = new Map(placedSeeds.map((t) => [t.seed, t]));
  const flyers = slots.filter((s) => !s.mine && !down.has(s.seed) && `seed:${s.seed}` !== lifted);
  const defaults = flyers.filter((s) => !movedSeed.has(s.seed));
  const movedFlyers = flyers.filter((s) => movedSeed.has(s.seed)).map((s) => { const t = movedSeed.get(s.seed), { cx, cy } = corkPoint(t.x, t.y); return { ...s, ...noteBox(s.text, cx, cy), paper: s.paper, placed: true, rank: t.at }; });
  const live = [...slots.filter((s) => s.mine), ...movedFlyers, ...byHand.map((n) => { const { cx, cy } = corkPoint(n.x, n.y); return placedItem(n, now, null, 0, 0, cx, cy); })].sort((a, b) => (a.rank ?? a.at) - (b.rank ?? b.at));
  return [...pile.map(make), ...defaults.map(make), ...live.map(make)];
}
