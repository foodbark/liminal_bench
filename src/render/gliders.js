import { SCALE, META, ASSET_DIR, localParts } from '../state.js';
import { makeCanvas, rgb, clamp } from '../util/pixel.js';

// Paragliders off Mount Sentinel. On a fair day with a light wind into the face they are part of
// what the mountain does, winter included; nobody keeps a feed of who is in the air, so like the
// overnight dusting they are inferred from the weather. The wings are cut from the user's photo
// (assets/glider.png via tools/build_backdrop.py: the three wings that were up that day, each
// its own colors) and used at the photo's own size, two or three times what a wing would truly subtend
// here, the way the moon is. They soar a slow beat along the crest, turning at each end, drift
// a little with the wind, now and then glide out over the valley and come back to the lift, and
// when the day is done sink behind the ridge: the renderer lays the near planes (Sentinel, the
// trees, the props) back over them, so a wing below that skyline is hidden, while the far ranges
// stay behind a sail gliding out over the valley.
export const GLIDER = META.glider || null;

// Sail colors. The photo's wings are the pattern (the shading of the canopy, the lit tip, the
// pilot); a sail picks one of these and the wing's own light and shade are kept over it, the
// way the moon keeps the painting's maria under a new color. null keeps the photo's color.
const SAILS = [null, null, [236, 58, 58], [255, 138, 32], [248, 214, 58], [126, 208, 72], [62, 190, 232], [78, 104, 236], [206, 84, 224], [244, 244, 240]];

let img = null;
if (GLIDER && typeof Image !== 'undefined') {
  const im = new Image();
  im.onload = () => { img = im; };
  im.src = new URL('../../' + ASSET_DIR + '/' + GLIDER.file, import.meta.url).href;
}

// the ridge line they fly over, scene y for a scene x
function crestY(x) {
  const c = GLIDER.crest;
  if (x <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (x <= c[i][0]) { const t = (x - c[i - 1][0]) / (c[i][0] - c[i - 1][0]); return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t; }
  }
  return c[c.length - 1][1];
}

// How likely wings are up right now, 0..1: daylight well into the day (the face thermals from
// late morning), dry, no low cloud on the slopes, a light wind out of the west or southwest, so
// the launch faces into it. Strong wind or a north wind keeps everyone on the ground.
export function gliderChance(env) {
  if (env.sun.altitude < 4) return 0;
  const c = env.cond;
  if (c.precip.intensity > 0 || c.fog || c.storm || env.inversion || env.mountainFog > 0.3) return 0;
  const { hour, minute } = localParts(env.now);
  const h = hour + minute / 60;
  const day = clamp((h - 10) / 2, 0, 1) * clamp((19.5 - h) / 2, 0, 1);
  if (day <= 0) return 0;
  const spd = env.wind.speed;
  const wind = spd > 16 ? 0 : spd > 10 ? (16 - spd) / 6 : 1;
  const into = spd < 5 || (env.wind.dir >= 190 && env.wind.dir <= 300) ? 1 : 0.25;
  const sky = c.cover > 0.9 ? 0.35 : 1;
  return day * wind * into * sky;
}

export class Gliders {
  constructor() {
    this.list = [];
    this.next = 20 + Math.random() * 60;   // the first one, if the day allows, within the first minute or so
    this.sprites = new Map();   // recolored and lit strips, by sail and ambient
    this.label = 'paragliders off mount sentinel';
  }

  spawn(t0 = 0) {
    const a = GLIDER.air;
    const amp = (a.x1 - a.x0) * (0.12 + Math.random() * 0.2);   // half the length of the beat
    const cx = a.x0 + amp + Math.random() * Math.max(1, a.x1 - a.x0 - 2 * amp);
    this.list.push({
      cx, amp, period: 50 + Math.random() * 60, phase: Math.random() * Math.PI * 2,
      h0: a.hMin + (a.hMax - a.hMin) * (0.35 + Math.random() * 0.55), hAmp: (a.hMax - a.hMin) * (0.12 + Math.random() * 0.15),
      t: t0, life: 240 + Math.random() * 300, landing: false, h: 0, x: cx, y: 0,
      frame: Math.floor(Math.random() * GLIDER.frames), flip: false,   // which wing this is, and whether it is mirrored
      sail: Math.floor(Math.random() * SAILS.length),
      target: cx, retarget: 30 + Math.random() * 60,   // where the beat is drifting to, and when to pick again
    });
  }

