import { createState, W, H, META, LAT, LON, SEASON_SNOW, localParts, overrideDate } from './state.js';
import { fetchWeather, conditionsFromCode, WEATHER_PRESETS } from './weather.js';
import { fetchCams, camCover, camFog } from './cams.js';
import { sunPosition, moonPhase, siderealDeg } from './util/solar.js';
import { dustingTables, presetHours } from './dusting.js';
import { skyPalette } from './palette.js';
import { Renderer } from './render/renderer.js';
import { setupUI } from './ui.js';
import { loadBackdrop } from './assets.js';
import { peakSnowAmount, updatePeakSnowLatch, PEAK_BARE, PEAK_FIRST } from './season.js';
import { loadPosted, buildNotes, whenPosterLoads } from './notes.js';

const state = createState();
// the painting's default notes at once; whatever has been pinned lands when the store answers
state.notes = buildNotes();
state.notesVersion = 1;
const refreshNotes = () => { state.notes = buildNotes(); state.notesVersion++; };
state.loaded = false; state.notesSettled = false; state.weatherSettled = false;   // the loading screen waits on these
loadPosted().then(refreshNotes, refreshNotes).finally(() => { state.notesSettled = true; });
whenPosterLoads(refreshNotes);   // a poster's picture landing is a change on the cork
setInterval(refreshNotes, 10 * 60 * 1000);   // paper ages

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
      + `weather: ${d.weather || 'pending'}  cover=${state.env.cond.cover}  ${state.env.cond.label}  cams: ${d.cams || 'pending'}\n`
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
  else {
    // the fog and the cumulus the webcams see and the feed does not (src/cams.js): a flat KPAX
    // frame is fog in the valley, the low cover raised to the cloud the cams see
    const fogC = camFog(state.cams, w, now);
    if (fogC) w = { ...w, ...fogC };
    const cam = camCover(state.cams, w, now);
    if (cam) w = { ...w, ...cam };
  }
  state.weatherShown = w;
  let cover = w.cover;
  if (o.enabled && o.cover >= 0) cover = o.cover / 100;
  const cond = { ...conditionsFromCode(w.code), cover };
  // How much the clouds actually take out of the light: a low deck shades the valley, a middle
  // one most of the way, a high veil hardly at all (and at sunset it is the sky that goes pink
  // end to end). `cover` stays the total for what a veil does hide: stars, the Milky Way, meteors.
  cond.shade = w.coverLow != null ? Math.min(1, (w.coverLow ?? 0) + (w.coverMid ?? 0) * 0.7 + (w.coverHigh ?? 0) * 0.25) : cover;
  if (o.enabled && o.cover >= 0) cond.shade = cover;
  if (cond.label === 'overcast' && (w.coverLow ?? 1) < 0.4 && (w.coverMid ?? 1) < 0.4) cond.label = 'high overcast';
  // Inversion: fog in a cold month means the valley is a sea of fog with the ranges above it
  // and a clear sky over it; fogTop is how far up the slopes the sea reaches (0: the valley
  // floor, as the feed's own fog code is taken; 1: the cams have it up the South Hills). A
  // version that put the bench inside the fog (the hills into the cloud, the sky a veil, the
  // meadow stippled) was tried on 2026-10-15 and was "much worse": the sea it is, clear sky.
  // Mountain fog: low cloud on the slopes.
  const preset = o.enabled && o.weather !== 'live' ? WEATHER_PRESETS[o.weather] : null;
  const cold = month >= 10 || month <= 1 || (w.temp != null && w.temp < 36);
  const inversion = preset ? (preset.inversion || 0) : (cond.fog && cold ? 1 : 0);
  const fogTop = inversion ? (preset ? (preset.fogTop || 0) : (w.fogTop || 0)) : 0;
  let mountainFog = preset ? (preset.lowcloud || 0) : Math.max(0, Math.min(1, ((w.coverLow ?? 0) - 0.5) / 0.35));
  if (!preset && cond.precip.intensity > 0) mountainFog = Math.max(mountainFog, cond.precip.intensity * 0.6);
  if (inversion) { cond.fog = false; cond.label = 'inversion'; }
  else if (mountainFog > 0.5 && !cond.fog && cond.precip.intensity === 0) cond.label = 'low clouds';
  // Blowing snow, as they call it: wind over loose snow, on the ground or in the air, from about
  // 15 mph, a full blizzard by 30. The feed never names it; wind and snow together do. It fills
  // the air with streaks and takes the mountains into a whiteout (mountainFog); the sky keeps
  // its color, a blizzard is white, not gray.
  const snowing = cond.precip.type === 'snow' && cond.precip.intensity > 0;
  const loose = snowing || (w.freshSnow || 0) > 0.5 || (w.snowDepth || 0) > 0.05;
  const windMph = w.wind ?? 0;
  const blowing = loose && !inversion && (w.temp == null || w.temp <= 34) ? Math.max(0, Math.min(1, (windMph - 15) / 15)) : 0;
  if (blowing > 0) {
    mountainFog = Math.max(mountainFog, 0.45 + 0.55 * blowing);
    cond.label = snowing && (cond.precip.intensity >= 0.6 || windMph >= 30) ? 'blizzard' : 'blowing snow';
    if (!snowing) cond.precip = { type: 'snow', intensity: 0.25 + 0.25 * blowing };   // snow in the air, off the ground
  }
  cond.blowing = blowing;
  // The overnight dusting on the hills: the valley feed lapsed to each plane and budgeted hour
  // by hour, fall against melt (src/dusting.js); a preset gets a made-up night of snow.
  const dusting = dustingTables(preset ? presetHours(now, hourLocal, (preset.freshSnow || 0) * 3) : (w.hours || []));
  // the grass greening back up after a warm week's rain (weather.js reads it off the week's feed)
  const greenup = preset ? (preset.greenup || 0) : Math.max(0, Math.min(1, w.greenup || 0));
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
  const lst = siderealDeg(now, LON);
  const phase = moonPhase(now);
  let moon = { ...sunPosition(new Date(now.getTime() - phase * 86400000), LAT, LON), phase };
  if (o.enabled && o.moon !== 'live') moon = { ...moon, ...{ full: { phase: 0.5, altitude: 40, azimuth: 160 }, half: { phase: 0.25, altitude: 30, azimuth: 200 }, low: { phase: 0.5, altitude: 11, azimuth: 140 }, none: { altitude: -20 } }[o.moon] };
  const pal = skyPalette(sun.altitude, cond, sky);
  const liveData = w.ok && !(o.enabled && o.weather !== 'live');
  // Snow on the peaks: the summit weather and its latch decide when it arrives, the month table
  // how deep it gets (src/season.js); the debug panel can force any state of it.
  const peaks = o.enabled ? o.peaks : 'live';
  let snowAmount = peaks === 'bare' ? PEAK_BARE : peaks === 'first' ? PEAK_FIRST : peaks === 'winter' ? Math.max(SEASON_SNOW[month], 0.5)
    : peakSnowAmount(month, now, preset ? null : w.ridge);
  if (w.snowDepth > 0.05) snowAmount = Math.max(snowAmount, 0.65);
  if (cond.precip.type === 'snow') snowAmount = Math.max(snowAmount, 0.5);
  const groundSnow = w.snowDepth > 0.02
    || (cond.precip.type === 'snow' && (w.temp == null || w.temp <= 33))
    || (!liveData && SEASON_SNOW[month] >= 0.95); // no real data: assume a white valley floor in deep winter
  const sunSide = sun.azimuth < 180 ? 1 : -1;
  const a2 = Math.round(sun.altitude * 2), c1 = cover.toFixed(1) + '/' + cond.shade.toFixed(1);
  const ambientKey = pal.ambient.map((v) => v.toFixed(2)).join(',');
  const moonKey = `${Math.round(moon.altitude / 4)}|${moon.phase.toFixed(1)}`;
  state.env = {
    now, month, sun, moon, lst, pal, cond, snowAmount, groundSnow, sunSide, inversion, fogTop, mountainFog, dusting, greenup, sky,
    wind: { speed: w.wind ?? 0, dir: w.windDir ?? 270 },
    skyKey: `${a2}|${Math.round(sun.azimuth / 2)}|${c1}|${cond.fog}|${cond.storm}|${cond.precip.intensity}|${sun.altitude < -6 ? Math.round(lst / 1.5) + '|' + moon.phase.toFixed(1) + '|' + Math.round(moon.altitude / 10) : ''}`,
    terrainKey: `${a2}|${sunSide}|${c1}|${cond.fog}|${snowAmount.toFixed(2)}|${groundSnow}|${month}|${cond.precip.type}|${ambientKey}|${moonKey}|${inversion}|${fogTop.toFixed(2)}|${mountainFog.toFixed(1)}|${dusting.key}|${greenup.toFixed(2)}`,
    sheetKey: `${a2}|${Math.round(sun.azimuth / 4)}|${c1}|${['cirrus','veilHigh','alto','veilMid','strato','stratus','nimbo'].map((k) => sky[k].toFixed(1)).join(',')}|${moonKey}|${cond.storm}|${Math.sin(w.windDir * Math.PI / 180) >= 0 ? 1 : -1}`,
    ambientKey,
  };
}

