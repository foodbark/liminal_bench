import { W, H, META, formatTime } from './state.js';
import { HOTSPOTS } from './render/props.js';
import { lerp, clamp } from './util/pixel.js';

const VIEWS = { scene: { cx: W / 2, cy: H / 2, s: 1 }, ...META.views };

export function setupUI(state, canvas) {
  const $ = (id) => document.getElementById(id);
  const caption = $('caption-text'), status = $('status'), panel = $('panel');
  const pTitle = $('panel-title'), pBody = $('panel-body'), pActions = $('panel-actions');
  let panelShown = false, panelFor = null;

  function fitStage() {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    document.documentElement.style.setProperty('--s', s);
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
    if (e.key === 'Escape') leave();
    if (e.key === 'd' || e.key === 'D') { const d = $('debug'); d.hidden = !d.hidden; }
  });

  function enter(view) { state.view = view; state.hover = null; canvas.classList.remove('hot'); }
  function leave() { state.view = 'scene'; hidePanel(); }
  function hidePanel() { panel.hidden = true; panelShown = false; panelFor = null; }
  function showPanel(view) {
    panelShown = true; panelFor = view;
    const content = PANELS[view](state, { leave, showPanel });
    pTitle.textContent = content.title;
    pBody.innerHTML = content.body;
    pActions.innerHTML = '';
    for (const [label, fn] of content.actions) {
      const b = document.createElement('button'); b.textContent = label; b.onclick = fn; pActions.appendChild(b);
    }
    panel.className = 'dock-' + (VIEWS[view].dock || 'center');
    panel.hidden = false;
  }

  // debug controls
  const dbg = { enabled: $('dbg-enabled'), hour: $('dbg-hour'), month: $('dbg-month'), weather: $('dbg-weather'), cover: $('dbg-cover'), moon: $('dbg-moon'), info: $('dbg-info') };
  const sync = () => {
    const o = state.override;
    o.enabled = dbg.enabled.checked; o.hour = +dbg.hour.value; o.month = +dbg.month.value; o.weather = dbg.weather.value; o.cover = +dbg.cover.value; o.moon = dbg.moon.value;
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
      if (state.view !== 'scene' && !panelShown && Math.abs(cam.s - target.s) < 0.08) showPanel(state.view);
      if (state.view === 'scene' && cam.s < 1.02) { cam.s = 1; cam.cx = W / 2; cam.cy = H / 2; }

      const hot = HOTSPOTS.find((h) => h.id === state.hover);
      caption.textContent = state.view === 'scene' ? (hot ? hot.label : '') : (HOTSPOTS.find((h) => h.id === state.view)?.label ?? '');

      if (tNow - lastStatus > 1000) {
        lastStatus = tNow;
        const w = state.weatherShown, env = state.env;
        const bits = ['missoula, mt', formatTime(state.now).toLowerCase()];
        if (w.temp != null) bits.push(Math.round(w.temp) + '°f');
        bits.push(w.ok ? env.cond.label : 'weather unavailable');
        status.textContent = (state.override.enabled ? 'preview · ' : '') + bits.join(' · ');
        if (!$('debug').hidden) dbg.info.textContent = `sun alt ${env.sun.altitude.toFixed(1)}° az ${env.sun.azimuth.toFixed(0)}°  moon ${(env.moon.phase * 100) | 0}%\ncover ${(env.cond.cover * 100) | 0}%  snow ${env.snowAmount.toFixed(2)}  ground snow ${env.groundSnow}\nwind ${env.wind.speed} mph from ${env.wind.dir}°`;
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
  board: (state) => ({
    title: 'bulletin board',
    body: 'Paper, pins, sun-bleached corners. Some of these have been here a long time.'
      + '<ul class="list">' + state.notes.map((n) => `<li>${escapeHtml(n.text)} <span>${ageLabel(n.age)}</span></li>`).join('') + '</ul>',
    actions: [
      ['pin a note', () => { document.getElementById('panel-body').innerHTML = 'You pat your pockets. No pen. (posting is coming)'; }],
      ['step back', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
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
