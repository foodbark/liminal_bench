// The five naked-eye planets, from mean orbital elements (JPL's approximate Keplerian elements
// for 1800..2050: a, e, I, L, longitude of perihelion, longitude of node, each with a rate per
// century). A Kepler solve per body, the Earth subtracted, the ecliptic tilted into equatorial,
// and the result is right ascension and declination good to a fraction of a degree, which is
// all a point of light in a 15 px per degree sky needs. No feed, no catalog: the planets are
// the brightest things people name in a real night sky, and a star catalog never has them.
const RAD = Math.PI / 180;
const EL = {
  mercury: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.25032350, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
  venus:   [0.72333566, 0.00000390, 0.00677672, -0.00004107, 3.39467605, -0.00078890, 181.97909950, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
  earth:   [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0.0, 0.0],
  mars:    [1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
  jupiter: [5.20288700, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
  saturn:  [9.53667594, -0.00125060, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
};
// absolute magnitude at 1 AU from both sun and earth, and the color of the light
export const PLANETS = [
  { id: 'mercury', label: 'mercury', H: -0.6, tint: [255, 235, 205] },
  { id: 'venus', label: 'venus', H: -4.47, tint: [255, 250, 235] },
  { id: 'mars', label: 'mars', H: -1.52, tint: [255, 165, 125] },
  { id: 'jupiter', label: 'jupiter', H: -9.4, tint: [255, 242, 215] },
  { id: 'saturn', label: 'saturn', H: -8.7, tint: [255, 232, 185] },
];
const OBLIQ = 23.43928 * RAD;

// heliocentric ecliptic position (AU) at T centuries from J2000
function helio(id, T) {
  const e = EL[id];
  const a = e[0] + e[1] * T, ec = e[2] + e[3] * T, I = (e[4] + e[5] * T) * RAD;
  const L = e[6] + e[7] * T, wbar = e[8] + e[9] * T, O = (e[10] + e[11] * T) * RAD;
  const w = (wbar - (e[10] + e[11] * T)) * RAD;
  let M = ((L - wbar) % 360 + 360) % 360; if (M > 180) M -= 360; M *= RAD;
  let E = M + ec * Math.sin(M);
  for (let k = 0; k < 8; k++) { const dE = (M - (E - ec * Math.sin(E))) / (1 - ec * Math.cos(E)); E += dE; if (Math.abs(dE) < 1e-8) break; }
  const xp = a * (Math.cos(E) - ec), yp = a * Math.sqrt(1 - ec * ec) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    (sw * sI) * xp + (cw * sI) * yp,
  ];
}

// ra, dec (degrees) and visual magnitude of each planet at the date
export function planetPositions(date) {
  const T = (date.getTime() / 86400000 - 10957.5) / 36525;
  const E = helio('earth', T), R = Math.hypot(E[0], E[1], E[2]);
  return PLANETS.map((p) => {
    const P = helio(p.id, T);
    const r = Math.hypot(P[0], P[1], P[2]);
    const x = P[0] - E[0], y = P[1] - E[1], z = P[2] - E[2];
    const d = Math.hypot(x, y, z);
    const ye = y * Math.cos(OBLIQ) - z * Math.sin(OBLIQ), ze = y * Math.sin(OBLIQ) + z * Math.cos(OBLIQ);
    const ra = ((Math.atan2(ye, x) / RAD) % 360 + 360) % 360, dec = Math.asin(ze / d) / RAD;
    // phase angle (sun-planet-earth) dims the inner planets through their crescents
    const cosi = Math.max(-1, Math.min(1, (r * r + d * d - R * R) / (2 * r * d)));
    const i = Math.acos(cosi) / RAD;
    const phase = p.id === 'venus' ? 0.0103 * i + 0.000057 * i * i : p.id === 'mercury' ? 0.038 * i - 0.000273 * i * i : p.id === 'mars' ? 0.016 * i : 0;
    const mag = p.H + 5 * Math.log10(r * d) + phase;
    return { ...p, ra, dec, mag, elongation: Math.acos(Math.max(-1, Math.min(1, (R * R + d * d - r * r) / (2 * R * d)))) / RAD };
  });
}
