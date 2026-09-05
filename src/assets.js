import { W, H } from './state.js';
import { makeCanvas } from './util/pixel.js';

// The painted backdrop (from art/concept_art_01.jpg via tools/build_backdrop.py) and its mask.
// Mask channels: R = layer (0 sky, 1 peak, 2 range, 3 far hill, 4 flank, 5 trees, 6 near), G = material
// (0 none, 1 grass, 2 foliage, 3 rock, 4 snow, 5 dirt, 6 shrub, 7 painted prop), B = height within the layer (0..255).
export const LAYER = { SKY: 0, PEAK: 1, RANGE: 2, FARHILL: 3, FLANK: 4, TREES: 5, NEAR: 6 };
export const MAT = { NONE: 0, GRASS: 1, FOLIAGE: 2, ROCK: 3, SNOW: 4, DIRT: 5, SHRUB: 6, PROP: 7 };

// Works on the page and in a worker (no Image or document there).
async function loadPixels(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : makeCanvas(W, H)[0];
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, W, H).data;
}

export async function loadBackdrop() {
  const [rgb, mask] = await Promise.all([loadPixels(new URL('../assets/backdrop.png', import.meta.url)), loadPixels(new URL('../assets/backdrop_mask.png', import.meta.url))]);
  // first terrain row in each column (ignoring painted props like the pole), for fog over the crest
  const ridge = new Int16Array(W).fill(H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      if (mask[i] !== LAYER.SKY && mask[i + 1] !== MAT.PROP) { ridge[x] = y; break; }
    }
  }
  return { rgb, mask, ridge };
}
