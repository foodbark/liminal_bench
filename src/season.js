import { SEASON_SNOW } from './state.js';
import { clamp } from './util/pixel.js';

// When does the snow arrive on the peaks? Not on a calendar. The summit weather (Dean Stone,
// weather.js) says when it has really accumulated up there, and that moment is latched in this
// browser so the peaks stay snowed through the fall and winter instead of flickering with each
// forecast refresh. SEASON_SNOW keeps its job for how deep the winter gets and for the spring
// melt; the live summit depth holds snow up through a warm spell and takes it away in May.
//
// A first snow is not winter, though: an October fall whitens Dean Stone for a few days and
// melts off. So the latch also remembers when the summit model went bare again, and from then
// the white crest fades off over a few days (a day's grace first, since the model melts faster
// than the north face the bench looks at), and the latch lets go, so September through December
// are bare again until the next real accumulation. A latch that held until August kept a white
// rim on Dean Stone three days after the real crest had melted (the user, 2026-10-15).
const KEY = 'liminal.peakSnow';
const LATCH_DEPTH = 0.05;          // metres at the summit that count as winter having arrived
const BARE_DEPTH = 0.01;           // metres under which the summit model counts as bare again
const MELT_GRACE = 1;              // days the crest stays white after the model goes bare
const MELT_DAYS = 3;               // then days to fade off
const ARRIVAL = [8, 9, 10, 11];    // Sep..Dec: the months the calendar alone does not get to whiten
export const PEAK_BARE = 0.04;     // October's table value: under the painting's own summit snow, so it reads as rock
export const PEAK_FIRST = 0.3;     // first snow: a white crest over a still-green valley

let latch = null;   // { since: ms, bare: ms | null }: when the snow arrived, and when the summit went bare again
try { latch = JSON.parse(localStorage.getItem(KEY)); } catch (e) { latch = null; }
if (latch && typeof latch.since !== 'number') latch = null;
if (latch && typeof latch.bare !== 'number') latch.bare = null;

function save() { try { if (latch) localStorage.setItem(KEY, JSON.stringify(latch)); else localStorage.removeItem(KEY); } catch (e) { /* private window: the session still has it */ } }

// A latch is good for one snow year (from Aug 1); last winter's does not whiten this September.
function snowYearStart(now) { const y = now.getFullYear(); return new Date(now.getMonth() >= 7 ? y : y - 1, 7, 1).getTime(); }
export function peakSnowLatched(now) { return !!latch && latch.since >= snowYearStart(now); }
export function peakSnowSince() { return latch ? new Date(latch.since) : null; }
export function peakSnowBareSince() { return latch && latch.bare ? new Date(latch.bare) : null; }

// how much of the latched first snow is left: 1 while the summit holds it, fading to 0 over
// the days after the model went bare
export function peakSnowMelt(now = new Date()) {
  if (!latch || !latch.bare) return 1;
  const days = (now.getTime() - latch.bare) / 86400000;
  return clamp(1 - (days - MELT_GRACE) / MELT_DAYS, 0, 1);
}

export function updatePeakSnowLatch(ridge, now = new Date()) {
  if (!ridge) return;
  const held = ridge.heldDepth ?? ridge.snowDepth;
  if (!peakSnowLatched(now)) {
    if (held >= LATCH_DEPTH) { latch = { since: now.getTime(), bare: null }; save(); }   // held for half a day, not one hour's blip
    return;
  }
  if (held >= LATCH_DEPTH) {
    if (latch.bare) { latch.bare = null; save(); }   // snow again up there
  } else if ((ridge.recentMax ?? ridge.snowDepth) < BARE_DEPTH && !latch.bare) {
    latch.bare = ridge.bareSince ?? now.getTime();   // bare for half a day: start the melt, from when the model went bare
    save();
  }
  if (latch.bare && peakSnowMelt(now) <= 0) { latch = null; save(); }   // melted off: back to bare until the next real snow
}

export function peakSnowAmount(month, now, ridge) {
  let amount = SEASON_SNOW[month];
  const arriving = ARRIVAL.includes(month);
  if (arriving) {
    // latched: the table's depth, floored at a white crest, fading back to bare as the first
    // snow melts off; not latched: bare whatever the table says
    amount = peakSnowLatched(now) ? PEAK_BARE + (Math.max(amount, PEAK_FIRST) - PEAK_BARE) * peakSnowMelt(now) : Math.min(amount, PEAK_BARE);
  }
  // what the model says has been on the ground at the summit for the last half day: 5 cm shows
  // as a first snow, 40 cm and more as a well-covered peak; the table decides anything deeper.
  // (2 cm of one hour's model snow once whitened peaks that were bare to the eye, 2026-10-10.)
  const held = ridge ? (ridge.heldDepth ?? ridge.snowDepth) : 0;
  if (held >= LATCH_DEPTH) amount = Math.max(amount, PEAK_FIRST + 0.4 * clamp((held - LATCH_DEPTH) / 0.4, 0, 1));
  return amount;
}
