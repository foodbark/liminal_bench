import { W, H, SMALL, SCALE } from '../state.js';
import { makeCanvas, rgb, clamp } from '../util/pixel.js';
import { drawStars, drawMoon, drawSun, setStarMask, renderSkyGradient } from './sky.js';
import { renderTerrain } from './terrain.js';
import { renderSheets } from './sheets.js';

// The worker gets a plain copy of what renderTerrain reads from env.
function envForWorker(env) {
  return {
    pal: env.pal, sun: env.sun, moon: env.moon, cond: env.cond, month: env.month, snowAmount: env.snowAmount, sky: env.sky, wind: env.wind,
    groundSnow: env.groundSnow, inversion: env.inversion, mountainFog: env.mountainFog, dusting: env.dusting,
  };
}
import { drawProps, drawShadows, drawLampGlow } from './props.js';
import { WeatherFX } from './weatherfx.js';

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
    this.baseKey = ''; this.camKey = '';
    [this.sky, this.skyCtx] = makeCanvas(W, H);
    [this.terrain, this.terrainCtx] = makeCanvas(W, H);
    [this.props, this.propsCtx] = makeCanvas(W, H);
    [this.sheets, this.sheetsCtx] = makeCanvas(W, H);
    this.sheetKey = ''; this.pendingSheetKey = ''; this.sheetX = 0;
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
    this.fx.update(env, dt);
    // Two static layers, rebuilt only when a cache key changes: `base` (sky, moon, sun, terrain,
    // fog bands, shadows, props) and `fg` (the same without the sky, so it can go back over the
    // clouds). Each frame draws straight to the visible canvas under the camera transform:
    // base, stars (clipped to sky), clouds, fg if there are clouds, lamp glow, precipitation.
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
      this.baseKey = baseKey; this.dirty = true;
    }
    const night = env.sun.altitude < -3;
    const sk = env.sky;
    const sheets = !!sk && (sk.cirrus + sk.veilHigh + sk.alto + sk.veilMid + sk.strato + sk.stratus + sk.nimbo) > 0.01;
    const clouds = (sk ? sk.cumulus > 0.02 : env.cond.cover > 0.02) || sheets;
    // sheets drift with the wind, high and slow
    const sgn = Math.sin(env.wind.dir * Math.PI / 180) >= 0 ? 1 : -1;
    this.sheetX = ((this.sheetX + (0.4 + env.wind.speed * 0.12) * SCALE * sgn * dt) % W + W) % W;
    const animated = clouds || env.cond.precip.intensity > 0 || night || this.fx.flash > 0;
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
    drawStars(c, env, t); lap('stars');
    if (clouds) {
      if (sheets) { const ox = Math.round(this.sheetX); c.drawImage(this.sheets, ox, 0); c.drawImage(this.sheets, ox - W, 0); lap('sheets'); }
      this.fx.drawClouds(c, env); lap('clouds');
      c.drawImage(this.fg, 0, 0); lap('fg');
    }
    drawLampGlow(c, env); lap('lamp');
    this.fx.drawPrecip(c, env); lap('precip');
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
}
