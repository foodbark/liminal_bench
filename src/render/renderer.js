import { W, H, SMALL, SCALE, ASSET_DIR } from '../state.js';
import { makeCanvas, rgb, clamp } from '../util/pixel.js';
import { drawStars, drawMoon, drawSun, sunOverSheets, setStarMask, renderSkyGradient } from './sky.js';
import { renderTerrain } from './terrain.js';
import { renderSheets } from './sheets.js';

// The worker gets a plain copy of what renderTerrain reads from env.
function envForWorker(env) {
  return {
    pal: env.pal, sun: env.sun, moon: env.moon, lst: env.lst, cond: env.cond, month: env.month, snowAmount: env.snowAmount, sky: env.sky, wind: env.wind,
    groundSnow: env.groundSnow, inversion: env.inversion, fogTop: env.fogTop, mountainFog: env.mountainFog, dusting: env.dusting, greenup: env.greenup,
    photoAlto: !!photoField(), photoCirrus: !!photoCirrus(), photoDecks: !!photoDecks(),
  };
}
import { drawProps, drawShadows, drawLampGlow, drawCloseupNotes, noteFontReady, CLOSEUPS, drawPosterView } from './props.js';
import { drawBeacons, beaconsOn } from './beacons.js';
import { LAYER, MAT } from '../assets.js';
import { WeatherFX } from './weatherfx.js';
import { photoField, photoCirrus, photoDecks, drawField, drawCirrusMist, drawDeckMist, clearMistCover, mistCoverAt, VANISH as MIST_H } from './photoclouds.js';

const MIST_STEP = 5;   // pixels of drift between re-renders of the cirrus mist (a render costs most of a frame at full size; every five pixels is a hitch every few seconds instead of every other)

