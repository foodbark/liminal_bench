import { W, H } from './state.js';
import { makeCanvas } from './util/pixel.js';

// The painted backdrop (from art/concept_art_01.jpg via tools/build_backdrop.py) and its mask.
// Mask channels: R = layer (0 sky, 1 peak, 2 range, 3 far hill, 4 flank, 5 trees, 6 near), G = material
// (0 none, 1 grass, 2 foliage, 3 rock, 4 snow, 5 dirt, 6 shrub, 7 painted prop), B = height within the layer (0..255).
export const LAYER = { SKY: 0, PEAK: 1, RANGE: 2, FARHILL: 3, FLANK: 4, TREES: 5, NEAR: 6 };
export const MAT = { NONE: 0, GRASS: 1, FOLIAGE: 2, ROCK: 3, SNOW: 4, DIRT: 5, SHRUB: 6, PROP: 7 };

async function loadPixels(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const [, g] = makeCanvas(W, H);
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, W, H).data;
}

export async function loadBackdrop() {
  const [rgb, mask] = await Promise.all([loadPixels('assets/backdrop.png'), loadPixels('assets/backdrop_mask.png')]);
  return { rgb, mask };
}
