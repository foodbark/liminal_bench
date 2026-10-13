// The overnight dusting on the hills, as a snow budget by elevation.
//
// The feed is the valley station (980 m), where a night's snow is rain or slush while the
// hills above sit in the twenties. One October morning (2026-10-12) the valley counted a
// centimetre and two hours above freezing, and the scene melted the dusting a third of the
// way up Sentinel and halfway up Dean Stone, while the real hills were white end to end:
// all of Dean Stone, Sentinel almost down to its foot. So the valley's hourly feed is lapsed
// to each plane's elevations and walked hour by hour: what fell there (rain in the valley is
// snow above the freezing level), and what melted since (warm hours, faster in the sun and on
// the low open slopes, slower on the shaded north faces the bench looks at). The result is a small table per plane, depth in cm by height fraction,
// that the terrain pass samples per pixel. Worker-safe: numbers only.
import { LAYER } from './assets.js';
import { LAT, LON } from './state.js';
import { sunPosition } from './util/solar.js';

export const VALLEY_ELEV = 980;          // m, the valley station
export const LAPSE = 12 / 1000;          // °F per metre: the model's own 6.5 °C/km (the summit feed agrees)
export const DUST_STEPS = 12;            // samples per plane, from its foot (0) to its crest (1)
const SNOW_PER_MM = 0.7;                 // cm of snow per mm of precipitation that falls as snow
const MELT_RATE = 2.5;                   // cm per hour at 40 °F in full sun
// Each plane's elevation span (m) from where it shows above what is in front of it to its crest,
// and how fast it melts, as a factor on the sun's melt at its foot and at its crest (interpolated
// between), since the sun matters as much as the elevation: the bench looks south, so every face
// it sees of Dean Stone is a north face, forested toward the top, that gets almost no October sun
// and holds a dusting for days, while Mount Sentinel's open grass faces west into the afternoon and
// is bare by the next day (the user's check, 2026-10-13: Sentinel long bare, Dean Stone's top still
// white, the valley at 50 °F). A factor of 1 is the open valley's rate.
export const DUST_PLANES = {
  [LAYER.PEAK]:    { elev: [1800, 2600], melt: [0.5, 0.3] },
  [LAYER.RANGE]:   { elev: [1250, 2050], melt: [0.7, 0.2] },   // Dean Stone, its foot behind the trees; its north face
  [LAYER.FARHILL]: { elev: [1050, 1500], melt: [0.9, 0.6] },   // the foothills under it, north faces too
  [LAYER.FLANK]:   { elev: [1000, 1592], melt: [1.1, 0.9] },   // Mount Sentinel, open grass in the afternoon sun
  [LAYER.TREES]:   { elev: [980, 1040],  melt: [0.9, 0.9] },
  [LAYER.NEAR]:    { elev: [980, 980],   melt: [1.0, 1.0] },
};

// hours: the valley feed's last day or three, oldest first, ending at the current hour:
// { time: ms (UTC), temp: °F, snowfall: cm, precip: mm }. Returns { tables, key }: for each
// plane, DUST_STEPS + 1 depths in cm from foot to crest, and a short key for the terrain cache.
export function dustingTables(hours) {
  const sunK = hours.map((h) => {
    const alt = sunPosition(new Date(h.time), LAT, LON).altitude;
    return 0.25 + 0.75 * Math.max(0, Math.min(1, alt / 30));   // slow in the dark, full in a high sun
  });
  const tables = {};
  let key = '';
  for (const id in DUST_PLANES) {
    const { elev: [lo, hi], melt: [mFoot, mCrest] } = DUST_PLANES[id];
    const tab = [];
    for (let s = 0; s <= DUST_STEPS; s++) {
      const dT = LAPSE * (lo + (hi - lo) * s / DUST_STEPS - VALLEY_ELEV);
      const meltK = mFoot + (mCrest - mFoot) * s / DUST_STEPS;
      let depth = 0;
      for (let k = 0; k < hours.length; k++) {
        const h = hours[k];
        if (h.temp == null) continue;
        const T = h.temp - dT;
        // what fell as snow up here: the model's own snowfall, or all of the precipitation
        // where it is cold enough for the valley's rain to be snow
        const fall = Math.max(h.snowfall || 0, (h.precip || 0) * SNOW_PER_MM * Math.max(0, Math.min(1, (36 - T) / 2)));
        const melt = MELT_RATE * Math.max(0, Math.min(1, (T - 32) / 8)) * sunK[k] * meltK;
        depth = Math.max(0, depth + fall - melt);
      }
      tab.push(depth);
      key += Math.round(depth * 4) + ',';
    }
    tables[id] = tab;
  }
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = ((hash * 33) ^ key.charCodeAt(i)) >>> 0;
  return { tables, key: hash.toString(36), any: Object.values(tables).some((t) => t.some((d) => d > 0.1)) };
}

// A made-up feed for the debug presets: a night of snow (from 22:00 to 05:00) before a day that
// warms from 30 °F at dawn into the forties, so the dusting preset still melts off bottom-up
// as the hour slider moves. `now` is the override date; hourLocal its local hour.
export function presetHours(now, hourLocal, cm) {
  const out = [];
  for (let k = 71; k >= 0; k--) {
    const hod = ((hourLocal - k) % 24 + 24) % 24;
    const temp = hod < 7 ? 30 : hod <= 16 ? 30 + (hod - 7) * 2 : Math.max(32, 48 - (hod - 16) * 2);
    const night = hod >= 22 || hod <= 5;
    const lastNight = k <= (hourLocal >= 22 ? hourLocal - 22 : hourLocal + 2);   // only the most recent night snows
    const snowfall = night && lastNight ? cm / 8 : 0;
    out.push({ time: now.getTime() - k * 3600000, temp, snowfall, precip: snowfall / SNOW_PER_MM });
  }
  return out;
}
