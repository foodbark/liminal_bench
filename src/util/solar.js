// Approximate sun position (good to ~0.5 deg) and moon phase.
const RAD = Math.PI / 180;
export function sunPosition(date, lat, lon) {
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const lst = (gmst * 15 + lon) * RAD;
  const ha = lst - RA;
  const latr = lat * RAD;
  const alt = Math.asin(Math.sin(latr) * Math.sin(dec) + Math.cos(latr) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(latr) - Math.tan(dec) * Math.cos(latr));
  return { altitude: alt / RAD, azimuth: ((az / RAD) + 180 + 360) % 360 }; // azimuth from north, clockwise
}
// 0 = new, 0.5 = full, 1 = new again.
export function moonPhase(date) {
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14); // a known new moon
  const days = (date.getTime() - ref) / 86400000;
  return ((days / synodic) % 1 + 1) % 1;
}
