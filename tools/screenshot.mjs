// Usage: npm run dev (in another shell), then: node tools/screenshot.mjs out.png ["js to run on page before the shot"]
// Needs: npm install && npx playwright install chromium
import { chromium } from 'playwright';
const out = process.argv[2] || 'shot.png';
const setup = process.argv[3] || '';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load' });
await page.waitForTimeout(1500);
if (setup) await page.evaluate(setup);
await page.waitForTimeout(1200);
await page.screenshot({ path: out });
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
