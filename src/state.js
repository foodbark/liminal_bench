// The scene is the size of the painted backdrop; tools/build_backdrop.py writes these.
// tools/build_backdrop.py writes it from the painting's config: size, horizon, hotspots, cork,
// lantern, camera targets, fog lines, snow caps, default notes (all already in scene pixels).
// Phones and small screens get the half-size scene (a quarter of the pixels to light and hold);
// ?small or ?full in the page URL overrides. The worker is told through its own URL.
function wantSmall() {
  if (typeof window !== 'undefined') {
    const q = location.search;
    if (/[?&]full\b/.test(q)) return false;
    if (/[?&]small\b/.test(q)) return true;
    return Math.max(screen.width, screen.height) < 1100;
  }
  return /[?&]small\b/.test(self.location.search);   // worker
}
export const SMALL = wantSmall();
export const ASSET_DIR = SMALL ? 'assets/small' : 'assets';
export const META = await (await fetch(new URL('../' + ASSET_DIR + '/backdrop.json', import.meta.url))).json();
export const W = META.w, H = META.h, HORIZON = META.horizon;
// Procedural pixel sizes (clouds, rain, glow, rim widths) were tuned on a 1024-wide painting.
export const SCALE = W / 1024;
export const LAT = 46.872, LON = -113.994, TZ = 'America/Denver';
// Dean Stone's summit (6,730 ft), a thousand metres above the valley station: where the snow on
// the peaks is actually decided. Located on Open-Meteo's elevation grid, 2026-09-28.
export const RIDGE = { lat: 46.771, lon: -113.879, elevation: 2050 };

// Snow on the surrounding peaks by month once winter has come (0 = none, 1 = down to the valley):
// how deep it gets and how it melts out in spring. When it *arrives* is not in this table: the
// summit weather latches the first real accumulation (src/season.js), and until then the fall
// months are held at bare whatever the calendar says.
export const SEASON_SNOW = [1, 0.95, 0.8, 0.55, 0.3, 0.12, 0.02, 0.02, 0.02, 0.04, 0.5, 0.95];

export function createState() {
  return {
    now: new Date(),
    override: { enabled: false, hour: 12, month: 6, weather: 'live', cover: -1, moon: 'live', peaks: 'live', gliders: 'live' },
    weather: { ok: false, fetchedAt: 0, temp: null, code: 0, cover: 0.1, wind: 3, windDir: 270, precip: 0, snowfall: 0, snowDepth: 0, ridge: null },
    env: null,        // derived per-frame environment (sun, palette, conditions)
    view: 'scene',    // scene | phone | board | bench
    closeup: null,    // which view's close-up painting is up, once its zoom has settled
    poster: null,     // a poster on the board held up to look at (one of state.notes)
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
// 'YYYY-MM-DDTHH' in Missoula time, the shape of Open-Meteo's hourly timestamps.
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
export function localHourKey(date) {
  const p = {};
  for (const { type, value } of hourFmt.formatToParts(date)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}T${String((+p.hour) % 24).padStart(2, '0')}`;
}

// Build a Date for an overridden Missoula month/hour (approximate DST rule is fine for previewing).
export function overrideDate(month, hour) {
  const year = new Date().getFullYear();
  const utcOffset = (month >= 2 && month <= 9) ? 6 : 7;
  return new Date(Date.UTC(year, month, 15, 0, 0, 0) + (hour + utcOffset) * 3600e3);
}
