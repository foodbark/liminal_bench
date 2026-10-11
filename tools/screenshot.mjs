// Usage: npm run dev (in another shell), then: node tools/screenshot.mjs out.png ["js to run on page before the shot"] LIMINAL_URL overrides the page address.
// Needs: npm install && npx playwright install chromium
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const out = process.argv[2] || 'shot.png';
const setup = process.argv[3] || '';
const browser = await chromium.launch();
const meta = JSON.parse(readFileSync(new URL('../assets/backdrop.json', import.meta.url), 'utf8'));
const page = await browser.newPage({ viewport: { width: meta.w, height: meta.h } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(process.env.LIMINAL_URL || 'http://127.0.0.1:5173/', { waitUntil: 'load' });
await page.waitForTimeout(2500);
if (setup) await page.evaluate(setup);
// the loading screen holds until the weather is in and the scene is lit; wait for it, then let the override settle
await page.waitForFunction(() => window.__liminal && window.__liminal.state.loaded, null, { timeout: 60000 }).catch(() => errors.push('loading screen still up after 60s'));
await page.waitForTimeout(10000);
await page.screenshot({ path: out });
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
