// The scene is the size of the painted backdrop; tools/build_backdrop.py writes these.
// tools/build_backdrop.py writes it from the painting's config: size, horizon, hotspots, cork,
// lantern, camera targets, fog lines, snow caps, default notes (all already in scene pixels).
export const META = await (await fetch('assets/backdrop.json')).json();
export const W = META.w, H = META.h, HORIZON = META.horizon;
// Procedural pixel sizes (clouds, rain, glow, rim widths) were tuned on a 1024-wide painting.
export const SCALE = W / 1024;
export const LAT = 46.872, LON = -113.994, TZ = 'America/Denver';

// Typical snow coverage on the surrounding peaks by month (0 = none, 1 = down to the valley).
// Peaks are bare from July through October; first snow usually arrives in November.
export const SEASON_SNOW = [1, 0.95, 0.8, 0.55, 0.3, 0.12, 0.02, 0.02, 0.02, 0.04, 0.5, 0.95];

export function createState() {
  return {
    now: new Date(),
    override: { enabled: false, hour: 12, month: 6, weather: 'live', cover: -1, moon: 'live' },
    weather: { ok: false, fetchedAt: 0, temp: null, code: 0, cover: 0.1, wind: 3, windDir: 270, precip: 0, snowfall: 0, snowDepth: 0 },
    env: null,        // derived per-frame environment (sun, palette, conditions)
    view: 'scene',    // scene | phone | board | bench
    camera: { cx: W / 2, cy: H / 2, s: 1 },
    hover: null,
    notes: [],
    benchOccupant: null,
  };
}

const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false });
export function localParts(date) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(date)) p[type] = value;
  return { month: (+p.month) - 1, hour: (+p.hour) % 24, minute: +p.minute };
}
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
export const formatTime = (date) => timeFmt.format(date);

// Build a Date for an overridden Missoula month/hour (approximate DST rule is fine for previewing).
export function overrideDate(month, hour) {
  const year = new Date().getFullYear();
  const utcOffset = (month >= 2 && month <= 9) ? 6 : 7;
  return new Date(Date.UTC(year, month, 15, 0, 0, 0) + (hour + utcOffset) * 3600e3);
}
