import { createState, W, H, META, LAT, LON, SEASON_SNOW, localParts, overrideDate } from './state.js';
import { fetchWeather, conditionsFromCode, WEATHER_PRESETS } from './weather.js';
import { sunPosition, moonPhase } from './util/solar.js';
import { skyPalette } from './palette.js';
import { Renderer } from './render/renderer.js';
import { makeNote } from './render/props.js';
import { setupUI } from './ui.js';
import { loadBackdrop } from './assets.js';

const state = createState();
const NOTE_TEXTS = ['lost: orange cat, answers to "biscuit"', 'free piano. you haul.', 'open mic thursdays', 'room for rent, quiet house', 'the river is low this year', 'call me'];
state.notes = META.notes.map(([x, y, w, h, paper, age], i) => makeNote(NOTE_TEXTS[i % NOTE_TEXTS.length], { x, y, w, h, paper, age }));
state.notesVersion = 1;

const T0 = performance.now();
const bootErrors = [];
// errors go to the diag overlay: into bootErrors until the renderer exists, then straight to it
const report = (msg) => { const r = window.__liminal && window.__liminal.renderer; if (r) r.diag.errors.push(msg); else bootErrors.push(msg); };
window.addEventListener('error', (e) => report('page: ' + (e.message || e.type) + (e.filename ? ' @' + e.filename.split('/').pop() + ':' + e.lineno : '')));
window.addEventListener('unhandledrejection', (e) => report('promise: ' + (e.reason && e.reason.message || e.reason)));
let assets = null;
try { assets = await loadBackdrop(); }
catch (err) { console.warn('backdrop failed to load', err); bootErrors.push('assets: ' + (err && err.message || err)); }
const T_ASSETS = Math.round(performance.now() - T0);

const canvas = document.getElementById('scene');
canvas.width = W; canvas.height = H;
const renderer = new Renderer(canvas, assets);
window.__liminal = { state, renderer };   // for the screenshot/profiling tools
renderer.diag.stages.unshift(['assets loaded', T_ASSETS]);
renderer.diag.errors.push(...bootErrors);
// ?diag shows what the page is doing, so a failing device can report it without dev tools
if (/[?&]diag\b/.test(location.search)) {
  let frames = 0;
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99;background:rgba(0,0,0,.85);color:#cfe;font:12px/1.4 monospace;padding:8px;max-width:90vw;white-space:pre-wrap;';
  document.body.appendChild(box);
  setInterval(() => {
    const d = renderer.diag;
    frames++;
    box.textContent = `liminal bench diag  ${W}x${H}  worker=${renderer.useWorker} ready=${renderer.workerReady}  frames=${frameCount}\n`
      + `weather: ${d.weather || 'pending'}  cover=${state.env.cond.cover}  ${state.env.cond.label}\n`
      + d.stages.map(([n, t]) => `${String(t).padStart(6)}ms  ${n}`).join('\n')
      + (d.errors.length ? '\nERRORS:\n' + d.errors.join('\n') : '\nno errors')
      + `\n${navigator.userAgent}`;
  }, 500);
}
const ui = setupUI(state, canvas);

