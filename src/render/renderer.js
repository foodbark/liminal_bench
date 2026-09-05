import { W, H } from '../state.js';
import { makeCanvas, rgb, clamp } from '../util/pixel.js';
import { drawStars, drawMoon, drawSun, setStarMask } from './sky.js';

// The worker gets a plain copy of what renderTerrain reads from env.
function envForWorker(env) {
  return {
    pal: env.pal, sun: env.sun, moon: env.moon, cond: env.cond, month: env.month, snowAmount: env.snowAmount,
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
    this.worker = new Worker(new URL('./terrain_worker.js', import.meta.url), { type: 'module' });
    this.workerReady = false; this.workerBusy = false; this.pendingKey = ''; this.pendingSkyKey = ''; this.dirty = true;
    this.worker.onmessage = (e) => {
      if (e.data.ready) { this.workerReady = true; return; }
      this.workerBusy = false;
      const g = e.data.kind === 'sky' ? this.skyCtx : this.terrainCtx;
      g.clearRect(0, 0, W, H); g.drawImage(e.data.bmp, 0, 0); e.data.bmp.close();
      if (e.data.kind === 'sky') this.skyKey = e.data.key; else this.terrainKey = e.data.key;
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
    [this.propsLit, this.propsLitCtx] = makeCanvas(W, H);
    this.skyKey = ''; this.terrainKey = ''; this.propsKey = ''; this.tintKey = '';
    this.fx = new WeatherFX();
  }

  refreshCaches(state) {
    const env = state.env;
    // One job at a time in the worker; the sky is cheaper, so it goes first when both are stale.
    if (this.workerReady && !this.workerBusy) {
      if (env.skyKey !== this.skyKey && env.skyKey !== this.pendingSkyKey) {
        this.workerBusy = true; this.pendingSkyKey = env.skyKey;
        this.worker.postMessage({ kind: 'sky', key: env.skyKey, env: envForWorker(env) });
      } else if (env.terrainKey !== this.terrainKey && env.terrainKey !== this.pendingKey) {
        this.workerBusy = true; this.pendingKey = env.terrainKey;
        this.worker.postMessage({ kind: 'terrain', key: env.terrainKey, env: envForWorker(env) });
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
    const clouds = env.cond.cover > 0.02;
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
      this.fx.drawClouds(c, env); lap('clouds');
      c.drawImage(this.fg, 0, 0); lap('fg');
    }
    drawLampGlow(c, env); lap('lamp');
    this.fx.drawPrecip(c, env); lap('precip');
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
}