async function refreshWeather() {
  try {
    state.weather = await fetchWeather();
    updatePeakSnowLatch(state.weather.ridge, new Date());
    const rg = state.weather.ridge;
    renderer.diag.weather = 'ok ' + new Date().toLocaleTimeString() + (rg ? ` · summit ${Math.round(rg.temp)}°f, ${Math.round(rg.snowDepth * 100)} cm snow` : ' · summit unavailable');
  }
  catch (err) { console.warn('weather fetch failed', err); state.weather.ok = false; renderer.diag.weather = 'failed: ' + (err && err.message || err); }
  state.weatherSettled = true;
}
refreshWeather();
setInterval(refreshWeather, 10 * 60 * 1000);

// The webcams' cumulus (src/cams.js), read in the background: never waited on, and nothing
// changes when they are absent (the dev server without its proxy, GitHub Pages, a cam down).
async function refreshCams() {
  try {
    state.cams = await fetchCams();
    const c = state.cams;
    renderer.diag.cams = (c.ok ? `cumulus ${c.cumulus.toFixed(2)}, fog ${c.fog == null ? 'n/a' : c.fog.toFixed(2)}, high ${c.fogHigh == null ? 'n/a' : c.fogHigh.toFixed(2)}` : 'none') + ' · '
      + Object.entries(c.cams).map(([id, r]) => `${id} ${r.error ? 'failed' : r.cloud == null ? 'dark' : `cloud ${r.cloud.toFixed(2)} tex ${r.tex == null ? '?' : r.tex.toFixed(1)}`}`).join(', ');
  }
  catch (err) { console.warn('cams failed', err); renderer.diag.cams = 'failed: ' + (err && err.message || err); }
}
refreshCams();
setInterval(refreshCams, 10 * 60 * 1000);

