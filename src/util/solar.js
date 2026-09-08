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

// Local sidereal time in degrees (Greenwich mean sidereal time plus east longitude).
export function siderealDeg(date, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000;
  return ((gmst + lon) % 360 + 360) % 360;
}
// Where a star at (ra, dec) in degrees stands for an observer at lat with local sidereal time lst.
export function starAltAz(ra, dec, lst, lat) {
  const RAD = Math.PI / 180;
  const H = (lst - ra) * RAD, d = dec * RAD, phi = lat * RAD;
  const sinAlt = Math.sin(d) * Math.sin(phi) + Math.cos(d) * Math.cos(phi) * Math.cos(H);
  const alt = Math.asin(sinAlt);
  const y = -Math.sin(H) * Math.cos(d), x = Math.cos(phi) * Math.sin(d) - Math.sin(phi) * Math.cos(d) * Math.cos(H);
  let az = Math.atan2(y, x) / RAD; az = ((az % 360) + 360) % 360;   // from north, clockwise
  return { altitude: alt / RAD, azimuth: az };
}
// Galactic latitude (degrees) of equatorial (ra, dec) in degrees, for the Milky Way band.
export function galacticLat(ra, dec) {
  const RAD = Math.PI / 180;
  const a = ra * RAD, d = dec * RAD, aNGP = 192.85948 * RAD, dNGP = 27.12825 * RAD;
  const sinb = Math.sin(d) * Math.sin(dNGP) + Math.cos(d) * Math.cos(dNGP) * Math.cos(a - aNGP);
  return Math.asin(Math.max(-1, Math.min(1, sinb))) / RAD;
}
// Equatorial coordinates of a point in the sky at (azimuth, altitude) for lat and lst, degrees.
export function altAzToRaDec(az, alt, lst, lat) {
  const RAD = Math.PI / 180;
  const A = az * RAD, h = alt * RAD, phi = lat * RAD;
  const sind = Math.sin(h) * Math.sin(phi) + Math.cos(h) * Math.cos(phi) * Math.cos(A);
  const dec = Math.asin(Math.max(-1, Math.min(1, sind)));
  const y = -Math.sin(A) * Math.cos(h), x = Math.cos(phi) * Math.sin(h) - Math.sin(phi) * Math.cos(h) * Math.cos(A);
  const H = Math.atan2(y, x);
  const ra = ((lst - H / RAD) % 360 + 360) % 360;
  return { ra, dec: dec / RAD };
}
