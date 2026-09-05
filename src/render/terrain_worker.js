// Re-lights the painting (and paints the sky gradient) off the main thread. The renderer posts an env snapshot and gets back
// the finished RGBA buffer; the scene keeps showing the previous terrain until it arrives, so a
// slow rebuild (a couple of seconds on a big painting) never stalls the page.
import { W, H } from '../state.js';
import { loadBackdrop } from '../assets.js';
import { renderTerrain } from './terrain.js';
import { renderSkyGradient } from './sky.js';

const assets = await loadBackdrop();
const img = { data: new Uint8ClampedArray(W * H * 4) };
self.onmessage = async (e) => {
  const { kind, key, env } = e.data;
  if (kind === 'sky') renderSkyGradient(img, env); else renderTerrain(img, env, assets);
  // hand back a bitmap: drawing it on the page is far cheaper than putImageData of a big buffer
  const bmp = await createImageBitmap(new ImageData(img.data, W, H));
  self.postMessage({ kind, key, bmp }, [bmp]);
};
self.postMessage({ ready: true });
