import { SEASON_SNOW } from './state.js';
import { clamp } from './util/pixel.js';

// When does the snow arrive on the peaks? Not on a calendar. The summit weather (Dean Stone,
// weather.js) says when it has really accumulated up there, and that moment is latched in this
// browser so the peaks stay snowed through the fall and winter instead of flickering with each
// forecast refresh. SEASON_SNOW keeps its job for how deep the winter gets and for the spring
// melt; the live summit depth holds snow up through a warm spell and takes it away in May.
const KEY = 'liminal.peakSnow';
const LATCH_DEPTH = 0.05;          // metres at the summit that count as winter having arrived
const ARRIVAL = [8, 9, 10, 11];    // Sep..Dec: the months the calendar alone does not get to whiten
export const PEAK_BARE = 0.04;     // October's table value: under the painting's own summit snow, so it reads as rock
export const PEAK_FIRST = 0.3;     // first snow: a white crest over a still-green valley

let latch = null;   // { since: ms }
try { latch = JSON.parse(localStorage.getItem(KEY)); } catch (e) { latch = null; }
if (latch && typeof latch.since !== 'number') latch = null;

// A latch is good for one snow year (from Aug 1); last winter's does not whiten this September.
function snowYearStart(now) { const y = now.getFullYear(); return new Date(now.getMonth() >= 7 ? y : y - 1, 7, 1).getTime(); }
export function peakSnowLatched(now) { return !!latch && latch.since >= snowYearStart(now); }
export function peakSnowSince() { return latch ? new Date(latch.since) : null; }

export function updatePeakSnowLatch(ridge, now = new Date()) {
  if (!ridge || peakSnowLatched(now)) return;
  if ((ridge.heldDepth ?? ridge.snowDepth) >= LATCH_DEPTH) {   // held for half a day, not one hour's blip
    latch = { since: now.getTime() };
    try { localStorage.setItem(KEY, JSON.stringify(latch)); } catch (e) { /* private window: the session still has it */ }
  }
}

export function peakSnowAmount(month, now, ridge) {
  let amount = SEASON_SNOW[month];
  const arriving = ARRIVAL.includes(month);
  if (arriving) amount = peakSnowLatched(now) ? Math.max(amount, PEAK_FIRST) : Math.min(amount, PEAK_BARE);
  // what the model says has been on the ground at the summit for the last half day: 5 cm shows
  // as a first snow, 40 cm and more as a well-covered peak; the table decides anything deeper.
  // (2 cm of one hour's model snow once whitened peaks that were bare to the eye, 2026-10-10.)
  const held = ridge ? (ridge.heldDepth ?? ridge.snowDepth) : 0;
  if (held >= LATCH_DEPTH) amount = Math.max(amount, PEAK_FIRST + 0.4 * clamp((held - LATCH_DEPTH) / 0.4, 0, 1));
  return amount;
}
