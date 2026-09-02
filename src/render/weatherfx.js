import { W, H, HORIZON } from '../state.js';
import { fillCircle, ditherPattern, rgb, mulRGB, lerpRGB, scaleRGB, clamp, plotLine } from '../util/pixel.js';
import { mulberry32 } from '../util/noise.js';

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
    const target = Math.round(cover * 15 + (cover > 0.02 ? 1 : 0));
    while (this.clouds.length < target) this.clouds.push(this.makeCloud(true));
    while (this.clouds.length > target) this.clouds.pop();
    const sign = Math.sin(env.wind.dir * RAD) >= 0 ? 1 : -1;
    const speed = (1.5 + env.wind.speed * 0.4) * sign;
    for (const c of this.clouds) {
      c.x += speed * c.depth * dt;
      if (c.x > W + 260) c.x = -260; else if (c.x < -260) c.x = W + 260;
    }
    // precipitation
    const p = env.cond.precip;
    const windX = env.wind.speed * 3.5 * sign;
    if (p.type === 'rain') {
      const n = Math.floor(p.intensity * 420);
      while (this.drops.length < n) this.drops.push({ x: Math.random() * W, y: Math.random() * H, v: 380 + Math.random() * 260, len: 5 + Math.random() * 5 });
      this.drops.length = Math.min(this.drops.length, n);
      for (const d of this.drops) { d.y += d.v * dt; d.x += windX * dt; if (d.y > H) { d.y = -10; d.x = Math.random() * (W + 200) - 100; } }
    } else this.drops.length = 0;
    if (p.type === 'snow') {
      const n = Math.floor(p.intensity * 380);
      while (this.flakes.length < n) this.flakes.push({ x: Math.random() * W, y: Math.random() * H, v: 22 + Math.random() * 40, ph: Math.random() * 6.28, s: Math.random() > 0.7 ? 2 : 1 });
      this.flakes.length = Math.min(this.flakes.length, n);
      for (const f of this.flakes) {
        f.y += f.v * dt; f.x += (Math.sin(this.t * 1.3 + f.ph) * 14 + windX * 0.35) * dt;
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
    const depth = 0.5 + r() * 0.9;
    const w = Math.floor((60 + r() * 120) * depth);
    const puffs = [];
    const n = 3 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) puffs.push({ ox: Math.floor(w * (0.12 + 0.76 * (i / (n - 1 || 1))) + (r() - 0.5) * 10), r: Math.floor((8 + r() * 12) * depth) });
    return { x: anywhere ? r() * (W + 300) - 150 : -200, y: Math.floor(30 + r() * 170), w, puffs, depth };
  }

  cloudColors(env) {
    const { ambient, horizon, sunColor } = env.pal;
    const alt = env.sun.altitude;
    let lit = mulRGB([246, 247, 252], ambient);
    let shade = lerpRGB(mulRGB([146, 154, 178], ambient), horizon, 0.35);
    const sunset = clamp(1 - Math.abs(alt - 2) / 7, 0, 1) * (1 - env.cond.cover * 0.6);
    if (sunset > 0) { shade = lerpRGB(shade, scaleRGB(sunColor, 0.85), sunset * 0.7); lit = lerpRGB(lit, sunColor, sunset * 0.25); }
    if (env.cond.storm) { lit = scaleRGB(lit, 0.7); shade = scaleRGB(shade, 0.6); }
    return { lit: rgb(lit), shade: rgb(shade), deck: rgb(scaleRGB(shade, 0.9)) };
  }

  drawClouds(ctx, env) {
    const cover = env.cond.cover;
    if (cover <= 0.02) return;
    const { lit, shade, deck } = this.cloudColors(env);
    const sunSide = env.sun.azimuth < 180 ? -1 : 1;
    if (cover > 0.85) {
      const deckH = Math.floor(40 + (cover - 0.85) * 500);
      ctx.fillStyle = deck; ctx.fillRect(0, 0, W, deckH);
      for (let x = -20; x < W + 20; x += 34) fillCircle(ctx, x, deckH - 4 + ((x / 34) % 3 | 0) * 4, 24);
      ctx.fillStyle = ditherPattern(ctx, shade, 6);
      for (let x = -20; x < W + 20; x += 34) fillCircle(ctx, x + 10, deckH - 10, 22);
    }
    const sorted = [...this.clouds].sort((a, b) => a.depth - b.depth);
    for (const c of sorted) {
      const x = Math.round(c.x), y = c.y;
      ctx.fillStyle = shade;
      ctx.fillRect(x, y - 2, c.w, 6);
      for (const p of c.puffs) fillCircle(ctx, x + p.ox, y - 2, p.r);
      ctx.fillStyle = lit;
      ctx.fillRect(x + 1, y - 3, c.w - 2, 4);
      for (const p of c.puffs) fillCircle(ctx, x + p.ox + sunSide, y - 4, Math.max(1, p.r - 2));
      ctx.fillStyle = ditherPattern(ctx, lit, 7);
      ctx.fillRect(x + 2, y + 1, c.w - 4, 2);
    }
  }

  drawFog(ctx, env) {
    if (!env.cond.fog) return;
    const col = rgb(mulRGB([214, 219, 230], env.pal.ambient));
    const bands = [[-110, -70, 2], [-70, -40, 5], [-40, -10, 8], [-10, 30, 10], [30, 80, 7], [80, 140, 4], [140, 200, 2]];
    for (const [a, b, lv] of bands) { ctx.fillStyle = ditherPattern(ctx, col, lv); ctx.fillRect(0, HORIZON + a, W, b - a); }
  }

  drawPrecip(ctx, env) {
    const amb = env.pal.ambient;
    if (this.drops.length) {
      ctx.fillStyle = rgb(lerpRGB(mulRGB([188, 198, 222], amb), [160, 170, 195], 0.3));
      const sign = Math.sin(env.wind.dir * RAD) >= 0 ? 1 : -1;
      const slant = env.wind.speed * 0.012 * sign;
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
