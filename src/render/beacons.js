import { META } from '../state.js';
import { lerpRGB } from '../util/pixel.js';

// The aircraft warning beacons on the masts on Dean Stone's summit: one red pixel on each tip,
// blinking slowly through the night. The build finds the masts (tall narrow spikes on the
// range crest) and writes the pixel to light on each into META.beacons: on top of the mast, or
// halfway up it on every other mast, a side light. Each tower keeps its own clock, a
// period near three seconds and a phase of its own, so they never fall into step (the user,
// 2026-10-11: a slow blink, timed randomly to each other). A beacon up in the cloud ceiling
// dulls toward the cloud's gray instead of going out: a glow in the fog.
export const BEACONS = META.beacons || [];
const CLOCKS = BEACONS.map((b, i) => {
  const h = ((b[0] * 2654435761) ^ (i * 40503)) >>> 0;
  return { period: 2.6 + ((h & 255) / 255) * 1.2, phase: ((h >> 8) & 1023) / 1024 };
});
const RED = [255, 46, 36], CLOUD = [160, 120, 128];

export const beaconsOn = (env) => BEACONS.length > 0 && env.sun.altitude < -3;

export function drawBeacons(ctx, env, t) {
  if (!beaconsOn(env)) return;
  const ceilK = env.mountainFog * env.mountainFog;
  const c = lerpRGB(RED, CLOUD, ceilK * 0.6);
  ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  for (let i = 0; i < BEACONS.length; i++) {
    const k = CLOCKS[i];
    const ph = (t / k.period + k.phase) % 1;
    if (ph < 0.38) ctx.fillRect(BEACONS[i][0], BEACONS[i][1], 1, 1);
  }
}
