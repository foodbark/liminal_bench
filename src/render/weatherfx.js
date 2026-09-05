import { W, H, HORIZON, SCALE } from '../state.js';
import { fillCircle, ditherPattern, rgb, mulRGB, lerpRGB, scaleRGB, clamp, plotLine } from '../util/pixel.js';
import { mulberry32 } from '../util/noise.js';
import { layoutCloud, cloudTones, cloudSprite } from './clouds.js';

const RAD = Math.PI / 180;

export class WeatherFX {
  constructor() {
    this.clouds = []; this.rnd = mulberry32(99);
    this.drops = []; this.flakes = [];
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
    // precipitation
    const p = env.cond.precip;
    const windX = env.wind.speed * 3.5 * sign;
    if (p.type === 'rain') {
      const n = Math.floor(p.intensity * 420 * SCALE * SCALE);
      while (this.drops.length < n) this.drops.push({ x: Math.random() * W, y: Math.random() * H, v: (380 + Math.random() * 260) * SCALE, len: (5 + Math.random() * 5) * SCALE });
      this.drops.length = Math.min(this.drops.length, n);
      for (const d of this.drops) { d.y += d.v * dt; d.x += windX * dt; if (d.y > H) { d.y = -10; d.x = Math.random() * (W + 200) - 100; } }
    } else this.drops.length = 0;
    if (p.type === 'snow') {
      const n = Math.floor(p.intensity * 380 * SCALE * SCALE);
      while (this.flakes.length < n) this.flakes.push({ x: Math.random() * W, y: Math.random() * H, v: (22 + Math.random() * 40) * SCALE, ph: Math.random() * 6.28, s: Math.round((Math.random() > 0.7 ? 2 : 1) * SCALE) });
      this.flakes.length = Math.min(this.flakes.length, n);
      for (const f of this.flakes) {
        f.y += f.v * dt; f.x += (Math.sin(this.t * 1.3 + f.ph) * 14 * SCALE + windX * 0.35) * dt;
        if (f.y > H) { f.y = -4; f.x = Math.random() * (W + 200) - 100; }
        if (f.x < -10) f.x += W + 20; else if (f.x > W + 10) f.x -= W + 20;
      }
    } else this.flakes.length = 0;
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
      const { tones } = cloudTones(env, 1);
      const deckH = Math.floor((40 + (cover - 0.85) * 500) * SCALE);
      const st = Math.round(34 * SCALE), rr = Math.round(24 * SCALE);
      ctx.fillStyle = rgb(tones[3]); ctx.fillRect(0, 0, W, deckH);
      ctx.fillStyle = rgb(tones[4]);
      for (let x = -20; x < W + 20; x += st) fillCircle(ctx, x, deckH - 4 + ((x / st) % 3 | 0) * 4, rr);
      ctx.fillStyle = ditherPattern(ctx, rgb(tones[3]), 6);
      for (let x = -20; x < W + 20; x += st) fillCircle(ctx, x + (st >> 1) - 7, deckH - 10, rr - 2);
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

  drawPrecip(ctx, env) {
    const amb = env.pal.ambient;
    if (this.drops.length) {
      ctx.fillStyle = rgb(lerpRGB(mulRGB([188, 198, 222], amb), [160, 170, 195], 0.3));
      const sign = Math.sin(env.wind.dir * RAD) >= 0 ? 1 : -1;
      const slant = env.wind.speed * 0.012 * sign;
      // drops are drawn as short streaks scaled with the scene
      for (const d of this.drops) plotLine(ctx, d.x, d.y, d.x + slant * d.len, d.y + d.len);
    }
    if (this.flakes.length) {
      const k = Math.max(amb[0], 0.55);
      ctx.fillStyle = `rgb(${(238 * k) | 0},${(241 * k) | 0},${(252 * k) | 0})`;
      for (const f of this.flakes) ctx.fillRect(f.x | 0, f.y | 0, f.s, f.s);
    }
    if (this.flash > 0) {
      ctx.fillStyle = ditherPattern(ctx, '#e8ecff', this.flash > 0.1 ? 9 : 4); ctx.fillRect(0, 0, W, H);
    }
  }
}
