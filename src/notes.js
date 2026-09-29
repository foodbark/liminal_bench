import { META } from './state.js';
import { makeNote } from './render/props.js';
import { clamp } from './util/pixel.js';

// Notes on the bulletin board. What you pin is kept in this browser (localStorage) unless the
// page is served with the notes API behind it (Cloudflare Pages with functions/api/notes.js, see
// docs/deploy.md), in which case the same calls go to the server and the board is shared. The
// API is probed once at load; GitHub Pages and the dev server answer 404 and the board stays
// single-player. A note yellows and curls over two weeks and is gone a couple of days after.
const KEY = 'liminal.notes';
const API = 'api/notes';   // relative: the site may live at a path prefix
export const NOTE_MAX = 80;
export const NOTE_LIFE_DAYS = 16;
const FADE_DAYS = 14, DAY = 86400e3;
const SEED_TEXTS = ['lost: orange cat, answers to "biscuit"', 'free piano. you haul.', 'open mic thursdays', 'room for rent, quiet house', 'the river is low this year', 'call me'];

let mode = 'local';   // 'local' | 'api'
let posted = [];      // [{ text, at }], oldest first
export const notesMode = () => mode;
export const noteAge = (at, now = Date.now()) => clamp((now - at) / (FADE_DAYS * DAY), 0, 1);
const alive = (n, now) => now - n.at < NOTE_LIFE_DAYS * DAY;
export const cleanText = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);

function readLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((n) => n && typeof n.text === 'string' && typeof n.at === 'number') : [];
  } catch (e) { return []; }
}
function writeLocal(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* no storage: the session still has it */ } }
const sortByAt = (list) => [...list].sort((a, b) => a.at - b.at);

export async function loadPosted() {
  try {
    const r = await fetch(API, { headers: { accept: 'application/json' } });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
      const list = await r.json();
      if (Array.isArray(list)) { posted = sortByAt(list); mode = 'api'; return posted; }
    }
  } catch (e) { /* no API here */ }
  mode = 'local';
  posted = sortByAt(readLocal()).filter((n) => alive(n, Date.now()));
  writeLocal(posted);
  return posted;
}

export async function postNote(text) {
  text = cleanText(text);
  if (!text) throw new Error('nothing to pin');
  if (mode === 'api') {
    const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body && body.error) || 'the pin would not go in');
    posted = sortByAt(Array.isArray(body) ? body : [...posted, { text, at: Date.now() }]);
    return posted;
  }
  const now = Date.now();
  posted = [...posted, { text, at: now }].filter((n) => alive(n, now)).slice(-META.notes.length);
  writeLocal(posted);
  return posted;
}

// The notes on the cork right now: the painting's default notes fill the slots the config lays
// out, and what people have pinned takes those slots over, most faded first, so a fresh note
// always covers the oldest paper. Ages are computed from the time of posting.
export function buildNotes(now = Date.now()) {
  const slots = META.notes.map(([x, y, w, h, paper, age], i) => ({ x, y, w, h, paper, age, text: SEED_TEXTS[i % SEED_TEXTS.length] }));
  const order = slots.map((s, i) => i).sort((a, b) => slots[b].age - slots[a].age);
  const mine = posted.filter((n) => alive(n, now)).slice(-slots.length);
  mine.forEach((n, k) => {
    const s = slots[order[k]];
    slots[order[k]] = { ...s, text: n.text, age: noteAge(n.at, now), paper: Math.floor(n.at / 1000) % 6, mine: true, at: n.at };
  });
  return slots.map((s) => Object.assign(makeNote(s.text, s), { mine: !!s.mine, at: s.at }));
}
