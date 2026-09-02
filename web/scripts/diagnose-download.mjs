import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/opt/cursor/artifacts';
fs.mkdirSync(OUT, { recursive: true });

function validateBinaryStl(buf) {
  if (buf.length < 84) return { ok: false, reason: `too small` };
  const triCount = buf.readUInt32LE(80);
  const expected = 84 + triCount * 50;
  if (buf.length !== expected) return { ok: false, reason: `size mismatch` };
  if (triCount < 12) return { ok: false, reason: `too few tris` };
  return { ok: true, triCount, bytes: buf.length };
}

async function waitForBuildings(page) {
  for (let i = 0; i < 50; i++) {
    const status = await page.locator('.hud-line').innerText();
    console.log(`status[${i}]:`, status);
    if (/Załadowano\s+(\d+)/.test(status)) {
      const n = Number(status.match(/Załadowano\s+(\d+)/)[1]);
      if (n > 0) return n;
    }
    if (/Nie udało|Błąd/.test(status) && i % 5 === 4) {
      await page.getByRole('button', { name: /Odśwież OSM/i }).click();
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('buildings never loaded');
}

function parseCount(text) {
  return Number(text.match(/(\d+)\s+budynków/)?.[1] ?? -1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 2,
});

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('.brand');
const loaded = await waitForBuildings(page);
console.log('loaded', loaded);

const canvas = page.locator('.map-root canvas').first();
const box = await canvas.boundingBox();

await page.getByRole('button', { name: /Zaznacz obszar/i }).click();
await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.22);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.55, { steps: 20 });
const mid = await page.locator('[data-testid="export-panel"]').isVisible().catch(() => false);
await page.mouse.up();
await page.waitForTimeout(500);

const panel = page.locator('[data-testid="export-panel"]');
await panel.waitFor({ state: 'visible' });
let text = await panel.innerText();
let count = parseCount(text);
console.log('immediate count', count, 'mid-drag panel', mid);
console.log(text.slice(0, 250));
await page.screenshot({ path: path.join(OUT, 'race-01-immediate.png'), fullPage: true });

if (count <= 0) throw new Error('selection empty immediately after commit');

// Wait long enough that a stale Overpass/moveend refresh WOULD have wiped selectedIds before.
await page.waitForTimeout(3500);
text = await panel.innerText();
const later = parseCount(text);
console.log('count after 3.5s settle', later);
await page.screenshot({ path: path.join(OUT, 'race-02-after-wait.png'), fullPage: true });

if (later <= 0) throw new Error('selection became empty after settle — refresh race regresses');
if (later !== count) console.warn('count changed after settle', count, '->', later);

const btn = page.getByRole('button', { name: /Pobierz STL/i });
if (await btn.isDisabled()) throw new Error('button disabled after settle');

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  btn.click(),
]);
const dest = path.join(OUT, await download.suggestedFilename());
await download.saveAs(dest);
const validation = validateBinaryStl(fs.readFileSync(dest));
console.log('stl', validation);
if (!validation.ok) throw new Error(validation.reason);

await page.screenshot({ path: path.join(OUT, 'race-03-downloaded.png'), fullPage: true });
await browser.close();
console.log('RACE FIX OK');
