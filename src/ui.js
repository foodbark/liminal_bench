import { W, H, META, formatTime } from './state.js';
import { HOTSPOTS, CLOSEUPS, closeupNotes } from './render/props.js';
import { lerp, clamp } from './util/pixel.js';
import { postNote, buildNotes, notesMode, NOTE_MAX, tearDown, postPoster } from './notes.js';
import { peakSnowLatched, peakSnowSince } from './season.js';
import { gliderChance } from './render/gliders.js';
import { planetSpots, starSpots } from './render/sky.js';
import { Phone, loadPhoneBook, phoneBook, formatNumber, MESSAGE_MAX } from './phone.js';
import { pixelate } from './pixelate.js';
import { hasItem, give, inventory } from './items.js';

const VIEWS = { scene: { cx: W / 2, cy: H / 2, s: 1 }, ...META.views };
// screens where a panel over a close-up would cover what it describes: touch, or a short window
const COMPACT = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse), (max-height: 520px)') : { matches: false };

export function setupUI(state, canvas) {
  const $ = (id) => document.getElementById(id);
  const caption = $('caption-text'), status = $('status'), panel = $('panel');
  const pTitle = $('panel-title'), pBody = $('panel-body'), pActions = $('panel-actions');
  let panelShown = false, panelFor = null, settled = false;
  // the pay phone: lifted when its panel opens, hung up when the visitor steps back
  const phone = new Phone({ now: () => state.now, temp: () => state.weatherShown.temp, hasItem, onChange: () => renderPhone() });
  loadPhoneBook().then(() => { if (panelFor === 'phone') renderPhone(true); });
  if (window.__liminal) window.__liminal.items = { give, inventory }; else window.addEventListener('load', () => { if (window.__liminal) window.__liminal.items = { give, inventory }; });
  // A view with a close-up painting shows the prop itself readable, so its panel waits for a
  // second click: the board zooms in on the first, and the next click opens the note form.
  const twoStep = (view) => !!CLOSEUPS[view];

  function fitStage() {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    document.documentElement.style.setProperty('--s', s);
    // shown smaller than its pixels, the scene is scaled smoothly so the dither averages into
    // the soft tones it was drawn for (nearest-neighbor drops rows of the 4x4 pattern and turns
    // it into blotches); shown larger, pixels stay crisp
    canvas.style.imageRendering = s < 1 ? 'auto' : 'pixelated';
    document.documentElement.style.setProperty('--w', W + 'px');
    document.documentElement.style.setProperty('--h', H + 'px');
  }
  fitStage(); window.addEventListener('resize', fitStage);

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
  canvas.addEventListener('mousemove', (e) => {
    if (state.view !== 'scene') {
      const n = state.view === 'board' && !panelShown && !state.poster ? noteAt(e) : null;
      state.hover = n ? 'note' : null; state.hoverLabel = n ? (n.poster ? 'a poster' : `a note: “${n.text}”`) : '';
      canvas.classList.toggle('hot', !!n);
      return;
    }
    const h = hitTest(toWorld(e));
    state.hover = h ? h.id : null; state.hoverLabel = h ? h.label : '';
    canvas.classList.toggle('hot', !!h && !!VIEWS[h.id]);
  });
  canvas.addEventListener('mouseleave', () => { state.hover = null; canvas.classList.remove('hot'); });
  canvas.addEventListener('click', (e) => {
    if (state.view === 'scene') { const h = hitTest(toWorld(e)); if (h && VIEWS[h.id]) enter(h.id); return; }
    if (!twoStep(state.view)) { leave(); return; }         // a panel view: any click steps back
    if (state.poster) { putBack(); return; }               // holding a poster: any click puts it back
    const n = state.view === 'board' ? noteAt(e) : null;   // a note on the cork: offer to tear it down; a poster: hold it up
    if (panelShown) { hidePanel(); if (!n) return; }       // a click off the form puts it away
    if (settled) n ? (n.poster ? holdUp(n) : tearPanel(n)) : (state.view === 'board' ? compose : showPanel)(state.view);
  });
  window.addEventListener('keydown', (e) => {
    // typing into the board's note field must not drive the scene
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'Escape') { if (state.poster) putBack(); else leave(); }
    if (e.key === 'd' || e.key === 'D') { const d = $('debug'); d.hidden = !d.hidden; }
  });
  if (/[?&]debug\b/.test(location.search)) $('debug').hidden = false;   // phones have no D key

  function enter(view) { state.view = view; state.hover = null; settled = false; canvas.classList.remove('hot'); }
  function leave() { state.view = 'scene'; state.closeup = null; state.poster = null; phone.hangUp(); hidePanel(); }
  // A poster held up: the second zoom, the picture large over the dimmed board. Its panel offers
  // to tear it down; a click anywhere, or Escape, puts it back.
  function holdUp(n) {
    state.poster = n; state.hover = null; canvas.classList.remove('hot');
    panelShown = true; panelFor = 'board';
    panel.className = 'dock-left';
    panel.hidden = false;
    pTitle.textContent = 'a poster';
    pBody.innerHTML = '';
    const lead = document.createElement('div'); lead.className = 'dim'; lead.textContent = 'Someone pinned this up.' + (n.mine && notesMode() !== 'api' ? ' It is yours.' : '');
    const err = document.createElement('div'); err.className = 'note-err';
    pBody.append(lead, err);
    pActions.innerHTML = '';
    const tear = document.createElement('button'); tear.textContent = 'tear it down';
    const back = document.createElement('button'); back.textContent = 'put it back'; back.onclick = putBack;
    pActions.append(tear, back);
    tear.onclick = async () => {
      if (tear.disabled) return;
      tear.disabled = true; err.textContent = '';
      try { await tearDown(n); state.notes = buildNotes(); state.notesVersion++; putBack(); }
      catch (e) { err.textContent = e.message || 'it will not come off'; tear.disabled = false; }
    };
  }
  function putBack() { state.poster = null; hidePanel(); }
  function hidePanel() { panel.hidden = true; panelShown = false; panelFor = null; }
  function showPanel(view) {
    if (view === 'phone') return phonePanel();
    panelShown = true; panelFor = view;
    const content = PANELS[view](state, { leave, showPanel, compose });
    pTitle.textContent = content.title;
    pBody.innerHTML = content.body;
    pActions.innerHTML = '';
    for (const [label, fn] of content.actions) {
      const b = document.createElement('button'); b.textContent = label; b.onclick = fn; pActions.appendChild(b);
    }
    panel.className = 'dock-' + (VIEWS[view].dock || 'center');
    // Over a close-up the panel sits on the prop itself. A phone has no room for the words:
    // there the panel folds to its buttons, a strip over the top rail, and the cork stays clear.
    if (CLOSEUPS[view] && COMPACT.matches) panel.classList.add('compact');
    panel.hidden = false;
  }
  // Pinning a note: a scrap of paper, a pencil, one line. Enter or "pin it" posts it.
  function compose() {
    panelShown = true; panelFor = 'board';
    panel.className = 'dock-' + (VIEWS.board.dock || 'center');   // no compact: the form needs its words and its field
    panel.hidden = false;
    pTitle.textContent = 'bulletin board';
    pBody.innerHTML = '';
    const lead = document.createElement('div');
    lead.textContent = 'A pencil stub hangs on a string. You find a blank scrap under the others.';
    const input = document.createElement('input');
    input.id = 'note-text'; input.maxLength = NOTE_MAX; input.placeholder = 'write something'; input.autocomplete = 'off'; input.spellcheck = false;
    const err = document.createElement('div'); err.className = 'note-err';
    // or a poster: a picture from this device, made into pixel art here before it goes anywhere
    const or = document.createElement('div'); or.className = 'dim poster-or'; or.textContent = 'or pin a picture, if you brought one:';
    const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/*'; file.id = 'poster-file';
    const preview = document.createElement('canvas'); preview.className = 'poster-preview'; preview.hidden = true;
    let poster = null;   // { png, w, h } once a picture is pixelated
    file.addEventListener('change', async () => {
      poster = null; preview.hidden = true; err.textContent = '';
      const f = file.files && file.files[0]; if (!f) return;
      err.textContent = 'pixelating…';
      try {
        const bmp = await createImageBitmap(f);
        await new Promise((r) => setTimeout(r, 30));   // let the word show first
        const art = pixelate(bmp, { kind: 'prop' }); bmp.close();
        const c = document.createElement('canvas'); c.width = art.width; c.height = art.height; c.getContext('2d').putImageData(art, 0, 0);
        const png = c.toDataURL('image/png');
        const k = Math.max(1, Math.floor(Math.min(240 / art.width, 240 / art.height)));
        preview.width = art.width * k; preview.height = art.height * k;
        const g = preview.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(c, 0, 0, preview.width, preview.height);
        preview.hidden = false; err.textContent = `${art.width} by ${art.height}, ${art.colors} colors`;
        poster = { png, w: art.width, h: art.height };
      } catch (e) { err.textContent = 'that picture would not take'; }
    });
    pBody.append(lead, input, or, file, preview, err);
    pActions.innerHTML = '';
    const pin = document.createElement('button'); pin.textContent = 'pin it';
    // with the board's close-up the form simply goes away and the cork is there to read
    const done = () => twoStep('board') ? hidePanel() : showPanel('board');
    const never = document.createElement('button'); never.textContent = 'never mind'; never.onclick = done;
    pActions.append(pin, never);
    if (twoStep('board')) { const back = document.createElement('button'); back.textContent = 'step back'; back.onclick = leave; pActions.append(back); }
    const submit = async () => {
      if (pin.disabled) return;
      pin.disabled = true; err.textContent = '';
      try {
        if (poster && !input.value.trim()) await postPoster(poster.png, poster.w, poster.h); else await postNote(input.value);
        state.notes = buildNotes(); state.notesVersion++; done();
      } catch (e) { err.textContent = e.message || 'the pin would not go in'; pin.disabled = false; }
    };
    pin.onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    setTimeout(() => input.focus(), 0);
  }

  // Tearing a note down: anyone can, the way a real board works. A posted note is gone for good;
  // one of the painting's own comes back after a note's life, as if someone put up a fresh one.
  function tearPanel(n) {
    panelShown = true; panelFor = 'board';
    panel.className = 'dock-' + (VIEWS.board.dock || 'center');
    panel.hidden = false;
    pTitle.textContent = 'bulletin board';
    pBody.innerHTML = '';
    const quote = document.createElement('div'); quote.textContent = `“${n.text}”` + (n.mine ? ' (yours)' : '');
    const lead = document.createElement('div'); lead.className = 'dim'; lead.textContent = 'The pin is loose. Nobody would stop you.';
    const err = document.createElement('div'); err.className = 'note-err';
    pBody.append(quote, lead, err);
    pActions.innerHTML = '';
    const tear = document.createElement('button'); tear.textContent = 'tear it down';
    const keep = document.createElement('button'); keep.textContent = 'leave it'; keep.onclick = hidePanel;
    pActions.append(tear, keep);
    tear.onclick = async () => {
      if (tear.disabled) return;
      tear.disabled = true; err.textContent = '';
      try { await tearDown(n); state.notes = buildNotes(); state.notesVersion++; hidePanel(); }
      catch (e) { err.textContent = e.message || 'it will not come off'; tear.disabled = false; }
    };
  }

  // The pay phone's panel: the handset display, the keypad, the phone book, the transcript of
  // what the line says, and the message form when a machine beeps. The keypad is HTML for now;
  // it moves onto the phone's close-up painting when that art arrives.
  let ph = null;   // the panel's live elements
  function phonePanel() {
    panelShown = true; panelFor = 'phone';
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
    if (!ph || panelFor !== 'phone') return;
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
      const hint = twoStep(state.view) && settled && !panelShown ? (COMPACT.matches ? ' · tap to pin a note' : ' · click to pin a note') : '';
      caption.textContent = state.view === 'scene' ? (state.hover ? state.hoverLabel : '') : state.poster ? 'a poster · click to put it back' : viewLabel + (state.hover === 'note' ? ' · ' + state.hoverLabel : hint);

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
          const latch = peakSnowLatched(state.now) ? `snowed in since ${since.getMonth() + 1}/${since.getDate()}` : 'no first snow yet';
          dbg.info.textContent = `sun alt ${env.sun.altitude.toFixed(1)}° az ${env.sun.azimuth.toFixed(0)}°  moon ${(env.moon.phase * 100) | 0}%\ncover ${(env.cond.cover * 100) | 0}%  snow ${env.snowAmount.toFixed(2)}  ground snow ${env.groundSnow}\npeaks: ${peaks}, ${latch}\nwind ${env.wind.speed} mph from ${env.wind.dir}°  gliders ${r && r.fx ? r.fx.gliders.list.length : 0} up, chance ${gliderChance(env).toFixed(2)}\nplanets up: ${planetSpots.map((s) => `${s.label} ${s.mag.toFixed(1)} alt ${s.altitude.toFixed(0)}° az ${s.azimuth.toFixed(0)}°`).join(', ') || 'none in frame'}`;
        }
      }
    },
  };
}

const PANELS = {
  board: (state, api) => ({
    title: 'bulletin board',
    body: 'Paper, pins, sun-bleached corners. Some of these have been here a long time.'
      // with a close-up painting the notes are readable on the cork itself; otherwise list them
      + (CLOSEUPS.board ? '' : '<ul class="list">' + state.notes.map((n) => `<li>${escapeHtml(n.text)} <span>${n.mine ? 'yours · ' : ''}${ageLabel(n.age)}</span></li>`).join('') + '</ul>')
      + '\n<span class="dim">' + (notesMode() === 'api' ? 'Anyone who stops here can read these.' : 'Whatever you pin stays in this browser, for a couple of weeks.') + '</span>',
    actions: [
      ['pin a note', api.compose],
      ['step back', api.leave],
    ],
  }),
  bench: (state, api) => {
    const t = state.weatherShown.temp;
    const feel = t == null ? '' : t < 32 ? ' The slats bite with cold.' : t < 55 ? ' The wood is cool through your jacket.' : t > 85 ? ' The wood is warm, almost hot.' : ' The wood is warm from the day.';
    return {
      title: 'park bench',
      body: 'You sit.' + feel + '\nNobody comes. That’s fine. The mountains don’t need you to do anything.',
      actions: [['get up', api.leave]],
    };
  },
};
function ageLabel(a) { return a < 0.15 ? 'new' : a < 0.4 ? 'a few days' : a < 0.7 ? 'weeks' : 'faded'; }
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
