import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/opt/cursor/artifacts';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('.brand');

// Reproduce the bug: try to select BEFORE buildings finish loading.
const selectBtn = page.getByRole('button', { name: /Zaznacz obszar|Wczytywanie budynków/i });
await selectBtn.waitFor({ state: 'visible' });
const disabledEarly = await selectBtn.isDisabled();
console.log('select disabled before load (want true if still loading):', disabledEarly);

// Wait until enabled (= buildings loaded)
for (let i = 0; i < 60; i++) {
  const disabled = await selectBtn.isDisabled();
  const label = await selectBtn.innerText();
  const dbg = await page.evaluate(() => window.__mapmold ?? null);
  console.log(`wait[${i}] disabled=${disabled} label=${label} dbg=`, dbg);
  if (!disabled && /Zaznacz/.test(label)) break;
  if (/Nie udało|Błąd/.test(await page.locator('.hud-line').innerText())) {
    await page.getByRole('button', { name: /Odśwież OSM/i }).click();
  }
  await page.waitForTimeout(1000);
}

const dbgLoaded = await page.evaluate(() => window.__mapmold);
console.log('loaded dbg', dbgLoaded);
if (!dbgLoaded || dbgLoaded.buildings < 1) throw new Error('no buildings loaded');

await selectBtn.click();
const canvas = page.locator('.map-root canvas').first();
const box = await canvas.boundingBox();
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.25);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 18 });
await page.mouse.up();
await page.waitForTimeout(600);

const panel = page.locator('[data-testid="export-panel"]');
await panel.waitFor({ state: 'visible' });
const text = await panel.innerText();
const count = Number(text.match(/(\d+)\s+budynków/)?.[1] ?? -1);
const dbgAfter = await page.evaluate(() => window.__mapmold);
console.log('after select', { count, dbgAfter, text: text.slice(0, 200) });
await page.screenshot({ path: path.join(OUT, 'fix-empty-01.png'), fullPage: true });

if (count <= 0) throw new Error(`still 0 buildings. dbg=${JSON.stringify(dbgAfter)}`);

// Ensure late fetch cannot wipe count
await page.waitForTimeout(3000);
const count2 = Number((await panel.innerText()).match(/(\d+)\s+budynków/)?.[1] ?? -1);
console.log('after settle', count2);
if (count2 <= 0) throw new Error('wiped after settle');

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.getByRole('button', { name: /Pobierz STL/i }).click(),
]);
const dest = path.join(OUT, await download.suggestedFilename());
await download.saveAs(dest);
console.log('downloaded', dest, fs.statSync(dest).size);
await page.screenshot({ path: path.join(OUT, 'fix-empty-02.png'), fullPage: true });
await browser.close();
console.log('EMPTY-BUILDINGS FIX OK');
