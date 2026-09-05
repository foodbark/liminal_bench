import { W, H, HORIZON, SCALE } from '../state.js';
import { fillCircle, ditherPattern, rgb, mulRGB, lerpRGB, scaleRGB, clamp, plotLine, makeCanvas } from '../util/pixel.js';
import { mulberry32 } from '../util/noise.js';
import { layoutCloud, cloudTones, cloudSprite } from './clouds.js';

const RAD = Math.PI / 180;
const patCtx = makeCanvas(1, 1)[1];
const ctx_pattern = (cv) => ({ cv });

export class WeatherFX {
  constructor() {
    this.clouds = []; this.rnd = mulberry32(99);
    this.rain = { t: 0, tiles: null, key: '' }; this.snow = { t: 0, tiles: null, key: '' };
    this.flash = 0; this.nextFlash = 4;
    this.t = 0;
  }

  update(env, dt) {
    this.t += dt;
    const cover = env.cond.cover;
    const target = Math.round(cover * 11 + (cover > 0.02 ? 1 : 0));
    while (this.clouds.length < target) this.clouds.push(this.makeCloud(true));
    while (this.clouds.length > target) this.clouds.pop();
    const sign = Math.sin(env.wind.dir * RAD) >= 0 ? 1 : -1;
    const speed = (1.5 + env.wind.speed * 0.4) * sign * SCALE;
    for (const c of this.clouds) {
      c.x += speed * c.depth * dt;
      if (c.x > W + 40) c.x = -c.w - 40; else if (c.x < -c.w - 40) c.x = W + 40;
    }
    // precipitation scrolls as tiled layers; only the phase advances here
    const p = env.cond.precip;
    if (p.type === 'rain') this.rain.t += dt; else this.rain.t = 0;
    if (p.type === 'snow') this.snow.t += dt; else this.snow.t = 0;
    // lightning
    if (env.cond.storm) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) { this.flash = 0.12 + Math.random() * 0.1; this.nextFlash = 5 + Math.random() * 12; }
    }
    if (this.flash > 0) this.flash -= dt;
  }

  makeCloud(anywhere) {
    const r = this.rnd;
    const depth = 0.4 + r() * 1.0;
    const c = layoutCloud(r, depth);
    // near clouds ride high and large, far ones sit small toward the horizon
    c.y = Math.floor((40 + (1.4 - depth) * 220 + r() * 90) * SCALE);
    c.x = anywhere ? r() * (W + c.w) - c.w : -c.w;
    c.depth = depth;
    return c;
  }

  drawClouds(ctx, env) {
    const cover = env.cond.cover;
    if (cover <= 0.02) return;
    const sunOnLeft = env.sun.azimuth < 180;
    const altK = clamp(env.sun.altitude / 60, 0, 1);
    const lightX = (sunOnLeft ? -1 : 1) * (1.0 - 0.5 * altK), lightY = -(0.35 + 0.65 * altK);
    if (cover > 0.85) {
      // a low ceiling: flat gray-blue deck with a scalloped, dithered underside
      const { tones } = cloudTones(env, 1);
      const deckH = Math.floor((40 + (cover - 0.85) * 500) * SCALE);
      const st = Math.round(22 * SCALE), rr = Math.round(14 * SCALE);
      ctx.fillStyle = rgb(tones[2]); ctx.fillRect(0, 0, W, deckH);
      ctx.fillStyle = ditherPattern(ctx, rgb(tones[3]), 8); ctx.fillRect(0, Math.floor(deckH * 0.55), W, deckH - Math.floor(deckH * 0.55));
      ctx.fillStyle = rgb(tones[3]);
      for (let x = -st; x < W + st; x += st) fillCircle(ctx, x, deckH - 3 + ((x / st) % 3 | 0) * 3 * SCALE, rr);
      ctx.fillStyle = ditherPattern(ctx, rgb(tones[3]), 5);
      for (let x = -st; x < W + st; x += st) fillCircle(ctx, x + (st >> 1), deckH + Math.round(4 * SCALE), rr - 2);
    }
    const sorted = [...this.clouds].sort((a, b) => a.depth - b.depth);
    for (const c of sorted) {
      const { tones, key } = cloudTones(env, c.depth);
      const sprite = cloudSprite(c, tones, key, lightX, lightY);
      ctx.drawImage(sprite, Math.round(c.x), c.y);
    }
  }

  drawFog(ctx, env) {
    if (!env.cond.fog) return;
    const col = rgb(mulRGB([214, 219, 230], env.pal.ambient));
    const bands = [[-110, -70, 2], [-70, -40, 5], [-40, -10, 8], [-10, 30, 10], [30, 80, 7], [80, 140, 4], [140, 200, 2]];
    for (const [a, b, lv] of bands) { ctx.fillStyle = ditherPattern(ctx, col, lv); ctx.fillRect(0, Math.round(HORIZON + a * SCALE), W, Math.round((b - a) * SCALE)); }
  }

  // A repeating tile of streaks or flakes; two layers scroll at different speeds for depth.
  precipTiles(kind, color, slant, intensity) {
    const T = Math.round(384 * SCALE);
    const tiles = [];
    const rnd = mulberry32(kind === 'rain' ? 7 : 8);
    for (let layer = 0; layer < 2; layer++) {
      const [cv, g] = makeCanvas(T, T);
      g.fillStyle = color;
      const perTile = (kind === 'rain' ? 420 : 380) / (1024 * 572) * T * T;   // the old particle density per area
      const n = Math.round(perTile * intensity * (layer ? 0.5 : 0.65));
      for (let i = 0; i < n; i++) {
        const x = Math.floor(rnd() * T), y = Math.floor(rnd() * T);
        if (kind === 'rain') {
          const len = Math.round((5 + Math.floor(rnd() * 3) * 2.5) * SCALE * (layer ? 0.7 : 1));
          const dx = Math.round(slant * len);
          // draw the streak twice (wrapped) so it tiles seamlessly at the edges
          for (const [ox, oy] of [[0, 0], [-T, 0], [T, 0], [0, -T], [0, T]]) plotLine(g, x + ox, y + oy, x + ox + dx, y + oy + len);
        } else {
          const sz = Math.max(1, Math.round((rnd() > 0.7 ? 2 : 1) * SCALE * (layer ? 0.7 : 1)));
          for (const [ox, oy] of [[0, 0], [-T, 0], [0, -T]]) g.fillRect(x + ox, y + oy, sz, sz);
        }
      }
      tiles.push(ctx_pattern(cv));
    }
    return { T, tiles };
  }

  drawPrecip(ctx, env) {
    // stamp a tile across the frame at the scroll offset
    const tileOver = (c, cv, T, ox, oy) => {
      for (let ty = oy - T; ty < H; ty += T) for (let tx = ox - T; tx < W; tx += T) c.drawImage(cv, tx, ty);
    };
    const amb = env.pal.ambient;
    const p = env.cond.precip;
    const sign = Math.sin(env.wind.dir * RAD) >= 0 ? 1 : -1;
    if (p.type === 'rain' && p.intensity > 0) {
      const color = rgb(lerpRGB(mulRGB([188, 198, 222], amb), [160, 170, 195], 0.3));
      const slant = env.wind.speed * 0.012 * sign;
      const key = `${color}|${slant.toFixed(2)}|${p.intensity.toFixed(1)}`;
      if (this.rain.key !== key) { this.rain.tiles = this.precipTiles('rain', color, slant, p.intensity); this.rain.key = key; }
      const { T, tiles } = this.rain.tiles;
      const vy = 520 * SCALE, vx = env.wind.speed * 3.5 * sign * SCALE;
      for (let layer = 0; layer < 2; layer++) {
        const k = layer ? 0.55 : 1;
        const oy = ((this.rain.t * vy * k) % T + T) % T, ox = ((this.rain.t * vx * k) % T + T) % T;
        tileOver(ctx, tiles[layer].cv, T, ox, oy);
      }
    }
    if (p.type === 'snow' && p.intensity > 0) {
      const k = Math.max(amb[0], 0.55);
      const color = `rgb(${(238 * k) | 0},${(241 * k) | 0},${(252 * k) | 0})`;
      const key = `${color}|${p.intensity.toFixed(1)}`;
      if (this.snow.key !== key) { this.snow.tiles = this.precipTiles('snow', color, 0, p.intensity); this.snow.key = key; }
      const { T, tiles } = this.snow.tiles;
      const vy = 42 * SCALE, drift = env.wind.speed * 1.2 * sign * SCALE;
      for (let layer = 0; layer < 2; layer++) {
        const kk = layer ? 0.6 : 1;
        const oy = ((this.snow.t * vy * kk) % T + T) % T;
        const ox = ((this.snow.t * drift * kk + Math.sin(this.snow.t * (layer ? 0.9 : 1.3)) * 14 * SCALE) % T + T) % T;
        tileOver(ctx, tiles[layer].cv, T, ox, oy);
      }
    }
    if (this.flash > 0) {
      ctx.fillStyle = ditherPattern(ctx, '#e8ecff', this.flash > 0.1 ? 9 : 4); ctx.fillRect(0, 0, W, H);
    }
  }
}
