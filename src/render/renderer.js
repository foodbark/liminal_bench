import { W, H } from '../state.js';
import { makeCanvas, rgb, clamp } from '../util/pixel.js';
import { renderSkyGradient, drawStars, drawMoon, drawSun } from './sky.js';
import { renderTerrain } from './terrain.js';
import { drawProps, drawShadows, drawLampGlow } from './props.js';
import { WeatherFX } from './weatherfx.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    [this.frame, this.frameCtx] = makeCanvas(W, H);
    [this.sky, this.skyCtx] = makeCanvas(W, H);
    [this.terrain, this.terrainCtx] = makeCanvas(W, H);
    [this.props, this.propsCtx] = makeCanvas(W, H);
    [this.propsLit, this.propsLitCtx] = makeCanvas(W, H);
    this.skyImg = this.skyCtx.createImageData(W, H);
    this.terrainImg = this.terrainCtx.createImageData(W, H);
    this.skyKey = ''; this.terrainKey = ''; this.propsKey = ''; this.tintKey = '';
    this.fx = new WeatherFX();
  }

  refreshCaches(state) {
    const env = state.env;
    if (env.skyKey !== this.skyKey) {
      renderSkyGradient(this.skyImg, env);
      this.skyCtx.putImageData(this.skyImg, 0, 0);
      this.skyKey = env.skyKey;
    }
    if (env.terrainKey !== this.terrainKey) {
      renderTerrain(this.terrainImg, env);
      this.terrainCtx.putImageData(this.terrainImg, 0, 0);
      this.terrainKey = env.terrainKey;
    }
    const propsKey = env.sunSide + '|' + env.groundSnow + '|' + state.notesVersion;
    if (propsKey !== this.propsKey) { drawProps(this.propsCtx, state, env.sunSide, env.groundSnow); this.propsKey = propsKey; this.tintKey = ''; }
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
      this.tintKey = tintKey;
    }
  }

  render(state, t, dt) {
    const env = state.env;
    this.refreshCaches(state);
    this.fx.update(env, dt);
    const f = this.frameCtx;
    f.drawImage(this.sky, 0, 0);
    drawStars(f, env, t);
    drawMoon(f, env);
    drawSun(f, env);
    this.fx.drawClouds(f, env);
    f.drawImage(this.terrain, 0, 0);
    this.fx.drawFog(f, env);
    drawShadows(f, env);
    f.drawImage(this.propsLit, 0, 0);
    drawLampGlow(f, env);
    this.fx.drawPrecip(f, env);

    const cam = state.camera;
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    c.imageSmoothingEnabled = false;
    c.setTransform(cam.s, 0, 0, cam.s, W / 2 - cam.cx * cam.s, H / 2 - cam.cy * cam.s);
    c.drawImage(this.frame, 0, 0);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
}
