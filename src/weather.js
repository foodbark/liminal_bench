import { LAT, LON, RIDGE, localHourKey } from './state.js';

const URL = 'https://api.open-meteo.com/v1/forecast'
  + `?latitude=${LAT}&longitude=${LON}`
  + '&current=temperature_2m,weather_code,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_direction_10m,precipitation,snowfall,is_day'
  + '&hourly=snow_depth,snowfall,temperature_2m,precipitation,relative_humidity_250hPa,temperature_250hPa,wind_speed_250hPa,wind_direction_250hPa&past_days=7&forecast_days=1&timezone=America%2FDenver'
  + '&temperature_unit=fahrenheit&wind_speed_unit=mph';
// A week back: the grass greens up again after a few days of rain in warm weather, and that is
// read off the week's hourly rain and temperature, not the current hour.
// The same model lapsed to Dean Stone's summit (Open-Meteo takes an elevation): snow on the
// ridges is decided up there, where the valley station is useless. Three days back, so an
// overnight fall that the current hour has already melted still counts.
const RIDGE_URL = 'https://api.open-meteo.com/v1/forecast'
  + `?latitude=${RIDGE.lat}&longitude=${RIDGE.lon}&elevation=${RIDGE.elevation}`
  + '&hourly=snow_depth,snowfall,temperature_2m&past_days=3&forecast_days=1&timezone=America%2FDenver&temperature_unit=fahrenheit';

export const BARE_DEPTH = 0.01;   // metres of model snow under which the summit counts as bare

export async function fetchRidge() {
  const r = await fetch(RIDGE_URL);
  if (!r.ok) throw new Error('ridge http ' + r.status);
  const j = await r.json();
  const h = j.hourly;
  const key = localHourKey(new Date());
  let at = h.time.findIndex((t) => t.slice(0, 13) === key);
  if (at < 0) at = h.time.length - 1;
  let freshSnow = 0, maxDepth = 0, heldDepth = Infinity, recentMax = 0;
  for (let k = Math.max(0, at - 72); k <= at; k++) { freshSnow += h.snowfall[k] || 0; maxDepth = Math.max(maxDepth, h.snow_depth[k] || 0); }
  // what has been on the ground for the last half day: the model's depth wobbles by a centimetre
  // or two from hour to hour, and one hour of marginal model snow once whitened bare peaks
  for (let k = Math.max(0, at - 12); k <= at; k++) { heldDepth = Math.min(heldDepth, h.snow_depth[k] || 0); recentMax = Math.max(recentMax, h.snow_depth[k] || 0); }
  if (!Number.isFinite(heldDepth)) heldDepth = 0;
  // when the summit went bare: the hour after the model last showed snow on the ground, so a
  // first snow that has melted off up there fades off the peaks from then (season.js), not from
  // whenever a browser next looked. null while there is snow; the window's start if it has
  // been bare the whole three days (then it is long gone either way).
  const off = (j.utc_offset_seconds || 0) * 1000;
  let bareSince = null;
  if ((h.snow_depth[at] || 0) < BARE_DEPTH) {
    let k = at;
    while (k > 0 && (h.snow_depth[k - 1] || 0) < BARE_DEPTH) k--;
    bareSince = Date.parse(h.time[k] + 'Z') - off;
  }
  // snowDepth: metres on the ground at the summit now; heldDepth: the least of the last 12 hours,
  // recentMax the most; freshSnow: cm fallen in the last three days
  return { ok: true, snowDepth: h.snow_depth[at] || 0, heldDepth, recentMax, maxDepth, freshSnow, bareSince, temp: h.temperature_2m[at] };
}

