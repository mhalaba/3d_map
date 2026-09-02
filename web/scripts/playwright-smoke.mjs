import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/opt/cursor/artifacts';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('.brand', { timeout: 15000 });
const brand = await page.locator('.brand').innerText();
console.log('brand:', brand);

await page.screenshot({ path: path.join(OUT, '01-initial-load.png'), fullPage: true });

// Wait for Overpass load — status text
let status = '';
for (let i = 0; i < 40; i++) {
  status = await page.locator('.hud-line').innerText();
  console.log(`status[${i}]:`, status);
  if (/Załadowano\s+\d+/.test(status) || /LoD2/.test(status)) break;
  if (/Nie udało/.test(status) || /Błąd/.test(status)) {
    await page.getByRole('button', { name: /Odśwież OSM/i }).click();
  }
  await page.waitForTimeout(1500);
}

await page.screenshot({ path: path.join(OUT, '02-buildings-loaded.png'), fullPage: true });

// Start selection and drag rectangle on map canvas
await page.getByRole('button', { name: /Zaznacz obszar/i }).click();
const canvas = page.locator('canvas.maplibregl-canvas, .map-root canvas').first();
await canvas.waitFor({ state: 'visible' });
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas bbox');

const x1 = box.x + box.width * 0.42;
const y1 = box.y + box.height * 0.52;
const x2 = box.x + box.width * 0.58;
const y2 = box.y + box.height * 0.70;

await page.mouse.move(x1, y1);
await page.mouse.down();
await page.mouse.move(x2, y2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(800);

const exportVisible = await page.locator('.export-panel').isVisible();
console.log('export panel:', exportVisible);
if (exportVisible) {
  const exportText = await page.locator('.export-panel').innerText();
  console.log('export panel text:\n', exportText.slice(0, 400));
}

await page.screenshot({ path: path.join(OUT, '03-selection-export.png'), fullPage: true });

if (exportVisible) {
  const disabled = await page.getByRole('button', { name: /Pobierz STL/i }).isDisabled();
  console.log('export disabled:', disabled);
  if (!disabled) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      page.getByRole('button', { name: /Pobierz STL/i }).click(),
    ]);
    if (download) {
      const dest = path.join(OUT, await download.suggestedFilename());
      await download.saveAs(dest);
      console.log('downloaded:', dest, fs.statSync(dest).size, 'bytes');
    } else {
      const err = await page.locator('.hud-error').innerText().catch(() => '');
      console.log('no download; hud-error:', err);
    }
  }
}

await page.screenshot({ path: path.join(OUT, '04-after-export.png'), fullPage: true });

console.log('console errors:', consoleErrors.slice(0, 20));
await browser.close();
console.log('PLAYWRIGHT DONE');
