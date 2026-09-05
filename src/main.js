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

let assets = null;
try { assets = await loadBackdrop(); }
catch (err) { console.warn('backdrop failed to load', err); }

const canvas = document.getElementById('scene');
canvas.width = W; canvas.height = H;
const renderer = new Renderer(canvas, assets);
window.__liminal = { state, renderer };   // for the screenshot/profiling tools
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
  const sun = sunPosition(now, LAT, LON);
  const phase = moonPhase(now);
  let moon = { ...sunPosition(new Date(now.getTime() - phase * 86400000), LAT, LON), phase };
  if (o.enabled && o.moon !== 'live') moon = { ...moon, ...{ full: { phase: 0.5, altitude: 40 }, half: { phase: 0.25, altitude: 30 }, none: { altitude: -20 } }[o.moon] };
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
    now, month, sun, moon, pal, cond, snowAmount, groundSnow, sunSide, inversion, mountainFog, dusting,
    wind: { speed: w.wind ?? 0, dir: w.windDir ?? 270 },
    skyKey: `${a2}|${Math.round(sun.azimuth / 2)}|${c1}|${cond.fog}|${cond.storm}|${cond.precip.intensity}`,
    terrainKey: `${a2}|${sunSide}|${c1}|${cond.fog}|${snowAmount.toFixed(2)}|${groundSnow}|${month}|${cond.precip.type}|${ambientKey}|${moonKey}|${inversion}|${mountainFog.toFixed(1)}|${dusting.amount.toFixed(2)}|${dusting.thaw.toFixed(1)}`,
    ambientKey,
  };
}

async function refreshWeather() {
  try { state.weather = await fetchWeather(); }
  catch (err) { console.warn('weather fetch failed', err); state.weather.ok = false; }
}
refreshWeather();
setInterval(refreshWeather, 10 * 60 * 1000);

let last = performance.now();
function frame(ts) {
  const dt = Math.min(0.05, (ts - last) / 1000); last = ts;
  computeEnv();
  ui.update(dt, ts);
  renderer.render(state, ts / 1000, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
