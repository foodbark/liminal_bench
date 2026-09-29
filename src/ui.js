import { W, H, META, formatTime } from './state.js';
import { HOTSPOTS, CLOSEUPS } from './render/props.js';
import { lerp, clamp } from './util/pixel.js';
import { postNote, buildNotes, notesMode, NOTE_MAX } from './notes.js';
import { peakSnowLatched, peakSnowSince } from './season.js';

const VIEWS = { scene: { cx: W / 2, cy: H / 2, s: 1 }, ...META.views };
// screens where a panel over a close-up would cover what it describes: touch, or a short window
const COMPACT = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse), (max-height: 520px)') : { matches: false };

export function setupUI(state, canvas) {
  const $ = (id) => document.getElementById(id);
  const caption = $('caption-text'), status = $('status'), panel = $('panel');
  const pTitle = $('panel-title'), pBody = $('panel-body'), pActions = $('panel-actions');
  let panelShown = false, panelFor = null;

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
    return null;
  }
  canvas.addEventListener('mousemove', (e) => {
    if (state.view !== 'scene') { state.hover = null; canvas.classList.remove('hot'); return; }
    const h = hitTest(toWorld(e));
    state.hover = h ? h.id : null;
    canvas.classList.toggle('hot', !!h);
  });
  canvas.addEventListener('mouseleave', () => { state.hover = null; canvas.classList.remove('hot'); });
  canvas.addEventListener('click', (e) => {
    if (state.view !== 'scene') { leave(); return; }
    const h = hitTest(toWorld(e));
    if (h) enter(h.id);
  });
  window.addEventListener('keydown', (e) => {
    // typing into the board's note field must not drive the scene
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'Escape') leave();
    if (e.key === 'd' || e.key === 'D') { const d = $('debug'); d.hidden = !d.hidden; }
  });
  if (/[?&]debug\b/.test(location.search)) $('debug').hidden = false;   // phones have no D key

  function enter(view) { state.view = view; state.hover = null; canvas.classList.remove('hot'); }
  function leave() { state.view = 'scene'; state.closeup = null; hidePanel(); }
  function hidePanel() { panel.hidden = true; panelShown = false; panelFor = null; }
  function showPanel(view) {
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
    panel.classList.remove('compact');   // the form needs its words and its field
    pTitle.textContent = 'bulletin board';
    pBody.innerHTML = '';
    const lead = document.createElement('div');
    lead.textContent = 'A pencil stub hangs on a string. You find a blank scrap under the others.';
    const input = document.createElement('input');
    input.id = 'note-text'; input.maxLength = NOTE_MAX; input.placeholder = 'write something'; input.autocomplete = 'off'; input.spellcheck = false;
    const err = document.createElement('div'); err.className = 'note-err';
    pBody.append(lead, input, err);
    pActions.innerHTML = '';
    const pin = document.createElement('button'); pin.textContent = 'pin it';
    const never = document.createElement('button'); never.textContent = 'never mind'; never.onclick = () => showPanel('board');
    pActions.append(pin, never);
    const submit = async () => {
      if (pin.disabled) return;
      pin.disabled = true; err.textContent = '';
      try { await postNote(input.value); state.notes = buildNotes(); state.notesVersion++; showPanel('board'); }
      catch (e) { err.textContent = e.message || 'the pin would not go in'; pin.disabled = false; }
    };
    pin.onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    setTimeout(() => input.focus(), 0);
  }

  // debug controls
  const dbg = { enabled: $('dbg-enabled'), hour: $('dbg-hour'), month: $('dbg-month'), weather: $('dbg-weather'), cover: $('dbg-cover'), moon: $('dbg-moon'), peaks: $('dbg-peaks'), info: $('dbg-info') };
  const sync = () => {
    const o = state.override;
    o.enabled = dbg.enabled.checked; o.hour = +dbg.hour.value; o.month = +dbg.month.value; o.weather = dbg.weather.value; o.cover = +dbg.cover.value; o.moon = dbg.moon.value; o.peaks = dbg.peaks.value;
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
      if (state.view !== 'scene' && !panelShown && Math.abs(cam.s - target.s) < 0.08) {
        if (CLOSEUPS[state.view]) state.closeup = state.view;   // the close-up painting lands as the zoom settles
        showPanel(state.view);
      }
      if (state.view === 'scene' && cam.s < 1.02) { cam.s = 1; cam.cx = W / 2; cam.cy = H / 2; }

      const hot = HOTSPOTS.find((h) => h.id === state.hover);
      caption.textContent = state.view === 'scene' ? (hot ? hot.label : '') : (HOTSPOTS.find((h) => h.id === state.view)?.label ?? '');

      if (tNow - lastStatus > 1000) {
        lastStatus = tNow;
        const w = state.weatherShown, env = state.env;
        const bits = ['missoula, mt', formatTime(state.now).toLowerCase()];
        if (w.temp != null) bits.push(Math.round(w.temp) + '°f');
        bits.push(w.ok ? env.cond.label : 'weather unavailable');
        const r = window.__liminal && window.__liminal.renderer;
        if (r && !r.terrainKey) bits.push(r.diag && r.diag.errors.length ? 'scene failed to load, add ?diag to the address for details' : 'lighting the scene…');
        status.textContent = (state.override.enabled ? 'preview · ' : '') + bits.join(' · ');
        if (!$('debug').hidden) {
          const rg = state.weather.ridge, since = peakSnowSince();
          const peaks = rg ? `summit ${Math.round(rg.temp)}°f, ${Math.round(rg.snowDepth * 100)} cm` : 'summit n/a';
          const latch = peakSnowLatched(state.now) ? `snowed in since ${since.getMonth() + 1}/${since.getDate()}` : 'no first snow yet';
          dbg.info.textContent = `sun alt ${env.sun.altitude.toFixed(1)}° az ${env.sun.azimuth.toFixed(0)}°  moon ${(env.moon.phase * 100) | 0}%\ncover ${(env.cond.cover * 100) | 0}%  snow ${env.snowAmount.toFixed(2)}  ground snow ${env.groundSnow}\npeaks: ${peaks}, ${latch}\nwind ${env.wind.speed} mph from ${env.wind.dir}°`;
        }
      }
    },
  };
}

const PANELS = {
  phone: (state, api) => ({
    title: 'pay phone',
    body: 'The receiver is cold in your hand. A dial tone hums, patient.\nA phone book hangs from a steel cord, its pages soft at the edges.',
    actions: [
      ['phone book', () => {
        document.getElementById('panel-body').innerHTML = 'You flip through it. Most of the pages are blank.\n<ul class="list"><li>nobody yet <span>—</span></li></ul>\n(numbers and voicemail are coming)';
      }],
      ['hang up', api.leave],
    ],
  }),
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
