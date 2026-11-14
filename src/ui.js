import { W, H, SCALE, META, formatTime } from './state.js';
import { HOTSPOTS, CLOSEUPS, CORK, closeupNotes, HAND_LIST, drawHeldPaper, handsKey } from './render/props.js';
import { lerp, clamp } from './util/pixel.js';
import { postNote, buildNotes, notesMode, NOTE_MAX, MARKS_ALL, fitNote, oneLine, tearDown, postPoster, POSTER_SIZES_NAMED, pickPosterSize, boardFull, ghostNote, movePaper, liftPaper, dropPaper, firstSpot } from './notes.js';
import { peakSnowLatched, peakSnowSince, peakSnowBareSince, peakSnowMelt } from './season.js';
import { gliderChance } from './render/gliders.js';
import { planetSpots, starSpots } from './render/sky.js';
import { Phone, loadPhoneBook, phoneBook, formatNumber, MESSAGE_MAX } from './phone.js';
import { pixelate } from './pixelate.js';
import { hasItem, give, inventory, ITEM_NAMES } from './items.js';

const VIEWS = { scene: { cx: W / 2, cy: H / 2, s: 1 }, ...META.views };
// touch screens and short windows: the captions say tap, not click
const COMPACT = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse), (max-height: 520px)') : { matches: false };