export async function fetchWeather() {
  const [r, ridge] = await Promise.all([fetch(URL), fetchRidge().catch((e) => { console.warn('ridge fetch failed', e); return null; })]);
  if (!r.ok) throw new Error('weather http ' + r.status);
  const j = await r.json();
  const c = j.current;
  let snowDepth = 0, freshSnow = 0, rainWeek = 0, warmWeek = 0, greenup = 0;
  const feedHours = [];
  // The air at contrail height, 250 hPa (about 34,000 ft): whether a jet's contrail lasts
  // seconds or hangs for an hour is the humidity up there, and the wind up there is what drifts
  // it (src/flights.js). Taken at the current hour; null when the feed lacks it.
  let upper = null;
  if (j.hourly && j.hourly.time) {
    const idx = j.hourly.time.findIndex((t) => t.slice(0, 13) === c.time.slice(0, 13));
    if (idx >= 0 && j.hourly.relative_humidity_250hPa && j.hourly.relative_humidity_250hPa[idx] != null) {
      upper = { rh: j.hourly.relative_humidity_250hPa[idx], temp: j.hourly.temperature_250hPa[idx], wind: j.hourly.wind_speed_250hPa[idx] ?? 0, windDir: j.hourly.wind_direction_250hPa[idx] ?? 270 };
    }
    if (idx >= 0 && j.hourly.snow_depth[idx] != null) snowDepth = j.hourly.snow_depth[idx];
    // Loose snow for the wind: snowfall (cm) in the 18 hours before now. The dusting itself is
    // budgeted by elevation from the last three days of the feed (src/dusting.js), since the
    // valley's hour above freezing melts nothing on the hills.
    if (idx >= 0) {
      for (let k = Math.max(0, idx - 18); k <= idx; k++) freshSnow += j.hourly.snowfall[k] || 0;
      const off = (j.utc_offset_seconds || 0) * 1000;
      for (let k = Math.max(0, idx - 72); k <= idx; k++) {
        feedHours.push({ time: Date.parse(j.hourly.time[k] + 'Z') - off, temp: j.hourly.temperature_2m[k], snowfall: j.hourly.snowfall[k] || 0, precip: j.hourly.precipitation[k] || 0 });
      }
      // Green-up: liquid rain over the past week (mm; counted from half a day after it fell,
      // since the grass takes that long to answer, and fading out past five days), and how warm
      // the last two days were, which is when the growing happens: a cold-front rain greens
      // nothing until the warm days after it. Sentinel's slope and the meadow go brown by
      // August but come back some after a soaking if it stays warm.
      let hours = 0, tempSum = 0;
      for (let k = Math.max(0, idx - 168); k <= idx; k++) {
        const temp = j.hourly.temperature_2m[k];
        if (temp == null) continue;
        const age = (idx - k) / 24;   // days ago
        if (age <= 2) { hours++; tempSum += temp; }
        const liquid = temp > 36 ? Math.max(0, (j.hourly.precipitation[k] || 0) - (j.hourly.snowfall[k] || 0) * 10) : 0;
        rainWeek += liquid * Math.max(0, Math.min(1, (age - 0.5) / 1, (7 - age) / 2));
      }
      if (hours > 0) warmWeek = Math.max(0, Math.min(1, (tempSum / hours - 42) / 18));   // 42°F mean: dormant; 60°F: growing
      greenup = Math.min(1, rainWeek / 8) * warmWeek;   // 8 mm of effective rain then two warm days is a full green-up
    }
  }
  return {
    ok: true, fetchedAt: Date.now(),
    temp: c.temperature_2m, code: c.weather_code, cover: c.cloud_cover / 100, coverLow: (c.cloud_cover_low ?? 0) / 100, coverMid: (c.cloud_cover_mid ?? 0) / 100, coverHigh: (c.cloud_cover_high ?? 0) / 100,
    wind: c.wind_speed_10m, windDir: c.wind_direction_10m,
    precip: c.precipitation, snowfall: c.snowfall, snowDepth, freshSnow, hours: feedHours,
    rainWeek, warmWeek, greenup, upper,
    ridge,
  };
}

// WMO weather code -> what the scene needs to know.
export function conditionsFromCode(code) {
  let label = 'clear', type = 'none', intensity = 0, fog = false, storm = false;
  if (code === 0) label = 'clear';
  else if (code === 1) label = 'mostly clear';
  else if (code === 2) label = 'partly cloudy';
  else if (code === 3) label = 'overcast';
  else if (code === 45 || code === 48) { label = 'fog'; fog = true; }
  else if (code >= 51 && code <= 57) { label = 'drizzle'; type = 'rain'; intensity = 0.25; }
  else if (code >= 61 && code <= 67) { label = 'rain'; type = 'rain'; intensity = code >= 65 ? 0.9 : code >= 63 ? 0.6 : 0.35; }
  else if (code >= 71 && code <= 77) { label = 'snow'; type = 'snow'; intensity = code >= 75 ? 0.9 : code >= 73 ? 0.6 : 0.35; }
  else if (code >= 80 && code <= 82) { label = 'rain showers'; type = 'rain'; intensity = code === 82 ? 0.9 : 0.5; }
  else if (code >= 85 && code <= 86) { label = 'snow showers'; type = 'snow'; intensity = code === 86 ? 0.8 : 0.4; }
  else if (code >= 95) { label = 'thunderstorm'; type = 'rain'; intensity = 1; storm = true; }
  return { label, precip: { type, intensity }, fog, storm };
}