// The loading screen stays up until the first frame that has everything: the weather answered
// (or failed), the pinned notes in, and the sky, the cloud sheets and the terrain all rendered for
// the current environment, so the painting never shows unlit and the weather never pops in over
// it. A watchdog lifts it anyway after a while (an offline page, a worker that fell back, a slow
// phone), so the scene, and the status line's advice, are always reachable.
const loading = document.getElementById('loading'), loadingStatus = document.getElementById('loading-status'), loadingDots = document.getElementById('loading-dots');
const LOADING_MAX_MS = 45000;
let loadingShown = '';
function updateLoading(ts) {
  if (state.loaded) return;
  const env = state.env, r = renderer;
  const lit = r.terrainKey === env.terrainKey && r.skyKey === env.skyKey && r.sheetKey === env.sheetKey;
  const ready = (state.weatherSettled && state.notesSettled && lit) || performance.now() - T0 > LOADING_MAX_MS;
  if (ready) {
    state.loaded = true;
    renderer.stage('loading screen down');
    loading.classList.add('done');
    setTimeout(() => { loading.hidden = true; }, 600);
    return;
  }
  const msg = !state.weatherSettled ? 'asking about the weather' : !lit ? 'lighting the scene' : 'reading the board';
  if (msg !== loadingShown) { loadingShown = msg; loadingStatus.firstChild.nodeValue = msg; }
  loadingDots.textContent = '.'.repeat(1 + Math.floor(ts / 400) % 3);
}
// a watchdog that fires even if the frame loop never runs (a renderer that threw at boot)
setTimeout(() => { if (!state.loaded) { state.loaded = true; loading.classList.add('done'); setTimeout(() => { loading.hidden = true; }, 600); } }, LOADING_MAX_MS + 1000);

let last = performance.now();
let frameCount = 0;
function frame(ts) {
  frameCount++;
  const dt = Math.min(0.05, (ts - last) / 1000); last = ts;
  computeEnv();
  ui.update(dt, ts);
  renderer.render(state, ts / 1000, dt);
  updateLoading(ts);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
