// The aircraft over the valley, from the ADS-B feed proxied by functions/api/flights.js (the
// dev server stands in at the same path). A live thing in the sky that the painting cannot
// have: the east-west corridor at cruise crosses right over the bench, a dozen jets at a time
// at 34,000 to 41,000 ft, the small aircraft make their approach over Sentinel and the airliners
// in from Denver and Salt Lake come up the Bitterroot valley and in over the South Hills (the
// user, 2026-10-21). This module reads the feed and does the geometry: where each aircraft is
// now (dead-reckoned between fetches on its speed and track, so it moves every frame) and
// where that is in the sky from the bench, as an azimuth and an elevation the sky projection
// (skyXY in render/sky.js) turns into a pixel. The drawing is in render/flights.js.
import { LAT, LON, ELEV } from './state.js';

export const REFRESH_MS = 30 * 1000;   // the proxy caches for 30 s; no point asking sooner
export const STALE_MS = 120 * 1000;    // an aircraft not heard from for this long is dropped
const FEED = new URL('api/flights', document.baseURI).href;   // relative to the page, so a path prefix works

export async function fetchFlights() {
  const r = await fetch(FEED, { cache: 'no-store' });
  if (!r.ok) throw new Error('flights http ' + r.status);
  const j = await r.json();
  // the copy's own time, not the page's: a pushed copy can sit in the store for a minute, and
  // taken as fresh its positions were a minute behind, so every refresh jolted the planes
  // (a DAL contrail forming and retracting at the frame's edge, the user, 2026-10-22)
  let at = j.at || 0;
  if (at && at < 1e11) at *= 1000;                      // a feed's `now` in seconds (readsb's is), not milliseconds
  const now = at && Math.abs(Date.now() - at) < 3600e3 ? Math.min(Date.now(), at) : Date.now();   // and never a clock an hour out
  const list = [];
  for (const a of j.ac || []) {
    if (a.alt === 'ground' || a.alt == null || a.lat == null) continue;
    list.push({
      hex: a.hex, flight: a.flight || '', type: a.t || '', reg: a.r || '',
      lat: a.lat, lon: a.lon, alt: a.alt, gs: a.gs ?? 0, track: a.track ?? 0, vr: a.vr || 0,
      at: now - (a.seen || 0) * 1000,   // when the position was true
    });
  }
  return { ok: true, at: Date.now(), list, src: j.src || '', stale: !!j.stale, ttl: j.ttl || 30 };   // src: which feed answered the proxy; stale: the last good copy, no feed answering
}

const M_PER_DEG = 111195;
const KT = 0.514444;   // m/s per knot
const FT = 0.3048;

// the aircraft's position at `now` (ms), advanced from its last report along its track
export function reckon(a, now) {
  const dt = Math.max(0, (now - a.at) / 1000);
  const v = a.gs * KT, th = a.track * Math.PI / 180;
  const lat = a.lat + v * dt * Math.cos(th) / M_PER_DEG;
  const lon = a.lon + v * dt * Math.sin(th) / (M_PER_DEG * Math.cos(a.lat * Math.PI / 180));
  return { lat, lon, altFt: a.alt + a.vr * dt / 60 };
}

// where a point is in the sky from the bench: azimuth (degrees, north 0, east 90), elevation
// (degrees above the horizontal, the earth's curve and a little refraction taken off) and the
// ground distance in km. An airliner 120 nm out at 39,000 ft is already below the ridge line.
const RE = 6371000 * 7 / 6;   // the optical refraction's effective earth radius
export function lookAt(lat, lon, altFt) {
  const dn = (lat - LAT) * M_PER_DEG, de = (lon - LON) * M_PER_DEG * Math.cos(LAT * Math.PI / 180);
  const d = Math.hypot(dn, de);
  const az = (Math.atan2(de, dn) * 180 / Math.PI + 360) % 360;
  const dh = altFt * FT - ELEV - d * d / (2 * RE);
  const el = Math.atan2(dh, Math.max(1, d)) * 180 / Math.PI;
  return { az, el, km: d / 1000 };
}

// How long a contrail lasts up there, in seconds, from the feed's air at 250 hPa (weather.js,
// `upper`: humidity in %, temperature in °F, as the feed is set). A contrail needs cold air,
// about -40°, and whether it fades in seconds or hangs for an hour is the humidity. The feed's
// is over water and a contrail persists when the air is supersaturated over ice, which a
// grid-mean model almost never reports, so the threshold sits well under: on the day the
// README notes (2026-10-07) 42 to 56% over water was a sky of spreading contrails, so 50% is
// the full ten minutes here and 20% the ten-second dash. Without the reading, a middling life.
export function contrailLife(upper) {
  if (!upper) return 90;
  if (upper.temp != null && upper.temp > -36) return 3;
  const k = Math.max(0, Math.min(1, ((upper.rh ?? 35) - 20) / 30));
  return 10 + k * k * 600;
}