  // force: 'live' follows the weather, 'up' keeps two in the air, 'none' grounds them
  update(env, dt, force = 'live') {
    if (!GLIDER) return;
    const chance = force === 'none' ? 0 : force === 'up' ? 1 : gliderChance(env);
    const flying = this.list.filter((g) => !g.landing).length;
    if (force === 'up') { while (this.list.filter((g) => !g.landing).length < 3) this.spawn(Math.random() * 120); }
    else if (chance > 0 && flying < 3) {
      this.next -= dt * chance;
      if (this.next <= 0) { this.spawn(); this.next = 150 + Math.random() * 240; }
    }
    if (chance === 0) for (const g of this.list) g.landing = true;   // the day is done, or the weather turned
    const windX = env.wind.speed * 0.12 * (Math.sin(env.wind.dir * Math.PI / 180) >= 0 ? 1 : -1) * SCALE;
    const a = GLIDER.air;
    for (const g of this.list) {
      g.t += dt;
      if (g.t > g.life) g.landing = true;
      const w = 2 * Math.PI / g.period, ph = w * g.t + g.phase;
      // a beat along the crest, turning at each end; a slow breathing of height, and a little
      // lift through the middle of the beat so the track is a figure eight rather than a line
      // the beat drifts toward a target: mostly somewhere along the face, now and then a glide
      // out over the valley (lower, the lift is weaker there) before coming back to the ridge
      g.retarget -= dt;
      if (g.retarget <= 0 && !g.landing) {
        g.retarget = 40 + Math.random() * 80;
        const out = Math.random() < 0.3 && a.outX > a.x1;
        g.target = out ? a.x1 + Math.random() * (a.outX - a.x1) : a.x0 + g.amp + Math.random() * Math.max(1, a.x1 - a.x0 - 2 * g.amp);
        g.h0 = a.hMin + (a.hMax - a.hMin) * (out ? 0.15 + Math.random() * 0.3 : 0.35 + Math.random() * 0.55);
      }
      const toward = g.target - g.cx, step = (a.x1 - a.x0) / 45 * dt;   // a crossing of the face in under a minute
      g.cx += Math.abs(toward) < step ? toward : Math.sign(toward) * step;
      g.cx += windX * dt;
      const lo = a.x0 + g.amp, hi = Math.max(a.x1, a.outX) - g.amp;
      if (g.cx < lo) g.cx = lo; else if (g.cx > hi) g.cx = hi;
      g.x = g.cx + g.amp * Math.sin(ph);
      let h = g.h0 + g.hAmp * Math.sin(ph * 0.43 + 1.3) + g.hAmp * 0.5 * Math.sin(2 * ph);
      if (g.landing) { g.h0 -= 5 * SCALE * dt; h = Math.min(h, g.h0); g.target = Math.min(g.target, a.x1 - g.amp); }   // back toward the face, and down behind it
      g.h = h;
      g.y = crestY(g.x) - h;
      // the wing leans into its direction of travel: mirrored when heading left
      g.flip = Math.cos(ph) < 0;
    }
    this.list = this.list.filter((g) => g.h > -60 * SCALE);
  }

  // the strip in one sail color: the canopy's light and shade from the photo laid over the sail,
  // the pilot (the bottom rows) left as he is
  recolored(sail) {
    const fw = GLIDER.w * GLIDER.frames, fh = GLIDER.h;
    const [cv, g] = makeCanvas(fw, fh);
    g.drawImage(img, 0, 0);
    const col = SAILS[sail];
    if (!col) return cv;
    const im = g.getImageData(0, 0, fw, fh), d = im.data;
    const pilotFrom = Math.round(fh * 0.6);
    let lo = 1, hi = 0;
    const lum = (i) => (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    for (let y = 0; y < pilotFrom; y++) for (let x = 0; x < fw; x++) { const i = (y * fw + x) * 4; if (d[i + 3]) { const L = lum(i); lo = Math.min(lo, L); hi = Math.max(hi, L); } }
    for (let y = 0; y < pilotFrom; y++) for (let x = 0; x < fw; x++) {
      const i = (y * fw + x) * 4;
      if (!d[i + 3]) continue;
      const t = (lum(i) - lo) / Math.max(0.05, hi - lo);
      const v = 0.72 + 0.5 * t;   // nylon glows: even the shaded canopy keeps most of the sail, the lit tip goes past full
      d[i] = Math.min(255, Math.round(col[0] * v)); d[i + 1] = Math.min(255, Math.round(col[1] * v)); d[i + 2] = Math.min(255, Math.round(col[2] * v));
    }
    g.putImageData(im, 0, 0);
    return cv;
  }

  // a sail's strip lit by the scene's ambient, like the props, rebuilt when the light changes
  sprite(env, sail) {
    if (!img) return null;
    const key = sail + '|' + env.ambientKey;
    let sp = this.sprites.get(key);
    if (sp) return sp;
    if (this.sprites.size > 40) this.sprites.clear();
    const fw = GLIDER.w * GLIDER.frames, fh = GLIDER.h;
    const base = this.recolored(sail);
    const [cv, g] = makeCanvas(fw, fh);
    g.drawImage(base, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = rgb(env.pal.ambient.map((v) => v * 255));
    g.fillRect(0, 0, fw, fh);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(base, 0, 0);
    g.globalCompositeOperation = 'source-over';
    this.sprites.set(key, cv);
    return cv;
  }

  draw(ctx, env) {
    if (!this.list.length || !img) return;
    const fw = GLIDER.w, fh = GLIDER.h;
    for (const g of this.list) {
      const sp = this.sprite(env, g.sail);
      const x = Math.round(g.x - fw / 2), y = Math.round(g.y - fh / 2);
      if (g.flip) { ctx.save(); ctx.translate(x + fw, y); ctx.scale(-1, 1); ctx.drawImage(sp, g.frame * fw, 0, fw, fh, 0, 0, fw, fh); ctx.restore(); }
      else ctx.drawImage(sp, g.frame * fw, 0, fw, fh, x, y, fw, fh);
    }
  }

  // for the hover caption: is a scene point on or near a wing
  hit(p) {
    const r = Math.max(GLIDER.w, 8 * SCALE);
    return this.list.some((g) => Math.abs(p.x - g.x) < r && Math.abs(p.y - g.y) < r);
  }
}