export class Renderer {
  constructor(canvas, assets) {
    this.canvas = canvas;
    this.assets = assets;
    if (assets) setStarMask(assets.mask);
    // terrain rebuilds run in a worker; until the first one lands the terrain canvas is empty
    // If the worker cannot run here (older browser: no module workers, no OffscreenCanvas, no
    // top-level await in workers) or never reports ready, the same passes run on the main thread.
    // Slower on a big painting, but the scene appears; an empty scene is never acceptable.
    this.workerReady = false; this.workerBusy = false; this.pendingKey = ''; this.pendingSkyKey = ''; this.dirty = true;
    this.useWorker = !/[?&]noworker\b/.test(location.search) && typeof Worker !== 'undefined';
    this.diag = { t0: performance.now(), stages: [], errors: [] };
    this.stage = (name) => this.diag.stages.push([name, Math.round(performance.now() - this.diag.t0)]);
    this.stage('renderer created');
    const fallback = (why) => {
      if (!this.useWorker) return;
      this.useWorker = false; this.workerReady = false;
      this.diag.errors.push('worker: ' + why); this.stage('fallback to main thread');
      console.warn('terrain worker unavailable (' + why + '); rendering on the main thread');
      try { this.worker && this.worker.terminate(); } catch (e) { /* ignore */ }
    };
    try {
      this.worker = this.useWorker ? new Worker(new URL('./terrain_worker.js' + (SMALL ? '?small=1' : ''), import.meta.url), { type: 'module' }) : null;
    } catch (e) { fallback(e.message); }
    if (this.worker) {
      this.worker.onerror = (e) => fallback(e.message || 'error');
      setTimeout(() => { if (!this.workerReady) fallback('no ready signal after 20s'); }, 20000);
    }
    if (this.worker) this.worker.onmessage = (e) => {
      if (e.data.ready) { this.workerReady = true; this.stage('worker ready'); return; }
      if (e.data.error) { this.diag.errors.push('worker job: ' + e.data.error); fallback(e.data.error); return; }
      this.workerBusy = false;
      const g = e.data.kind === 'sky' ? this.skyCtx : e.data.kind === 'sheets' ? this.sheetsCtx : this.terrainCtx;
      try { g.clearRect(0, 0, W, H); g.drawImage(e.data.bmp, 0, 0); e.data.bmp.close(); }
      catch (err) { this.diag.errors.push('draw ' + e.data.kind + ': ' + err.message); }
      if (e.data.kind === 'sky') { this.skyKey = e.data.key; if (!this.diag.skyDone) { this.diag.skyDone = true; this.stage('first sky'); } }
      else if (e.data.kind === 'sheets') this.sheetKey = e.data.key;
      else { this.terrainKey = e.data.key; if (!this.diag.terrainDone) { this.diag.terrainDone = true; this.stage('first terrain'); } }
      this.dirty = true;
    };
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    [this.base, this.baseCtx] = makeCanvas(W, H);
    [this.fg, this.fgCtx] = makeCanvas(W, H);
    // The near planes alone (Sentinel's face, the trees, the meadow, the props): what a paraglider
    // flies behind. The far ranges stay behind the wings, so one can glide out over the valley
    // in front of Dean Stone's forest and still sink behind the trees to land.
    [this.near, this.nearCtx] = makeCanvas(W, H);
    [this.nearMask, this.nearMaskCtx] = makeCanvas(W, H);
    // And the trees, the meadow and the props alone, without Sentinel's face: what a plane on
    // the Sentinel approach, under a mile out, flies behind while it is in front of the hill.
    [this.trees, this.treesCtx] = makeCanvas(W, H);
    [this.treesMask, this.treesMaskCtx] = makeCanvas(W, H);
    if (assets) {
      const img = this.nearMaskCtx.createImageData(W, H), d = img.data, m = assets.mask;
      const img2 = this.treesMaskCtx.createImageData(W, H), d2 = img2.data;
      for (let i = 0; i < d.length; i += 4) {
        if (m[i] >= LAYER.FLANK || m[i + 1] === MAT.PROP) d[i + 3] = 255;
        if (m[i] >= LAYER.TREES || m[i + 1] === MAT.PROP) d2[i + 3] = 255;
      }
      this.nearMaskCtx.putImageData(img, 0, 0);
      this.treesMaskCtx.putImageData(img2, 0, 0);
    }
    this.baseKey = ''; this.camKey = '';
    [this.sky, this.skyCtx] = makeCanvas(W, H);
    [this.terrain, this.terrainCtx] = makeCanvas(W, H);
    [this.props, this.propsCtx] = makeCanvas(W, H);
    [this.sheets, this.sheetsCtx] = makeCanvas(W, H);
    this.sheetKey = ''; this.pendingSheetKey = ''; this.sheetX = 0;
    [this.field, this.fieldCtx] = makeCanvas(W, H); this.fieldKey = '';   // the photographed altocumulus field, scrolled with the sheets
    [this.deck, this.deckCtx] = makeCanvas(W, MIST_H); this.deckKey = '';   // the overcast decks from the photos, stippled near solid, drifting like the mist
    [this.mist, this.mistCtx] = makeCanvas(W, MIST_H); this.mistKey = '';   // the cirrus as mist: a fixed stipple, the density drifting under it, re-rendered every few pixels of drift
    [this.propsLit, this.propsLitCtx] = makeCanvas(W, H);
    // Show the painting at once, in its own daylight colors, so the scene is never empty while
    // the first lighting pass runs (seconds on a big painting, much longer on a phone).
    if (assets) {
      const img = this.terrainCtx.createImageData(W, H), d = img.data, rgb = assets.rgb, m = assets.mask;
      for (let i = 0; i < d.length; i += 4) {
        if (m[i] === 0) continue;
        d[i] = rgb[i]; d[i + 1] = rgb[i + 1]; d[i + 2] = rgb[i + 2]; d[i + 3] = 255;
      }
      this.terrainCtx.putImageData(img, 0, 0);
    }
    this.skyKey = ''; this.terrainKey = ''; this.propsKey = ''; this.tintKey = '';
    // close-up paintings for the zoomed views, loaded on the page; the canvas is made on first use
    this.closeupImgs = {}; this.closeupKey = ''; this.closeup = null; this.closeupCtx = null;
    if (typeof Image !== 'undefined') for (const [id, cu] of Object.entries(CLOSEUPS)) {
      const im = new Image();
      im.onload = () => { this.closeupImgs[id] = im; this.dirty = true; };
      im.src = new URL('../../' + ASSET_DIR + '/' + cu.file, import.meta.url).href;
    }
    this.fx = new WeatherFX();
  }