function computeEnv() {
  const o = state.override;
  const now = o.enabled ? overrideDate(o.month, o.hour) : new Date();
  state.now = now;
  const { month, hour: hourLocal, minute } = localParts(now);
  let w = state.weather;
  if (o.enabled && o.weather !== 'live') w = { ...w, ok: true, ...WEATHER_PRESETS[o.weather] };
  state.weatherShown = w;
  let cover = w.cover;
  if (o.enabled && o.cover >= 0) cover = o.cover / 100;
  const cond = { ...conditionsFromCode(w.code), cover };
  // Inversion: fog in a cold month means the valley is a sea of fog with the ranges above it.
  // Mountain fog: low cloud hanging on the slopes.
  const preset = o.enabled && o.weather !== 'live' ? WEATHER_PRESETS[o.weather] : null;
  const cold = month >= 10 || month <= 1 || (w.temp != null && w.temp < 36);
  const inversion = preset ? (preset.inversion || 0) : (cond.fog && cold ? 1 : 0);
  let mountainFog = preset ? (preset.lowcloud || 0) : Math.max(0, Math.min(1, ((w.coverLow ?? 0) - 0.5) / 0.35));
  if (!preset && cond.precip.intensity > 0) mountainFog = Math.max(mountainFog, cond.precip.intensity * 0.6);
  if (inversion) { cond.fog = false; cond.label = 'inversion'; }
  else if (mountainFog > 0.5 && !cond.fog && cond.precip.intensity === 0) cond.label = 'low clouds';
  // Overnight dusting on the hills, melting from the bottom up with hours above freezing.
  const dustAmount = preset ? (preset.freshSnow || 0) : Math.min(1, (w.freshSnow || 0) / 2);
  const thawHours = preset ? Math.max(0, hourLocal + minute / 60 - 7.5) : (w.thawHours || 0);
  const dusting = { amount: dustAmount, thaw: thawHours };
  // Which clouds, from the three cover bands (Open-Meteo reports low, mid and high separately):
  // high thin -> cirrus, high thick -> cirrostratus veil; mid -> altocumulus fields or an
  // altostratus veil; low -> fair cumulus, a lumpy stratocumulus sheet when it closes up, flat
  // stratus in fog, dark nimbostratus under precipitation; a cumulonimbus in a storm.
  const low = w.coverLow ?? cover, mid = w.coverMid ?? 0, high = w.coverHigh ?? 0;
  const veilHigh = Math.max(0, Math.min(1, (high - 0.6) / 0.4)), veilMid = Math.max(0, Math.min(1, (mid - 0.7) / 0.3));
  const wet = cond.precip.intensity > 0 || cond.storm;
  const sky = {
    cirrus: high * (1 - veilHigh), veilHigh, alto: mid * (1 - veilMid), veilMid,
    nimbo: cond.storm ? 0.45 : wet ? Math.max(0.7, low) : 0,   // a storm's sheet is broken so the cell shows against sky
    stratus: !wet && (cond.fog || preset?.stratus) ? Math.max(0.8, low) : 0,
    strato: !wet && !cond.fog && !preset?.stratus ? Math.max(0, Math.min(1, (low - 0.55) / 0.3)) : 0,
    cumulus: 0, cb: cond.storm ? 1 : 0,
  };
  sky.cumulus = wet || cond.fog || preset?.stratus ? 0 : low * (1 - sky.strato * 0.75);
  const sun = sunPosition(now, LAT, LON);
  const phase = moonPhase(now);
  let moon = { ...sunPosition(new Date(now.getTime() - phase * 86400000), LAT, LON), phase };
  if (o.enabled && o.moon !== 'live') moon = { ...moon, ...{ full: { phase: 0.5, altitude: 40, azimuth: 160 }, half: { phase: 0.25, altitude: 30, azimuth: 200 }, low: { phase: 0.5, altitude: 11, azimuth: 140 }, none: { altitude: -20 } }[o.moon] };
  const pal = skyPalette(sun.altitude, cond);
  let snowAmount = SEASON_SNOW[month];
  if (w.snowDepth > 0.05) snowAmount = Math.max(snowAmount, 0.65);
  if (cond.precip.type === 'snow') snowAmount = Math.max(snowAmount, 0.5);
  const liveData = w.ok && !(o.enabled && o.weather !== 'live');
  const groundSnow = w.snowDepth > 0.02
    || (cond.precip.type === 'snow' && (w.temp == null || w.temp <= 33))
    || (!liveData && SEASON_SNOW[month] >= 0.95); // no real data: assume a white valley floor in deep winter
  const sunSide = sun.azimuth < 180 ? 1 : -1;
  const a2 = Math.round(sun.altitude * 2), c1 = cover.toFixed(1);
  const ambientKey = pal.ambient.map((v) => v.toFixed(2)).join(',');
  const moonKey = `${Math.round(moon.altitude / 4)}|${moon.phase.toFixed(1)}`;
  state.env = {
    now, month, sun, moon, pal, cond, snowAmount, groundSnow, sunSide, inversion, mountainFog, dusting, sky,
    wind: { speed: w.wind ?? 0, dir: w.windDir ?? 270 },
    skyKey: `${a2}|${Math.round(sun.azimuth / 2)}|${c1}|${cond.fog}|${cond.storm}|${cond.precip.intensity}`,
    terrainKey: `${a2}|${sunSide}|${c1}|${cond.fog}|${snowAmount.toFixed(2)}|${groundSnow}|${month}|${cond.precip.type}|${ambientKey}|${moonKey}|${inversion}|${mountainFog.toFixed(1)}|${dusting.amount.toFixed(2)}|${dusting.thaw.toFixed(1)}`,
    sheetKey: `${a2}|${Math.round(sun.azimuth / 4)}|${c1}|${['cirrus','veilHigh','alto','veilMid','strato','stratus','nimbo'].map((k) => sky[k].toFixed(1)).join(',')}|${moonKey}|${cond.storm}|${Math.sin(w.windDir * Math.PI / 180) >= 0 ? 1 : -1}`,
    ambientKey,
  };
}

async function refreshWeather() {
  try { state.weather = await fetchWeather(); renderer.diag.weather = 'ok ' + new Date().toLocaleTimeString(); }
  catch (err) { console.warn('weather fetch failed', err); state.weather.ok = false; renderer.diag.weather = 'failed: ' + (err && err.message || err); }
}
refreshWeather();
setInterval(refreshWeather, 10 * 60 * 1000);

let last = performance.now();
let frameCount = 0;
function frame(ts) {
  frameCount++;
  const dt = Math.min(0.05, (ts - last) / 1000); last = ts;
  computeEnv();
  ui.update(dt, ts);
  renderer.render(state, ts / 1000, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
