import { createState, LAT, LON, SEASON_SNOW, localParts, overrideDate } from './state.js';
import { fetchWeather, conditionsFromCode, WEATHER_PRESETS } from './weather.js';
import { sunPosition, moonPhase } from './util/solar.js';
import { skyPalette } from './palette.js';
import { Renderer } from './render/renderer.js';
import { makeNote } from './render/props.js';
import { setupUI } from './ui.js';

const state = createState();
state.notes = [
  makeNote('lost: orange cat, answers to "biscuit"', { x: 140, y: 312, w: 34, h: 26, paper: 1, age: 0.55 }),
  makeNote('free piano. you haul.', { x: 182, y: 318, w: 30, h: 20, paper: 0, age: 0.2 }),
  makeNote('open mic thursdays', { x: 222, y: 310, w: 38, h: 24, paper: 2, age: 0.85 }),
  makeNote('room for rent, quiet house', { x: 150, y: 352, w: 40, h: 28, paper: 3, age: 0.05 }),
  makeNote('the river is low this year', { x: 205, y: 356, w: 32, h: 22, paper: 4, age: 0.4 }),
  makeNote('call me', { x: 248, y: 350, w: 22, h: 18, paper: 5, age: 0.7 }),
];
state.notesVersion = 1;

const canvas = document.getElementById('scene');
const renderer = new Renderer(canvas);
const ui = setupUI(state, canvas);

function computeEnv() {
  const o = state.override;
  const now = o.enabled ? overrideDate(o.month, o.hour) : new Date();
  state.now = now;
  const { month } = localParts(now);
  let w = state.weather;
  if (o.enabled && o.weather !== 'live') w = { ...w, ok: true, ...WEATHER_PRESETS[o.weather] };
  state.weatherShown = w;
  let cover = w.cover;
  if (o.enabled && o.cover >= 0) cover = o.cover / 100;
  const cond = { ...conditionsFromCode(w.code), cover };
  const sun = sunPosition(now, LAT, LON);
  const phase = moonPhase(now);
  const moon = { ...sunPosition(new Date(now.getTime() - phase * 86400000), LAT, LON), phase };
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
  state.env = {
    now, month, sun, moon, pal, cond, snowAmount, groundSnow, sunSide,
    wind: { speed: w.wind ?? 0, dir: w.windDir ?? 270 },
    skyKey: `${a2}|${Math.round(sun.azimuth / 2)}|${c1}|${cond.fog}|${cond.storm}|${cond.precip.intensity}`,
    terrainKey: `${a2}|${sunSide}|${c1}|${cond.fog}|${snowAmount.toFixed(2)}|${groundSnow}|${month}|${cond.precip.type}|${ambientKey}`,
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