  refreshCaches(state) {
    const env = state.env;
    if (!this.useWorker) {
      // main-thread fallback: same passes, synchronous
      if (!this.skyImg) { this.skyImg = this.skyCtx.createImageData(W, H); this.terrainImg = this.terrainCtx.createImageData(W, H); }
      if (env.skyKey !== this.skyKey) { renderSkyGradient(this.skyImg, env); this.skyCtx.putImageData(this.skyImg, 0, 0); this.skyKey = env.skyKey; this.dirty = true; }
      if (env.sheetKey !== this.sheetKey) { if (!this.sheetImg) this.sheetImg = this.sheetsCtx.createImageData(W, H); renderSheets(this.sheetImg, env); this.sheetsCtx.putImageData(this.sheetImg, 0, 0); this.sheetKey = env.sheetKey; this.dirty = true; }
      if (env.terrainKey !== this.terrainKey) { renderTerrain(this.terrainImg, env, this.assets); this.terrainCtx.putImageData(this.terrainImg, 0, 0); this.terrainKey = env.terrainKey; this.dirty = true; if (!this.diag.terrainDone) { this.diag.terrainDone = true; this.stage('first terrain (main thread)'); } }
    }
    // One job at a time in the worker; the sky is cheaper, so it goes first when both are stale.
    if (this.useWorker && this.workerReady && !this.workerBusy) {
      if (env.skyKey !== this.skyKey && env.skyKey !== this.pendingSkyKey) {
        this.workerBusy = true; this.pendingSkyKey = env.skyKey;
        this.worker.postMessage({ kind: 'sky', key: env.skyKey, env: envForWorker(env) });
      } else if (env.terrainKey !== this.terrainKey && env.terrainKey !== this.pendingKey) {
        this.workerBusy = true; this.pendingKey = env.terrainKey;
        this.worker.postMessage({ kind: 'terrain', key: env.terrainKey, env: envForWorker(env) });
      } else if (env.sheetKey !== this.sheetKey && env.sheetKey !== this.pendingSheetKey) {
        this.workerBusy = true; this.pendingSheetKey = env.sheetKey;
        this.worker.postMessage({ kind: 'sheets', key: env.sheetKey, env: envForWorker(env) });
      }
    }
    const propsKey = env.sunSide + '|' + env.groundSnow + '|' + state.notesVersion;
    if (propsKey !== this.propsKey) { drawProps(this.propsCtx, state, env.sunSide, env.groundSnow); this.propsKey = propsKey; this.tintKey = ''; this.dirty = true; }
    const tintKey = env.ambientKey;
    if (tintKey !== this.tintKey) {
      const g = this.propsLitCtx;
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, W, H);
      g.drawImage(this.props, 0, 0);
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = rgb(env.pal.ambient.map((v) => v * 255));
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(this.props, 0, 0);
      g.globalCompositeOperation = 'source-over';
      this.tintKey = tintKey; this.dirty = true;
    }
  }

  render(state, t, dt) {
    const env = state.env;
    this.refreshCaches(state);
    this.fx.update(env, dt, state.override.enabled ? state.override.gliders : 'live', state.flights);
    // Two static layers, rebuilt only when a cache key changes: `base` (sky, moon, sun, terrain,
    // fog bands, shadows, props) and `fg` (the same without the sky, so it can go back over the
    // clouds). Each frame draws straight to the visible canvas under the camera transform:
    // base, sheets, stars (clipped to sky), meteors, cumulus, fg if there are clouds or a meteor, paragliders
    // and then the near planes back over them, lamp glow, precipitation.
    // On a big painting every full-frame draw counts, and idle daytime frames skip everything.
    const cam = state.camera;
    const camKey = `${cam.cx.toFixed(1)}|${cam.cy.toFixed(1)}|${cam.s.toFixed(3)}`;
    const baseKey = `${this.skyKey}|${this.terrainKey}|${this.propsKey}|${this.tintKey}|${env.cond.fog}|${Math.round(env.sun.altitude * 2)}|${Math.round(env.sun.azimuth)}|${env.moon.altitude.toFixed(0)}|${env.moon.phase.toFixed(2)}|${env.cond.cover.toFixed(1)}`;
    if (baseKey !== this.baseKey) {
      const g = this.fgCtx;
      g.clearRect(0, 0, W, H);
      g.drawImage(this.terrain, 0, 0);
      this.fx.drawFog(g, env);
      drawShadows(g, env);
      g.drawImage(this.propsLit, 0, 0);
      const b = this.baseCtx;
      b.drawImage(this.sky, 0, 0);
      drawMoon(b, env);
      drawSun(b, env);
      b.drawImage(this.fg, 0, 0);
      const n = this.nearCtx;
      n.globalCompositeOperation = 'source-over'; n.clearRect(0, 0, W, H); n.drawImage(this.fg, 0, 0);
      n.globalCompositeOperation = 'destination-in'; n.drawImage(this.nearMask, 0, 0);
      n.globalCompositeOperation = 'source-over';
      const tc = this.treesCtx;
      tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, W, H); tc.drawImage(this.fg, 0, 0);
      tc.globalCompositeOperation = 'destination-in'; tc.drawImage(this.treesMask, 0, 0);
      tc.globalCompositeOperation = 'source-over';
      this.baseKey = baseKey; this.dirty = true;
    }
    // Standing at a prop: its close-up painting over the zoomed scene, notes set legibly on its
    // cork, lit by the same ambient as the props. Rebuilt only when something on it changes.
    const cuId = state.closeup && CLOSEUPS[state.closeup] && this.closeupImgs[state.closeup] ? state.closeup : null;
    const cuKey = cuId ? `${cuId}|${this.tintKey}|${state.notesVersion}|${noteFontReady()}` : '';
    if (cuKey !== this.closeupKey) {
      this.closeupKey = cuKey; this.dirty = true;
      if (cuId) {
        if (!this.closeup) [this.closeup, this.closeupCtx] = makeCanvas(W, H);
        const g = this.closeupCtx, im = this.closeupImgs[cuId];
        g.globalCompositeOperation = 'source-over';
        g.clearRect(0, 0, W, H);
        g.drawImage(im, 0, 0, W, H);
        drawCloseupNotes(g, state, CLOSEUPS[cuId]);
        // lit by the props' ambient, lifted almost halfway to full: up close the paper has to
        // stay readable at night (the lantern is right there), and by day this changes nothing
        g.globalCompositeOperation = 'multiply';
        g.fillStyle = rgb(env.pal.ambient.map((v) => (v + (1 - v) * 0.45) * 255));
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(im, 0, 0, W, H);
        g.globalCompositeOperation = 'source-over';
      }
    }
    const night = env.sun.altitude < -3;
    const sk = env.sky;
    const sheets = !!sk && (sk.cirrus + sk.veilHigh + sk.alto + sk.veilMid + sk.strato + sk.stratus + sk.nimbo) > 0.01;
    const clouds = (sk ? sk.cumulus > 0.02 : env.cond.cover > 0.02) || sheets;
    // sheets drift with the wind, high and slow
    const sgn = Math.sin(env.wind.dir * Math.PI / 180) >= 0 ? 1 : -1;
    this.sheetX = ((this.sheetX + (0.25 + env.wind.speed * 0.07) * SCALE * sgn * dt) % W + W) % W;
    const gliders = this.fx.gliders.list.length > 0;
    // the aircraft by depth band (render/flights.js): a far one counts only when it is up over
    // the ridge line, since under it the terrain hides it, and thirty of them a day would
    // otherwise keep a clear still scene redrawing; a close one wherever it is in the frame
    const fb = this.fx.flights.bands(), flights = fb.any;
    const posterKey = state.poster ? `${state.poster.poster.id}|${state.notesVersion}` : '';
    if (posterKey !== this.posterKey) { this.posterKey = posterKey; this.dirty = true; }
    const animated = clouds || env.cond.precip.intensity > 0 || night || this.fx.flash > 0 || gliders || flights;
    if (!this.dirty && !animated && camKey === this.camKey) return;
    this.dirty = false; this.camKey = camKey;

    const P = this.profile ? (this.steps = {}) : null;
    let t0 = P ? performance.now() : 0;
    const lap = (name) => { if (P) { const n = performance.now(); P[name] = Math.round((n - t0) * 100) / 100; t0 = n; } };
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (cam.s !== 1) { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
    c.imageSmoothingEnabled = false;
    c.setTransform(cam.s, 0, 0, cam.s, Math.round(W / 2 - cam.cx * cam.s), Math.round(H / 2 - cam.cy * cam.s));
    c.drawImage(this.base, 0, 0); lap('base');
    // The thin sheets go under the stars: they are sparse scrolling dither, and a star behind a
    // cirrus wisp was covered and uncovered by passing pixels, a strobe. Cover already dims the
    // stars; cumulus, which are solid, still pass in front of them.
    // A low deck (stratocumulus, stratus, nimbostratus) is solid enough that it stays in front.
    const thin = sheets && (sk.strato + sk.stratus + sk.nimbo) < 0.05;
    // the cirrus mist is never scrolled: its stipple is fixed to the screen and the density
    // drifts under it, re-rendered every MIST_STEP pixels of the sheets' drift; the altocumulus
    // goes through it as fish scales while the cirrus tile is loaded, else as the field's sprites
    const mistOn = sheets && (sk.cirrus + sk.veilHigh + sk.veilMid + sk.alto) > 0.01 && !!photoCirrus();
    const fieldOn = sheets && sk.alto > 0.01 && !!photoField() && !mistOn;
    const deckOn = sheets && (sk.strato + sk.stratus + sk.nimbo) > 0.01 && !!photoDecks();
    if (deckOn) {
      const deckKey = env.sheetKey + '|' + Math.floor(this.sheetX / MIST_STEP);
      if (deckKey !== this.deckKey) { drawDeckMist(this.deckCtx, env, this.sheetX); this.deckKey = deckKey; lap('deck'); }
    }
    if (fieldOn && env.sheetKey !== this.fieldKey) { drawField(this.fieldCtx, env); this.fieldKey = env.sheetKey; }
    if (mistOn) {
      const mistKey = env.sheetKey + '|' + Math.floor(this.sheetX / MIST_STEP);
      if (mistKey !== this.mistKey) {
        // the sky's own pixels for the blend, read once per rendered sky
        if (this.skyPixKey !== this.skyKey) { this.skyPix = this.skyCtx.getImageData(0, 0, W, MIST_H); this.skyPixKey = this.skyKey; }
        drawCirrusMist(this.mistCtx, env, this.sheetX, this.skyPix); this.mistKey = mistKey; lap('mist');
      }
    } else if (this.mistKey) { this.mistKey = ''; clearMistCover(); }   // no mist: the stars' coverage map goes clear
    const drawSheets = () => {
      const ox = Math.round(this.sheetX);
      // the mist and the field are the high and middle cloud: under a low deck (stratocumulus,
      // stratus, nimbostratus) they go on first and the deck covers them, since a deck is below
      // them (the fish scales were drawn on top of a solid stratus, 2026-10-21); over thin sheets
      // they go on last
      if (!thin) {
        if (mistOn) c.drawImage(this.mist, 0, 0);
        if (fieldOn) { c.drawImage(this.field, ox, 0); c.drawImage(this.field, ox - W, 0); }
      }
      c.drawImage(this.sheets, ox, 0); c.drawImage(this.sheets, ox - W, 0);
      if (deckOn) c.drawImage(this.deck, 0, 0);   // the lowest cloud there is, over everything above it
      if (thin) {
        if (mistOn) c.drawImage(this.mist, 0, 0);
        if (fieldOn) { c.drawImage(this.field, ox, 0); c.drawImage(this.field, ox - W, 0); }
      }
      lap('sheets');
    };
    if (thin) drawSheets();
    // the sun comes back over the high sheets: a cirrostratus veil leaves the disc, with a halo
    if (thin && sunOverSheets(sk)) { drawSun(c, env, true); lap('sun'); }
    // the moon comes back over the mist too, dimmed by what the mist has over it
    if (thin && mistOn && env.moon.altitude > 0) { drawMoon(c, env, mistCoverAt); lap('moon'); }
    drawStars(c, env, t); lap('stars');
    const meteors = this.fx.meteors.length > 0;
    if (meteors) { this.fx.drawMeteors(c); lap('meteors'); }
    if (sheets && !thin) drawSheets();
    // the far aircraft: specks and contrails by day, lights by night, behind the cumulus
    this.fx.flights.begin();
    if (fb.far) { this.fx.flights.draw(c, env, t, 'far'); lap('flights'); }
    if (clouds) { this.fx.drawClouds(c, env); lap('clouds'); }
    // the terrain goes back over the clouds, and over a meteor or an aircraft so it passes behind the ridges
    if (clouds || meteors || fb.far) { c.drawImage(this.fg, 0, 0); lap('fg'); }
    // wings fly in front of the clouds and the far ranges, behind Sentinel, the trees and the props
    if (gliders) { this.fx.gliders.draw(c, env); c.drawImage(this.near, 0, 0); lap('gliders'); }
    // the low traffic: inside ten kilometres in front of Dean Stone and behind Sentinel, like
    // the wings; under a mile out in front of Sentinel too, behind only the trees and the props
    if (fb.mid) { this.fx.flights.draw(c, env, t, 'mid'); c.drawImage(this.near, 0, 0); lap('flights mid'); }
    if (fb.near) { this.fx.flights.draw(c, env, t, 'near'); c.drawImage(this.trees, 0, 0); lap('flights near'); }
    // the red beacons on the masts, in front of the mountain and the fog on it, behind the rain
    if (beaconsOn(env)) { drawBeacons(c, env, t); lap('beacons'); }
    drawLampGlow(c, env); lap('lamp');
    if (cuId) { c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(this.closeup, 0, 0); c.setTransform(cam.s, 0, 0, cam.s, Math.round(W / 2 - cam.cx * cam.s), Math.round(H / 2 - cam.cy * cam.s)); lap('closeup'); }
    this.fx.drawPrecip(c, env); lap('precip');
    c.setTransform(1, 0, 0, 1, 0, 0);
    // a poster held up to look at, over everything, the scene dimmed behind it
    if (state.poster && state.poster.poster) { drawPosterView(c, state.poster); lap('poster'); }
  }
}