export const WEATHER_PRESETS = {
  clear:    { code: 0,  cover: 0.05, coverLow: 0.05, coverMid: 0, coverHigh: 0, temp: 62, wind: 4,  snowDepth: 0 },
  partly:   { code: 2,  cover: 0.45, coverLow: 0.45, coverMid: 0.1, coverHigh: 0.2, temp: 58, wind: 7,  snowDepth: 0 },
  cumulus:  { code: 2,  cover: 0.5,  coverLow: 0.5,  coverMid: 0, coverHigh: 0, temp: 74, wind: 6, snowDepth: 0 },   // a summer afternoon of fair cumulus and nothing else, for the photo clouds
  cumulonimbus: { code: 2, cover: 0.6, coverLow: 0.55, coverMid: 0.1, coverHigh: 0.1, temp: 82, wind: 9, snowDepth: 0, cb: 1 },   // a cell building over the ranges, no storm yet
  cirrus:   { code: 1,  cover: 0.4,  coverLow: 0.05, coverMid: 0, coverHigh: 0.5, temp: 60, wind: 9, snowDepth: 0 },
  altocumulus: { code: 2, cover: 0.6, coverLow: 0.15, coverMid: 0.6, coverHigh: 0.1, temp: 56, wind: 6, snowDepth: 0 },
  stratocumulus: { code: 3, cover: 0.9, coverLow: 0.85, coverMid: 0.3, coverHigh: 0, temp: 50, wind: 8, snowDepth: 0 },
  overcast: { code: 3,  cover: 0.97, coverLow: 0.97, coverMid: 0.9, coverHigh: 0.5, temp: 48, wind: 6,  snowDepth: 0, stratus: 1 },
  rain:     { code: 63, cover: 0.95, coverLow: 0.95, coverMid: 0.9, coverHigh: 0.8, temp: 46, wind: 11, snowDepth: 0 },
  snow:     { code: 73, cover: 0.95, coverLow: 0.95, coverMid: 0.9, coverHigh: 0.8, temp: 24, wind: 8,  snowDepth: 0.25 },
  fog:      { code: 45, cover: 0.55, coverLow: 0.5, coverMid: 0.2, coverHigh: 0.1, temp: 39, wind: 2,  snowDepth: 0 },
  inversion: { code: 45, cover: 0.08, coverLow: 0, coverMid: 0, coverHigh: 0.3, temp: 28, wind: 1, snowDepth: 0, inversion: 1 },   // snow follows the season
  fogsea:    { code: 45, cover: 0.05, coverLow: 0, coverMid: 0, coverHigh: 0.1, temp: 33, wind: 1, snowDepth: 0, inversion: 1, fogTop: 1 },   // a deep morning fog, up the slopes: the cams' reading on a true inversion
  dusting:   { code: 1,  cover: 0.2, coverLow: 0.1, coverMid: 0.1, coverHigh: 0.3, temp: 38, wind: 3, snowDepth: 0, freshSnow: 1 },     // last night's skiff, melting off through the day
  mountainfog: { code: 3, cover: 0.8, coverLow: 0.9, coverMid: 0.4, coverHigh: 0.2, temp: 41, wind: 3, snowDepth: 0, lowcloud: 1 },
  storm:    { code: 95, cover: 1.0,  coverLow: 0.9, coverMid: 0.9, coverHigh: 0.7, temp: 66, wind: 22, snowDepth: 0 },
  blowing:  { code: 71, cover: 0.9,  coverLow: 0.8, coverMid: 0.5, coverHigh: 0.3, temp: 22, wind: 24, snowDepth: 0.25 },   // light snow in a hard wind
  blizzard: { code: 75, cover: 1.0,  coverLow: 1.0, coverMid: 0.9, coverHigh: 0.8, temp: 18, wind: 34, snowDepth: 0.3 },
  greenup:  { code: 1,  cover: 0.3,  coverLow: 0.25, coverMid: 0.1, coverHigh: 0.2, temp: 64, wind: 5, snowDepth: 0, greenup: 1 },   // a few days after a warm soaking: the brown slopes green up some
};
