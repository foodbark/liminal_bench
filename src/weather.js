import { LAT, LON } from './state.js';

const URL = 'https://api.open-meteo.com/v1/forecast'
  + `?latitude=${LAT}&longitude=${LON}`
  + '&current=temperature_2m,weather_code,cloud_cover,cloud_cover_low,wind_speed_10m,wind_direction_10m,precipitation,snowfall,is_day'
  + '&hourly=snow_depth,snowfall,temperature_2m&past_days=1&forecast_days=1&timezone=America%2FDenver'
  + '&temperature_unit=fahrenheit&wind_speed_unit=mph';

export async function fetchWeather() {
  const r = await fetch(URL);
  if (!r.ok) throw new Error('weather http ' + r.status);
  const j = await r.json();
  const c = j.current;
  let snowDepth = 0, freshSnow = 0, thawHours = 0;
  if (j.hourly && j.hourly.time) {
    const idx = j.hourly.time.findIndex((t) => t.slice(0, 13) === c.time.slice(0, 13));
    if (idx >= 0 && j.hourly.snow_depth[idx] != null) snowDepth = j.hourly.snow_depth[idx];
    // A dusting: snowfall (cm) in the 18 hours before now, and how many hours above freezing
    // have passed since the last of it fell, which is how far up the slopes it has melted.
    if (idx >= 0) {
      let last = -1;
      for (let k = Math.max(0, idx - 18); k <= idx; k++) {
        const sf = j.hourly.snowfall[k] || 0;
        if (sf > 0) { freshSnow += sf; last = k; }
      }
      for (let k = Math.max(0, last + 1); k <= idx; k++) if ((j.hourly.temperature_2m[k] ?? 0) > 33) thawHours++;
    }
  }
  return {
    ok: true, fetchedAt: Date.now(),
    temp: c.temperature_2m, code: c.weather_code, cover: c.cloud_cover / 100, coverLow: (c.cloud_cover_low ?? 0) / 100,
    wind: c.wind_speed_10m, windDir: c.wind_direction_10m,
    precip: c.precipitation, snowfall: c.snowfall, snowDepth, freshSnow, thawHours,
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
  clear:    { code: 0,  cover: 0.05, temp: 62, wind: 4,  snowDepth: 0 },
  partly:   { code: 2,  cover: 0.45, temp: 58, wind: 7,  snowDepth: 0 },
  overcast: { code: 3,  cover: 0.97, temp: 48, wind: 6,  snowDepth: 0 },
  rain:     { code: 63, cover: 0.95, temp: 46, wind: 11, snowDepth: 0 },
  snow:     { code: 73, cover: 0.95, temp: 24, wind: 8,  snowDepth: 0.25 },
  fog:      { code: 45, cover: 0.55, temp: 39, wind: 2,  snowDepth: 0 },
  inversion: { code: 45, cover: 0.08, temp: 28, wind: 1, snowDepth: 0, inversion: 1 },   // snow follows the season
  dusting:   { code: 1,  cover: 0.2,  temp: 38, wind: 3, snowDepth: 0, freshSnow: 1 },     // last night's skiff, melting off through the day
  mountainfog: { code: 3, cover: 0.8, coverLow: 0.9, temp: 41, wind: 3, snowDepth: 0, lowcloud: 1 },
  storm:    { code: 95, cover: 1.0,  temp: 66, wind: 22, snowDepth: 0 },
};