export function setupUI(state, canvas) {
  const $ = (id) => document.getElementById(id);
  const caption = $('caption-text'), status = $('status'), band = $('band'), say = $('say'), panel = $('panel');
  const pTitle = $('panel-title'), pBody = $('panel-body'), pActions = $('panel-actions');
  let bandOpen = false, settled = false;
  // the pay phone: lifted when its panel opens, hung up when the visitor steps back
  const phone = new Phone({ now: () => state.now, temp: () => state.weatherShown.temp, hasItem, onChange: () => renderPhone() });
  loadPhoneBook().then(() => { if (state.view === 'phone') renderPhone(true); });
  if (window.__liminal) window.__liminal.items = { give, inventory }; else window.addEventListener('load', () => { if (window.__liminal) window.__liminal.items = { give, inventory }; });
  // A view with a close-up painting shows the prop itself readable, so its panel waits for a
  // second click: the board zooms in on the first, and the next click opens the note form.
  const twoStep = (view) => !!CLOSEUPS[view];

  // Upright (the user, 2026-11-13: make the mobile site work in portrait; layout A of the two
  // mock-ups): on a phone held upright the scene fills the screen's height and is some three and
  // a half screens wide, the page's body scrolls sideways under the finger to look around, and
  // the band is fixed at the foot of the screen. Walking up to something scrolls it to the
  // middle; stepping back leaves you looking at it. `?upright` forces it on a desktop.
  const FORCE_UPRIGHT = /[?&]upright\b/.test(location.search), COARSE = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : { matches: false };
  const uprightNow = () => FORCE_UPRIGHT || (COARSE.matches && window.innerHeight > window.innerWidth && window.innerWidth <= 700);
  const scroller = document.body;
  let upright = false, lookX = W / 2;   // where in the scene we are looking, straight ahead to start
  function focusX() {   // the canvas x to put in the middle of the screen: the thing walked up to, or where we last looked
    if (state.view === 'scene') return lookX;
    const cu = CLOSEUPS[state.view]; if (cu && cu.cork) return cu.cork.x + cu.cork.w / 2;   // a close-up painting stands on its own place in the frame
    const t = VIEWS[state.view], h = HOTSPOTS.find((q) => q.id === state.view);
    return W / 2 + ((h ? h.x + h.w / 2 : t.cx) - t.cx) * t.s;
  }
  function look(smooth = true, x = focusX()) {
    if (!upright) return;
    const k = window.innerHeight / H, max = Math.max(0, W * k - window.innerWidth);
    scroller.scrollTo({ left: Math.min(max, Math.max(0, x * k - window.innerWidth / 2)), behavior: smooth ? 'smooth' : 'auto' });
  }
  function fitStage() {
    const up = uprightNow();
    const s = up ? window.innerHeight / H : Math.min(window.innerWidth / W, window.innerHeight / H);
    if (up !== upright) {
      upright = up; document.documentElement.classList.toggle('upright', up);
      if (up) requestAnimationFrame(() => look(false)); else scroller.scrollLeft = 0;
      requestAnimationFrame(() => measure());
    }
    document.documentElement.style.setProperty('--s', s);
    // shown smaller than its pixels, the scene is scaled smoothly so the dither averages into
    // the soft tones it was drawn for (nearest-neighbor drops rows of the 4x4 pattern and turns
    // it into blotches); shown larger, pixels stay crisp
    canvas.style.imageRendering = s < 1 ? 'auto' : 'pixelated';
    document.documentElement.style.setProperty('--w', W + 'px');
    document.documentElement.style.setProperty('--h', H + 'px');
  }
  fitStage(); window.addEventListener('resize', fitStage);
  // the band's height in canvas pixels, so the renderer keeps a held-up poster clear of it
  // (upright the band is a bigger share of the screen, so while it has something to say the
  // picture rides up by the height of what it says, or the bench sat hidden behind its own words;
  // the canvas alone moves, since a transform on the stage would unfix the band)
  const measure = () => {
    const r = canvas.getBoundingClientRect(); state.bandH = r.height ? band.offsetHeight / r.height * H : 0;
    document.documentElement.style.setProperty('--bandh', band.offsetHeight + 'px');
    const lift = upright ? Math.round(Math.min(window.innerHeight * 0.35, Math.max(0, band.offsetHeight - $('caption').offsetHeight))) : 0;
    canvas.style.transform = lift ? `translateY(-${lift}px)` : '';
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(band); else window.addEventListener('resize', measure);
  // on a phone the keyboard covers the bottom of the window and the band rides up over it
  const vv = window.visualViewport;
  if (vv) {
    const ride = () => { const r = band.parentElement.parentElement.getBoundingClientRect(); const lift = Math.max(0, Math.round(r.bottom - vv.offsetTop - vv.height)); band.style.transform = lift ? `translateY(-${lift}px)` : ''; };
    vv.addEventListener('resize', ride); vv.addEventListener('scroll', ride);
  }

  function toWorld(e) {
    const r = canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) / r.width * W, my = (e.clientY - r.top) / r.height * H;
    const cam = state.camera;
    return { x: (mx - (W / 2 - cam.cx * cam.s)) / cam.s, y: (my - (H / 2 - cam.cy * cam.s)) / cam.s };
  }
  function hitTest(p) {
    for (const h of HOTSPOTS) if (p.x >= h.x && p.x < h.x + h.w && p.y >= h.y && p.y < h.y + h.h) return h;
    // a wing over Sentinel gets a caption but is nowhere to go
    const fx = window.__liminal && window.__liminal.renderer && window.__liminal.renderer.fx;
    if (fx && fx.gliders.list.length && fx.gliders.hit(p)) return { id: 'glider', label: fx.gliders.label };
    if (fx && fx.flights.list.length && fx.flights.hit(p)) return { id: 'flight', label: fx.flights.label };
    const r = 10 * (W / 1024);
    for (const s of planetSpots) if (Math.abs(p.x - s.x) < r && Math.abs(p.y - s.y) < r) return { id: 'planet', label: s.label };
    for (const s of starSpots) if (Math.abs(p.x - s.x) < r && Math.abs(p.y - s.y) < r) return { id: 'star', label: s.label };
    return null;
  }
  // on the board's close-up the notes themselves can be pointed at (and torn down); the close-up
  // is drawn in canvas pixels, under no camera
  function noteAt(e) {
    if (state.closeup !== 'board' || !settled || !CLOSEUPS.board) return null;
    const r = canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) / r.width * W, my = (e.clientY - r.top) / r.height * H;
    const hit = closeupNotes(state, CLOSEUPS.board).reverse().find((n) => mx >= n.x && mx < n.x + n.w && my >= n.y && my < n.y + n.h);
    return hit ? hit.note : null;
  }
  // the pointer over the board's close-up as fractions of its cork (the close-up is drawn in
  // canvas pixels, under no camera); null off the cork
  function corkAt(e) {
    const cu = CLOSEUPS.board; if (!cu) return null;
    const r = canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) / r.width * W, my = (e.clientY - r.top) / r.height * H;
    const m = 24 * SCALE;   // a little slack past the cork's edge: the paper is held inside it anyway
    if (mx < cu.cork.x - m || mx > cu.cork.x + cu.cork.w + m || my < cu.cork.y - m || my > cu.cork.y + cu.cork.h + m) return null;
    return { fx: Math.min(1, Math.max(0, (mx - cu.cork.x) / cu.cork.w)), fy: Math.min(1, Math.max(0, (my - cu.cork.y) / cu.cork.h)) };
  }
  // the paper in the hand, when the pointer is on it (the close-up is drawn in canvas pixels)
  function ghostAt(e) {
    const pl = state.placing, cu = CLOSEUPS.board; if (!pl || !pl.note || !cu || state.closeup !== 'board') return false;
    const r = canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) / r.width * W, my = (e.clientY - r.top) / r.height * H;
    const [g] = closeupNotes({ notes: [pl.note] }, cu);
    return mx >= g.x && mx < g.x + g.w && my >= g.y && my < g.y + g.h;
  }
  // where the carried paper's center goes for this pointer: a held piece keeps the grip it was
  // picked up by (`held.ox`, `held.oy`: its center's offset from the pointer, in cork fractions),
  // so it neither jumps at the pickup nor lands anywhere but where it is seen; null off the cork
  function carriedTo(e) {
    const p = corkAt(e); if (!p) return null;
    const h = state.placing.held;
    return h ? { fx: Math.min(1, Math.max(0, p.fx + h.ox)), fy: Math.min(1, Math.max(0, p.fy + h.oy)) } : p;
  }
  // carrying the paper: it follows the pointer over the cork
  function carry(e) {
    const p = carriedTo(e);
    if (p) { state.placing.fx = p.fx; state.placing.fy = p.fy; state.placing.note = ghostNote(state.placing, p.fx, p.fy); }
    canvas.classList.toggle('hot', !!p && !state.placing.held);
  }
  canvas.addEventListener('mousemove', (e) => {
    if (state.placing) { if (!state.placing.held && !COMPACT.matches) carry(e); return; }   // a held piece follows the pointer events; on a touch screen the paper sits until dragged
    if (state.view !== 'scene') {
      const n = state.view === 'board' && !bandOpen && !state.poster ? noteAt(e) : null;
      state.hover = n ? 'note' : null; state.hoverLabel = n ? (n.poster ? 'a poster' : `a note: “${oneLine(n.text, 60)}”`) + ' · hold to pick it up' : '';
      canvas.classList.toggle('hot', !!n);
      return;
    }
    const h = hitTest(toWorld(e));
    state.hover = h ? h.id : null; state.hoverLabel = h ? h.label : '';
    canvas.classList.toggle('hot', !!h && !!VIEWS[h.id]);
  });
  canvas.addEventListener('mouseleave', () => { state.hover = null; canvas.classList.remove('hot'); });
  // Picking a piece up (the user, 2026-10-29: "why can't we just click and hold to pick a note
  // up"): press on a note or a poster on the board's close-up and hold a beat, or just start
  // dragging it, and it lifts onto the pointer; let go and it is pinned there, on top. Let go
  // where it was picked up, or off the cork, or press Escape, and it goes back. A plain click
  // is still a click (the tear panel, a poster held up). Pointer events, so a finger does the same.
  const HOLD_MS = 220, DRAG_PX = 5;
  let press = null, swallowClick = 0;
  const pressed = (e) => press && e.pointerId === press.id;
  // the grip: the piece's center against the pointer, in cork fractions, kept while it is carried
  function grip(e, note, id) {
    try { canvas.setPointerCapture(id); } catch (err) { /* a pointer already gone */ }
    const p = corkAt(e), g = p || { fx: 0, fy: 0 };
    const ox = (note.x + note.w / 2 - CORK.x) / CORK.w - g.fx, oy = (note.y + note.h / 2 - CORK.y) / CORK.h - g.fy;
    return { held: true, id, x: e.clientX, y: e.clientY, ox: p ? ox : 0, oy: p ? oy : 0 };
  }
  function lift(e) {
    if (!press) return;
    const { note, id } = press; clearTimeout(press.timer); press = null;
    startMoving(note, grip(e, note, id));
    carry(e);
  }
  function dropHeld(e) {
    const held = state.placing.held;
    swallowClick = Date.now();   // the click that follows the release is not a click on the board
    canvas.classList.remove('grab');
    if (Math.hypot(e.clientX - held.x, e.clientY - held.y) < DRAG_PX * 2) {
      // let go where it was picked up: a piece off the board goes back without a word; a fresh
      // pin tapped where it sits is pinned there
      if (state.placing.moving) backToForm(); else placeAt({ fx: state.placing.fx, fy: state.placing.fy });
      return;
    }
    placeAt(carriedTo(e));
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary || state.poster || state.view !== 'board') return;
    if (state.placing) {   // the paper in the hand, taken by the pointer: a drag moves it, letting go pins it
      if (!state.placing.held && ghostAt(e)) { state.placing.held = grip(e, state.placing.note, e.pointerId); canvas.classList.add('grab'); }
      return;
    }
    if (bandOpen) return;
    const n = noteAt(e);
    if (!n) return;
    press = { note: n, id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(() => lift(e), HOLD_MS) };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pressed(e)) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX) {
        if (upright && e.pointerType === 'touch') { clearTimeout(press.timer); press = null; }   // upright a drag looks along the board; only holding still picks a piece up
        else lift(e);
      }
      return;
    }
    if (state.placing && state.placing.held && e.pointerId === state.placing.held.id) { carry(e); lastCarry = { clientX: e.clientX, clientY: e.clientY }; }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (pressed(e)) { clearTimeout(press.timer); press = null; return; }   // a click: the click event follows
    if (state.placing && state.placing.held && e.pointerId === state.placing.held.id) dropHeld(e);
  });
  canvas.addEventListener('pointercancel', (e) => {
    if (pressed(e)) { clearTimeout(press.timer); press = null; }
    if (state.placing && state.placing.held) { canvas.classList.remove('grab'); if (state.placing.moving) backToForm(); else state.placing.held = null; }
  });
  // a piece in the hand moves with the finger, and the board must not scroll under it
  canvas.addEventListener('touchmove', (e) => { if (state.placing && state.placing.held && e.cancelable) e.preventDefault(); }, { passive: false });
  // carried to the edge of an upright screen, the board scrolls on under the paper
  let lastCarry = null;
  function edgeScroll() {
    const pl = state.placing;
    if (!upright || !pl || !pl.held || !lastCarry) { if (!pl || !pl.held) lastCarry = null; return; }
    const m = 44, x = lastCarry.clientX, d = x < m ? -1 : x > window.innerWidth - m ? 1 : 0;
    if (d) { scroller.scrollLeft += d * 7; carry(lastCarry); }
  }
  canvas.addEventListener('contextmenu', (e) => { if (press || state.placing) e.preventDefault(); });   // a long press on a touch screen
  canvas.addEventListener('click', (e) => {
    if (swallowClick && Date.now() - swallowClick < 500) { swallowClick = 0; return; }
    if (state.view === 'scene') { const h = hitTest(toWorld(e)); if (h && VIEWS[h.id]) enter(h.id); return; }
    if (!twoStep(state.view)) { leave(); return; }         // a view without a close-up: any click steps back
    if (state.poster) { putBack(); return; }               // holding a poster: any click puts it back
    if (state.placing) { placeAt(carriedTo(e)); return; }  // carrying the paper: this is where it goes
    const n = state.view === 'board' ? noteAt(e) : null;   // a note on the cork: offer to tear it down; a poster: hold it up
    if (bandOpen) { shut(); if (!n) return; }              // a click off the form puts it away
    if (settled) n ? holdUp(n) : (state.view === 'board' ? compose : showPanel)(state.view);
  });
  window.addEventListener('keydown', (e) => {
    // typing into the board's note field must not drive the scene
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'Escape') { if (state.poster) putBack(); else if (state.placing) { if (state.placing.held) { swallowClick = Date.now(); canvas.classList.remove('grab'); } backToForm(); } else leave(); }
    if (e.key === 'd' || e.key === 'D') { const d = $('debug'); d.hidden = !d.hidden; }
  });
  if (/[?&]debug\b/.test(location.search)) $('debug').hidden = false;   // phones have no D key

  const refresh = () => { state.notes = buildNotes(); state.notesVersion++; };
  function enter(view) {
    const h = HOTSPOTS.find((q) => q.id === view); if (h) lookX = h.x + h.w / 2;
    state.view = view; look(); state.hover = null; settled = false; canvas.classList.remove('hot'); canvas.classList.toggle('board', view === 'board'); }
  function leave() {
    if (state.placing && state.placing.moving) { dropPaper(); refresh(); }   // a piece being carried goes back where it was
    state.view = 'scene'; state.closeup = null; letGo(); state.placing = null; phone.hangUp(); shut(); panel.hidden = true; canvas.classList.remove('board', 'grab', 'held');
    look();
  }
  // The browser's back button steps back from the board, the bench or the phone, and does not
  // leave the site (the user on a phone, 2026-11-13), one layer at a time like Escape: a held-up
  // paper goes back on the cork, a paper in the hand back to the form, the form shuts, then the
  // step back. Each layer is an entry on the history, put there by `syncHistory` a frame after
  // the tap that opened it and taken off again when a button closes it. Nothing is ever pushed
  // in answer to the back button itself: Chrome on a phone skips, on the next back, an entry
  // whose page pushed another with no touch since arriving on it, and a first version that
  // re-pushed its entry after closing a layer went straight out of the site on the second back
  // (the user, the same day).
  let depth = 0, ownBack = 0, touched = false;
  for (const ev of ['pointerup', 'keydown', 'click']) window.addEventListener(ev, () => { touched = true; }, true);
  const layers = () => (state.view === 'scene' ? 0 : 1 + (state.poster ? 1 : state.placing && !state.placing.moving ? 2 : bandOpen && twoStep(state.view) ? 1 : 0));
  function closeLayer() {
    if (state.poster) putBack();
    else if (state.placing) { if (state.placing.held) canvas.classList.remove('grab'); backToForm(); }
    else if (bandOpen && twoStep(state.view)) shut();
    else leave();
  }
  function syncHistory() {
    if (ownBack) return;   // our own step back is still on its way
    const want = layers();
    try {
      if (want > depth && touched) while (depth < want) history.pushState({ liminal: ++depth }, '');
      else if (want < depth) { ownBack++; history.go(want - depth); depth = want; }
    } catch (e) { depth = want; }   // no history: the buttons still step back
  }
  window.addEventListener('popstate', (e) => {
    if (ownBack) { ownBack--; return; }
    depth = (e.state && e.state.liminal) || 0; touched = false;
    for (let k = 0; k < 4 && layers() > depth; k++) closeLayer();
  });
  // Placing (the user, 2026-10-27: write first, then place): the form's "put it up" hands the
  // paper to the pointer, the form goes away, the paper rides over the cork as a ghost drawn by
  // the renderer, and a click pins it there, over whatever is there. A click off the cork, or
  // Escape, carries it back to the form with the words kept.
  function startPlacing(draft) {
    state.placing = { ...draft, ghostId: -Date.now(), fx: null, fy: null, note: null };
    const { fx, fy } = firstSpot();   // it lands at once where the board would have put it, there to see and to drag
    state.placing.fx = fx; state.placing.fy = fy; state.placing.note = ghostNote(state.placing, fx, fy);
    inHand(); state.hover = null;
    if (upright && CLOSEUPS.board) { const [g] = closeupNotes({ notes: [state.placing.note] }, CLOSEUPS.board); look(true, g.x + g.w / 2); }   // upright the paper may have landed off the screen
  }
  // The band while the paper is in the hand: a fresh pin, or a piece picked up to move. "pin it
  // here" pins it where it sits, so nobody has to aim; the other button is the way back.
  function inHand() {
    const moving = state.placing.moving;
    const { text, acts } = open();
    line(text, moving ? 'It is off the cork, in your hand.' : 'It is in your hand.', 'line dim');
    button(acts, 'pin it here', () => placeAt({ fx: state.placing.fx, fy: state.placing.fy }));
    button(acts, moving ? 'put it back' : 'never mind', () => backToForm());
  }
  function backToForm(err = '') {
    const draft = state.placing; state.placing = null; canvas.classList.remove('hot');
    if (!draft) return;
    if (draft.moving) {   // a piece picked up goes back where it was; a refused move says why
      dropPaper(); refresh();
      if (err) holdUp(draft.moving, err);
      return;
    }
    compose({ ...draft, error: err });
  }
  // `p` is where it goes, cork fractions; null (off the cork) sends it back
  async function placeAt(p) {
    const draft = state.placing;
    if (!draft) return;
    if (!p || p.fx == null) { backToForm(); return; }
    state.placing = null; canvas.classList.remove('hot', 'grab'); shut();
    try {
      const place = { x: p.fx, y: p.fy };
      if (draft.moving) { await movePaper(draft.moving, place); dropPaper(); }
      else if (draft.poster) await postPoster(draft.poster.png, draft.poster.w, draft.poster.h, draft.poster.k, place);
      else await postNote(draft.text, place, draft.hand);
      refresh();
    } catch (err) { state.placing = draft; backToForm(err.message || 'the pin would not go in'); }
  }
  // Moving (the user, 2026-10-29: pick up someone else's poster and move it to make room): the
  // piece comes off the cork onto the pointer (`held`: the pointer that holds it and where it
  // was picked up), rides over the board as the ghost the way a fresh pin does, and letting go
  // pins it there, on top of the pile; letting go off the cork, or Escape, puts it back where
  // it was. Anyone can move anything, the way anyone can tear anything down.
  function startMoving(n, held = null) {
    if (state.poster) putBack();
    liftPaper(n); refresh();
    state.placing = { moving: n, held, text: n.text || '', poster: null, ghostId: null, fx: null, fy: null, note: null };
    inHand(); state.hover = null; canvas.classList.remove('hot'); canvas.classList.toggle('grab', !!held);
  }

  // The band: the Sierra line under the picture, grown to say something or ask (the user,
  // 2026-10-30: the floating boxes eclipsed the board on a phone, so nothing floats over the
  // scene any more, on a desktop either; the words, the fields and the buttons sit in the bar
  // at the bottom, and a close-up's own margin takes the room). `open` clears it and shows it
  // with a column for the words and a row for the buttons; `shut` empties it.
  const el = (tag, cls = '', content = '') => { const d = document.createElement(tag); if (cls) d.className = cls; if (content) d.textContent = content; return d; };
  const line = (parent, content, cls = 'line') => { const d = el('div', cls, content); parent.appendChild(d); return d; };
  const errLine = (parent, msg = '') => { const d = line(parent, msg, 'line err'); d.hidden = !msg; return d; };
  const tell = (d, msg) => { d.textContent = msg; d.hidden = !msg; };
  const button = (parent, label, fn) => { const b = el('button', '', label); b.type = 'button'; b.onclick = fn; parent.appendChild(b); return b; };
  function shut() { say.hidden = true; say.replaceChildren(); bandOpen = false; }
  function open() {
    const top = el('div', 'top'), text = el('div', 'text'), acts = el('div', 'acts');
    top.append(text, acts); say.replaceChildren(top); say.hidden = false; bandOpen = true;
    state.hover = null; canvas.classList.remove('hot');   // the caption drops what was pointed at
    return { text, acts };
  }
  // A poster or a note held up: the second zoom, the paper large over the dimmed board (a note
  // too since 2026-11-13, the user: we pick them up to look at them; a click on a note used to
  // go straight to the tear question). The band offers to tear it down; a click anywhere, or
  // Escape, puts it back.
  function holdUp(n, error = '') {
    state.poster = n; state.hover = null; canvas.classList.remove('hot'); canvas.classList.add('held');
    heldKey = ''; held.hidden = false; document.documentElement.classList.add('holding'); paintHeld();
    const { text, acts } = open();
    line(text, 'Someone pinned this up.' + (n.mine && notesMode() !== 'api' ? ' It is yours.' : '') + (n.poster ? '' : ' The pin is loose. Nobody would stop you.'), 'line dim');
    const err = errLine(text, error);
    const tear = button(acts, 'tear it down', async () => {
      if (tear.disabled) return;
      tear.disabled = true; tell(err, '');
      try { await tearDown(n); refresh(); putBack(); }
      catch (e) { tell(err, e.message || 'it will not come off'); tear.disabled = false; }
    });
    button(acts, 'put it back', putBack);
  }
  function letGo() { state.poster = null; canvas.classList.remove('held'); held.hidden = true; document.documentElement.classList.remove('holding'); }
  function putBack() { letGo(); shut(); }
  // The held paper's own layer (`#held`): the window above the band, at the screen's pixels,
  // painted again when the window turns or resizes, a hand's face arrives or the picture lands.
  const held = $('held');
  let heldKey = '';
  held.addEventListener('click', () => { if (state.poster) putBack(); });
  function paintHeld() {
    const n = state.poster; if (!n) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const cssW = window.innerWidth, cssH = Math.max(60, Math.round(band.getBoundingClientRect().top));
    const cw = Math.round(cssW * dpr), ch = Math.round(cssH * dpr);
    const key = [n.poster ? 'p' + n.poster.id : n.id + ' ' + n.text, cw, ch, handsKey(), state.notesVersion].join('|');
    if (key === heldKey) return;
    held.width = cw; held.height = ch; held.style.width = cssW + 'px'; held.style.height = cssH + 'px';
    heldKey = drawHeldPaper(held.getContext('2d'), n, cw, ch, dpr * Math.max(window.innerWidth, window.innerHeight) / W, dpr) ? key : '';
  }
  function showPanel(view) {
    if (view === 'phone') return phonePanel();
    const { text, acts } = open();
    const content = PANELS[view](state);
    for (const [words, cls] of content.lines) line(text, words, cls);
    for (const [label, fn] of content.actions) button(acts, label, fn === 'leave' ? leave : compose);
  }
  // Pinning a note: a scrap of paper, a pencil, one line. Enter or "put it up" hands it to the
  // pointer to place (`draft` brings the words and the picture back from a placing that was
  // called off, with any error to show).
  let lastHand = Math.floor(Math.random() * HAND_LIST.length);   // the hand the form last showed
  function compose(draft = null) {
    const { text, acts } = open();
    if (boardFull()) {   // the board is full: not a pin left, no bare cork; something has to come down first
      line(text, 'You feel along the rail for a pin. There is not one left, and not a bare inch of cork. Something will have to come down first.');
      button(acts, 'all right', () => twoStep('board') ? shut() : showPanel('board'));
      if (twoStep('board')) button(acts, 'step back', leave);
      return;
    }
    const lead = line(text, 'A pencil stub hangs on a string.', 'line dim');
    // a picture (pixel art made here before it goes anywhere) takes the lead's place as a
    // thumbnail with its size on the board beside it: a handbill, a flyer or a big sheet
    const pic = el('div', 'row'); pic.hidden = true;
    const preview = el('canvas', 'thumb'), sizes = el('div', 'row sizes'), info = el('span', 'dim');
    pic.append(preview, info); text.appendChild(pic);
    const fields = el('div', 'row'); say.appendChild(fields);   // the whole width, under the words and the buttons
    const input = el('textarea'); input.rows = 1; input.id = 'note-text';   // a poem's lines: Enter is a new line input.maxLength = NOTE_MAX * 2 + MARKS_ALL; input.placeholder = 'write something on a blank scrap'; input.autocomplete = 'off'; input.spellcheck = false;
    if (draft && draft.text) input.value = draft.text;
    // NOTE_MAX letters; stacking marks ride free on them, so the field's own limit is looser
    // The box is one line tall until there is a second, then grows a line at a time to ROWS
    // and scrolls past that, the same for every hand: each row is ROW of the band's em.
    const ROW = 1.8, ROWS = 6;
    const fitBox = () => {
      const row = parseFloat(getComputedStyle(box).fontSize) * ROW;
      box.style.height = ''; input.style.height = '0px';
      const rows = clamp(Math.round(input.scrollHeight / row), 1, ROWS);
      input.style.height = ''; box.style.height = `calc(${rows * ROW}em + ${box.offsetHeight - box.clientHeight}px)`;
    };
    input.addEventListener('input', () => { const f = fitNote(input.value.replace(/\r\n?/g, '\n')); if (f !== input.value) input.value = f; fitBox(); });   // past the last line an Enter is a space
    // The hand it is written in (the user, 2026-11-12): its name sits inside the field, left of
    // the words and a colon, in its own face, the field following; a click or a tap on it steps
    // to the next hand. Each time the form opens it starts on another hand, so the board keeps
    // its mix and the label shows itself to be a choice.
    let hand = draft && Number.isInteger(draft.hand) ? draft.hand : (lastHand = (lastHand + 1 + Math.floor(Math.random() * (HAND_LIST.length - 1))) % HAND_LIST.length);
    const handLabel = () => {
      const h = HAND_LIST[hand], face = `"${h.face}", ${h.mono ? 'monospace' : 'cursive'}`;
      handButton.textContent = h.name + ':'; handButton.style.fontFamily = face; input.style.fontFamily = face;
      handButton.style.fontSize = input.style.fontSize = h.size + 'em';   // the hand's own size, as on the paper, on rows that stay one height (style.css)
      handButton.style.height = input.style.lineHeight = ROW / h.size + 'em';
      if (box.isConnected) fitBox();
    };
    const handButton = el('button', 'hand'); handButton.type = 'button'; handButton.title = 'the hand it is written in: click for the next';
    handButton.addEventListener('pointerdown', (e) => e.preventDefault());   // the field keeps the focus, and a phone its keyboard
    const stepHand = (d) => { hand = lastHand = (hand + d + HAND_LIST.length) % HAND_LIST.length; handLabel(); };
    handButton.addEventListener('click', () => { stepHand(1); input.focus(); });
    // The keys step it too (the user, 2026-11-12): the up and down arrows from the field, and
    // with the label itself in focus (Shift+Tab from the field) w and s and vim's k and j as
    // well; in the field those four are letters of the note.
    const HAND_KEYS = { ArrowDown: 1, ArrowUp: -1, s: 1, w: -1, j: 1, k: -1 };
    // (an arrow steps it only where it has no line to move to: up on the first line, down on the last)
    input.addEventListener('keydown', (e) => {
      if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.isComposing || e.shiftKey) return;
      const v = input.value, up = e.key === 'ArrowUp';
      if (up ? v.lastIndexOf('\n', input.selectionStart - 1) >= 0 : v.indexOf('\n', input.selectionEnd) >= 0) return;
      e.preventDefault(); stepHand(HAND_KEYS[e.key]);
    });
    handButton.addEventListener('keydown', (e) => { const d = !e.ctrlKey && !e.metaKey && !e.altKey && HAND_KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key]; if (d) { e.preventDefault(); e.stopPropagation(); stepHand(d); } });
    const box = el('div', 'field'); box.append(handButton, input); fields.prepend(box); handLabel(); fitBox();
    sizes.hidden = true; fields.append(sizes);   // the sizes beside the field once a picture is in
    const err = errLine(text, draft && draft.error);
    const file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.id = 'poster-file'; file.hidden = true; text.appendChild(file);
    let sizeK = draft && draft.poster ? draft.poster.k : pickPosterSize();
    const sizeButtons = POSTER_SIZES_NAMED.map(([k, name]) => {
      const b = button(sizes, name, () => { sizeK = k; sizeButtons.forEach((o, i) => o.classList.toggle('chosen', POSTER_SIZES_NAMED[i][0] === k)); });
      b.classList.toggle('chosen', k === sizeK); return b;
    });
    let poster = null;   // { png, w, h } once a picture is pixelated
    const showPreview = (png, w, h) => {
      const k = Math.max(1, Math.floor(Math.min(240 / w, 240 / h)));
      preview.width = w * k; preview.height = h * k;
      const im = new Image();
      im.onload = () => { const g = preview.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(im, 0, 0, preview.width, preview.height); };
      im.src = png;
      lead.hidden = true; pic.hidden = false; sizes.hidden = false;
    };
    if (draft && draft.poster) { poster = { png: draft.poster.png, w: draft.poster.w, h: draft.poster.h }; showPreview(poster.png, poster.w, poster.h); }
    file.addEventListener('change', async () => {
      poster = null; lead.hidden = false; pic.hidden = true; sizes.hidden = true; tell(err, '');
      const f = file.files && file.files[0]; if (!f) return;
      tell(err, 'pixelating…');
      try {
        const bmp = await createImageBitmap(f);
        await new Promise((r) => setTimeout(r, 30));   // let the word show first
        const art = pixelate(bmp, { kind: 'prop' }); bmp.close();
        const c = document.createElement('canvas'); c.width = art.width; c.height = art.height; c.getContext('2d').putImageData(art, 0, 0);
        const png = c.toDataURL('image/png');
        showPreview(png, art.width, art.height); tell(err, ''); info.textContent = `${art.width} by ${art.height}, ${art.colors} colors`;
        poster = { png, w: art.width, h: art.height };
      } catch (e) { tell(err, 'that picture would not take'); }
    });
    // "put it up": the paper goes to the pointer and the board takes it where it is clicked
    const submit = () => {
      const text = input.value.trim();
      if (poster && !text) startPlacing({ text: '', poster: { ...poster, k: sizeK } });
      else if (text) startPlacing({ text, poster: null, hand });
      else tell(err, 'nothing to pin');
    };
    button(acts, 'put it up', submit);
    button(acts, 'pin a picture', () => file.click());
    // with the board's close-up the form simply goes away and the cork is there to read
    button(acts, 'never mind', () => twoStep('board') ? shut() : showPanel('board'));
    if (twoStep('board')) button(acts, 'step back', leave);
    // Enter is a new line now (a phone's keyboard has nothing else); Ctrl or Cmd with it puts the note up
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
    setTimeout(() => input.focus(), 0);
  }

  // Tearing a note down: anyone can, the way a real board works. A posted note is gone for good;
  // one of the painting's own comes back after a note's life, as if someone put up a fresh one.
  // The pay phone's panel: the handset display, the keypad, the phone book, the transcript of
  // what the line says, and the message form when a machine beeps. The keypad is HTML for now;
  // it moves onto the phone's close-up painting when that art arrives.
  let ph = null;   // the panel's live elements
  function phonePanel() {
    shut();
    panel.className = 'dock-' + (VIEWS.phone.dock || 'center') + ' phone';   // the wide layout: keypad beside the book
    panel.hidden = false;
    pTitle.textContent = 'pay phone';
    pBody.innerHTML = '';
    const display = document.createElement('div'); display.className = 'phone-display';
    const lines = document.createElement('div'); lines.className = 'phone-lines';
    const keypad = document.createElement('div'); keypad.className = 'keypad';
    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']) {
      const b = document.createElement('button'); b.textContent = d; b.type = 'button';
      b.onclick = () => { if (phone.state === 'hung') phone.lift(); phone.press(d); };
      keypad.appendChild(b);
    }
    const book = document.createElement('div'); book.className = 'book';
    const form = document.createElement('div'); form.className = 'phone-form'; form.hidden = true;
    const input = document.createElement('input'); input.id = 'message-text'; input.maxLength = MESSAGE_MAX; input.placeholder = 'say something after the tone';
    input.autocomplete = 'off'; input.spellcheck = false;
    const err = document.createElement('div'); err.className = 'note-err';
    form.append(input, err);
    const body = document.createElement('div'); body.className = 'phone-body';
    body.append(display, lines, keypad, book, form);
    pBody.append(body);
    pActions.innerHTML = '';
    const send = document.createElement('button'); send.textContent = 'leave it'; send.hidden = true;
    const submit = async () => {
      if (send.disabled) return;
      send.disabled = true; err.textContent = '';
      try { await phone.leaveMessage(input.value); input.value = ''; }
      catch (e) { err.textContent = e.message || 'the message did not take'; }
      send.disabled = false;
    };
    send.onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    // hanging up stays at the phone (the receiver can be lifted again); stepping back leaves it
    const hang = document.createElement('button'); hang.textContent = 'hang up';
    hang.onclick = () => { if (phone.state === 'hung') phone.lift(); else phone.hangUp(); };
    const back = document.createElement('button'); back.textContent = 'step back'; back.onclick = leave;
    pActions.append(send, hang, back);
    ph = { display, lines, keypad, book, form, input, send, hang };
    phone.lift();
    renderPhone(true);
  }
  const STATE_TEXT = { hung: 'the receiver is on the hook', dialtone: 'dial tone', dialing: '', connecting: 'connecting…', ringing: 'ringing…', intercept: '', reorder: 'the line is dead', howler: 'hang up', busy: 'busy', time: '', machine: '', record: 'after the tone…', left: '', recording: '' };
  function renderPhone(book = false) {
    if (!ph || state.view !== 'phone') return;
    const n = formatNumber(phone.number);
    ph.display.textContent = n ? n + (STATE_TEXT[phone.state] ? ' · ' + STATE_TEXT[phone.state] : '') : (STATE_TEXT[phone.state] || '\u00a0');
    ph.lines.textContent = phone.lines.join('\n');
    ph.hang.textContent = phone.state === 'hung' ? 'pick up' : 'hang up';
    const recording = phone.state === 'record';
    ph.form.hidden = !recording; ph.send.hidden = !recording;
    if (recording) setTimeout(() => ph.input.focus(), 0);
    if (book || !ph.book.childElementCount) {
      ph.book.innerHTML = '';
      const list = phoneBook();
      if (list.length) {
        const h = document.createElement('div'); h.className = 'dim'; h.textContent = 'phone book'; ph.book.appendChild(h);
        const ul = document.createElement('ul'); ul.className = 'list';
        for (const e of list) {
          const li = document.createElement('li'); li.textContent = e.name; li.className = 'dial';
          const span = document.createElement('span'); span.textContent = e.number; li.appendChild(span);
          li.onclick = () => phone.dial(e.number);
          ul.appendChild(li);
        }
        ph.book.appendChild(ul);
      }
      // what the caller carries, so the gate on a number is no mystery
      const carried = inventory();
      if (carried.length) { const c = document.createElement('div'); c.className = 'dim'; c.textContent = 'in your pocket: ' + carried.map((id) => ITEM_NAMES[id] || id).join(', '); ph.book.appendChild(c); }
    }
  }
  window.addEventListener('keydown', (e) => {
    if (state.view !== 'phone' || (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName))) return;
    if (/^[0-9*#]$/.test(e.key)) { if (phone.state === 'hung') phone.lift(); phone.press(e.key); }
  });

  // debug controls
  const dbg = { enabled: $('dbg-enabled'), hour: $('dbg-hour'), month: $('dbg-month'), weather: $('dbg-weather'), cover: $('dbg-cover'), moon: $('dbg-moon'), peaks: $('dbg-peaks'), gliders: $('dbg-gliders'), info: $('dbg-info') };
  const sync = () => {
    const o = state.override;
    o.enabled = dbg.enabled.checked; o.hour = +dbg.hour.value; o.month = +dbg.month.value; o.weather = dbg.weather.value; o.cover = +dbg.cover.value; o.moon = dbg.moon.value; o.peaks = dbg.peaks.value; o.gliders = dbg.gliders.value;
    const hh = Math.floor(o.hour), mm = Math.round((o.hour - hh) * 60);
    $('dbg-hour-val').textContent = `${String(hh % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    $('dbg-cover-val').textContent = o.cover < 0 ? 'auto' : o.cover + '%';
  };
  for (const el of Object.values(dbg)) if (el.tagName !== 'DIV') el.addEventListener('input', sync);
  const nowLocal = new Date();
  dbg.month.value = String(new Date().getMonth());
  dbg.hour.value = String(nowLocal.getHours() + nowLocal.getMinutes() / 60);
  sync();

  let lastStatus = 0;
  return {
    update(dt, tNow) {
      if (state.poster) paintHeld();
      edgeScroll();
      syncHistory();
      const target = VIEWS[state.view];
      const cam = state.camera, k = 1 - Math.exp(-dt * 6);
      cam.cx = lerp(cam.cx, target.cx, k); cam.cy = lerp(cam.cy, target.cy, k); cam.s = lerp(cam.s, target.s, k);
      if (state.view !== 'scene' && !settled && Math.abs(cam.s - target.s) < 0.08) {
        settled = true;
        if (CLOSEUPS[state.view]) state.closeup = state.view;   // the close-up painting lands as the zoom settles
        if (!twoStep(state.view)) showPanel(state.view);
      }
      if (state.view === 'scene' && cam.s < 1.02) { cam.s = 1; cam.cx = W / 2; cam.cy = H / 2; }

      const viewLabel = HOTSPOTS.find((h) => h.id === state.view)?.label ?? '';
      const hint = twoStep(state.view) && settled && !bandOpen ? (COMPACT.matches ? ' · tap to pin a note' : ' · click to pin a note') : '';
      const line = state.view === 'scene' ? (state.hover ? state.hoverLabel : '') : state.poster ? (state.poster.poster ? 'a poster' : 'a note') + ' · click to put it back' : state.placing ? (state.placing.held ? 'let go to pin it there' : COMPACT.matches ? 'drag it where you like, or tap the cork' : 'click where it goes · esc to go back') : viewLabel + (state.hover === 'note' ? ' · ' + state.hoverLabel : hint);
      if (state.view === 'scene' && state.hover === 'flight' && line.includes(' · ')) {
        // a flight's callsign in capitals, the rest of its line in the caption's lowercase (the user, 2026-10-22)
        const cut = line.indexOf(' · ');
        const head = document.createElement('span'); head.className = 'caps'; head.textContent = line.slice(0, cut);
        caption.replaceChildren(head, document.createTextNode(line.slice(cut)));
      } else caption.textContent = line;

      if (tNow - lastStatus > 1000) {
        lastStatus = tNow;
        const w = state.weatherShown, env = state.env;
        const bits = ['a place, sort of.  liminally MSLA, MT, USA, EARTH.', formatTime(state.now).toLowerCase()];
        if (w.temp != null) bits.push(Math.round(w.temp) + '°f');
        bits.push(w.ok ? env.cond.label : 'weather unavailable');
        const r = window.__liminal && window.__liminal.renderer;
        if (r && !r.terrainKey) bits.push(r.diag && r.diag.errors.length ? 'scene failed to load, add ?diag to the address for details' : 'lighting the scene…');
        status.textContent = (state.override.enabled ? 'preview · ' : '') + bits.join(' · ');
        if (!$('debug').hidden) {
          const rg = state.weather.ridge, since = peakSnowSince();
          const peaks = rg ? `summit ${Math.round(rg.temp)}°f, ${Math.round(rg.snowDepth * 100)} cm` : 'summit n/a';
          const bare = peakSnowBareSince();
          const latch = peakSnowLatched(state.now) ? `snowed in since ${since.getMonth() + 1}/${since.getDate()}` + (bare ? `, summit bare since ${bare.getMonth() + 1}/${bare.getDate()}, ${(peakSnowMelt(state.now) * 100) | 0}% left` : '') : 'no first snow yet';
          dbg.info.textContent = `sun alt ${env.sun.altitude.toFixed(1)}° az ${env.sun.azimuth.toFixed(0)}°  moon ${(env.moon.phase * 100) | 0}%\ncover ${(env.cond.cover * 100) | 0}%  snow ${env.snowAmount.toFixed(2)}  ground snow ${env.groundSnow}\npeaks: ${peaks}, ${latch}\nwind ${env.wind.speed} mph from ${env.wind.dir}°  gliders ${r && r.fx ? r.fx.gliders.list.length : 0} up, chance ${gliderChance(env).toFixed(2)}\nplanets up: ${planetSpots.map((s) => `${s.label} ${s.mag.toFixed(1)} alt ${s.altitude.toFixed(0)}° az ${s.azimuth.toFixed(0)}°`).join(', ') || 'none in frame'}`;
        }
      }
    },
  };
}

// The words for the views without a form of their own: lines (each with a class) and buttons
// (`leave` steps back, anything else opens the note form).
const PANELS = {
  board: (state) => ({
    lines: [
      ['Paper, pins, sun-bleached corners. Some of these have been here a long time.', 'line'],
      // with a close-up painting the notes are readable on the cork itself; otherwise list them
      ...(CLOSEUPS.board ? [] : state.notes.map((n) => [`“${oneLine(n.text)}” · ${n.mine ? 'yours · ' : ''}${ageLabel(n.age)}`, 'line quote'])),
      [notesMode() === 'api' ? 'Anyone who stops here can read these.' : 'Whatever you pin stays in this browser.', 'line dim'],
    ],
    actions: [['pin a note', 'compose'], ['step back', 'leave']],
  }),
  bench: (state) => {
    const t = state.weatherShown.temp;
    const feel = t == null ? '' : t < 32 ? ' The slats bite with cold.' : t < 55 ? ' The wood is cool through your jacket.' : t > 85 ? ' The wood is warm, almost hot.' : ' The wood is warm from the day.';
    return {
      lines: [['You sit.' + feel, 'line'], ['Nobody comes. That’s fine. The mountains don’t need you to do anything.', 'line']],
      actions: [['get up', 'leave']],
    };
  },
};
function ageLabel(a) { return a < 0.08 ? 'new' : a < 0.3 ? 'a while' : a < 0.7 ? 'months' : 'faded'; }