// the upper wind as a ground velocity in m/s (east, north): the feed's is in mph, from a bearing
export function upperWind(upper) {
  if (!upper) return { e: 0, n: 0 };
  const v = (upper.wind || 0) * 0.44704, to = ((upper.windDir || 0) + 180) * Math.PI / 180;
  return { e: v * Math.sin(to), n: v * Math.cos(to) };
}

// a few airframes by name for the caption; the rest show their code
const TYPES = {
  B737: 'boeing 737', B738: 'boeing 737-800', B739: 'boeing 737-900', B38M: 'boeing 737 max 8', B39M: 'boeing 737 max 9',
  B752: 'boeing 757', B753: 'boeing 757-300', B763: 'boeing 767', B764: 'boeing 767-400', B744: 'boeing 747', B748: 'boeing 747-8',
  B772: 'boeing 777', B77W: 'boeing 777-300', B788: 'boeing 787-8', B789: 'boeing 787-9', B78X: 'boeing 787-10',
  A319: 'airbus a319', A320: 'airbus a320', A321: 'airbus a321', A20N: 'airbus a320neo', A21N: 'airbus a321neo', A332: 'airbus a330', A333: 'airbus a330', A359: 'airbus a350',
  BCS1: 'airbus a220-100', BCS3: 'airbus a220-300', E170: 'embraer 170', E175: 'embraer 175', E75L: 'embraer 175', E75S: 'embraer 175', E190: 'embraer 190',
  CRJ2: 'crj-200', CRJ7: 'crj-700', CRJ9: 'crj-900', DH8D: 'dash 8', AT76: 'atr 72',
  C172: 'cessna 172', C182: 'cessna 182', C206: 'cessna 206', C208: 'cessna caravan', C210: 'cessna 210', T210: 'cessna 210',
  PA28: 'piper cherokee', PA22: 'piper tri-pacer', PA18: 'piper super cub', PA46: 'piper malibu', SR22: 'cirrus sr22', SR20: 'cirrus sr20',
  BE20: 'king air', BE9L: 'king air 90', B350: 'king air 350', PC12: 'pilatus pc-12', TBM9: 'tbm 900', DA40: 'diamond da40',
  H25B: 'hawker 800', C56X: 'citation excel', C25A: 'citation cj2', C25B: 'citation cj3', C68A: 'citation latitude', C700: 'citation longitude',
  CL35: 'challenger 350', CL60: 'challenger 600', GLF4: 'gulfstream iv', GLF5: 'gulfstream v', GLEX: 'global express', LJ45: 'learjet 45',
  UH1: 'huey', H60: 'black hawk', EC35: 'eurocopter', AS50: 'a-star helicopter', B407: 'bell 407', B06: 'jetranger',
  C130: 'c-130 hercules', C17: 'c-17 globemaster', KC35: 'kc-135', DC10: 'dc-10 tanker', RV: 'air tanker',
};
// wingspans in metres, for how big a low one looks; unknown types get a light twin's
const SPANS = {
  B737: 34, B738: 36, B739: 36, B38M: 36, B39M: 36, B752: 38, B753: 38, B763: 48, B764: 52, B744: 64, B748: 68, B772: 61, B77W: 65, B788: 60, B789: 60, B78X: 60,
  A319: 34, A320: 34, A321: 34, A20N: 36, A21N: 36, A332: 60, A333: 60, A359: 65, BCS1: 35, BCS3: 35,
  E170: 26, E175: 26, E75L: 28, E75S: 26, E190: 29, CRJ2: 21, CRJ7: 23, CRJ9: 25, DH8D: 28, AT76: 27,
  C172: 11, C182: 11, C206: 11, C208: 16, C210: 11, T210: 11, PA28: 11, PA22: 9, PA18: 11, PA46: 13, SR22: 12, SR20: 12, DA40: 12,
  BE20: 17, BE9L: 15, B350: 18, PC12: 16, TBM9: 13, H25B: 16, C56X: 17, C25A: 15, C25B: 16, C68A: 22, C700: 22,
  CL35: 21, CL60: 20, GLF4: 24, GLF5: 28, GLEX: 29, LJ45: 15, UH1: 15, H60: 16, EC35: 10, AS50: 11, B407: 11, B06: 10,
  C130: 40, C17: 52, KC35: 40, DC10: 50, RV: 35,
};
export const wingspan = (a) => SPANS[a.type] || 14;
const DIRS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export function flightLabel(a, altFt, km) {
  const name = a.flight || a.reg || 'an aircraft';
  const type = TYPES[a.type] || (a.type ? a.type.toLowerCase() : 'a plane');
  const dir = DIRS[Math.round(((a.track % 360) + 360) % 360 / 45) % 8];
  const ft = Math.round(altFt / 100) * 100;
  const alt = ft >= 1000 ? ft.toLocaleString('en-US') + ' ft' : ft + ' ft';
  const cardinal = dir === 'north' || dir === 'east' || dir === 'south' || dir === 'west';
  const going = a.vr > 500 ? 'climbing' : a.vr < -500 ? 'descending' : cardinal ? `${dir}bound` : `heading ${dir}`;
  return `${name} · ${type} · ${alt} · ${going} · ${Math.round(km * 0.54)} nm`;
}
