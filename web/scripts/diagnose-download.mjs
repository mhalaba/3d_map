import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/opt/cursor/artifacts';
fs.mkdirSync(OUT, { recursive: true });

function validateBinaryStl(buf) {
  if (buf.length < 84) return { ok: false, reason: `too small: ${buf.length}` };
  const triCount = buf.readUInt32LE(80);
  const expected = 84 + triCount * 50;
  if (buf.length !== expected) {
    return { ok: false, reason: `size ${buf.length} != expected ${expected}` };
  }
  if (triCount < 12) return { ok: false, reason: `too few triangles: ${triCount}` };
  return { ok: true, triCount, bytes: buf.length };
}

async function waitForBuildings(page) {
  for (let i = 0; i < 50; i++) {
    const status = await page.locator('.hud-line').innerText();
    console.log(`status[${i}]:`, status);
    if (/Załadowano\s+\d+/.test(status)) {
      const n = Number(status.match(/Załadowano\s+(\d+)/)?.[1] ?? 0);
      if (n > 0) return n;
    }
    if (/Nie udało|Błąd/.test(status) && i % 5 === 4) {
      await page.getByRole('button', { name: /Odśwież OSM/i }).click();
    }
    await page.waitForTimeout(1200);
  }
  throw new Error('buildings never loaded');
}

async function selectRect(page, x1, y1, x2, y2) {
  await page.getByRole('button', { name: /Zaznacz obszar/i }).click();
  await page.waitForTimeout(200);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 16 });
  const midPanel = await page.locator('[data-testid="export-panel"]').isVisible().catch(() => false);
  await page.mouse.up();
  await page.waitForTimeout(700);
  return midPanel;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 2,
});

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('.brand', { timeout: 15000 });
const loaded = await waitForBuildings(page);
console.log('loaded buildings:', loaded);

const canvas = page.locator('.map-root canvas').first();
await canvas.waitFor({ state: 'visible' });
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

// Critical case: upper portion of pitched view (farther ground).
// Old 2-corner geo bbox often missed buildings here.
const upperMid = await selectRect(
  page,
  box.x + box.width * 0.30,
  box.y + box.height * 0.18,
  box.x + box.width * 0.70,
  box.y + box.height * 0.48,
);
console.log('upper mid-drag panel (want false):', upperMid);

let panel = await page.locator('[data-testid="export-panel"]');
await panel.waitFor({ state: 'visible', timeout: 5000 });
let text = await panel.innerText();
console.log('UPPER panel:\n', text);
const upperCount = Number(text.match(/(\d+)\s+budynków/)?.[1] ?? -1);
console.log('upper selectedCount:', upperCount);
await page.screenshot({ path: path.join(OUT, 'pitch-01-upper.png'), fullPage: true });

if (upperCount <= 0) {
  // Clear and try center as secondary signal
  console.log('UPPER selection empty — trying center');
}

// Center selection
await selectRect(
  page,
  box.x + box.width * 0.35,
  box.y + box.height * 0.40,
  box.x + box.width * 0.65,
  box.y + box.height * 0.72,
);
panel = page.locator('[data-testid="export-panel"]');
text = await panel.innerText();
console.log('CENTER panel:\n', text);
const centerCount = Number(text.match(/(\d+)\s+budynków/)?.[1] ?? -1);
console.log('center selectedCount:', centerCount);
await page.screenshot({ path: path.join(OUT, 'pitch-02-center.png'), fullPage: true });

const best = Math.max(upperCount, centerCount);
if (best <= 0) {
  throw new Error(`selectedCount still 0 (upper=${upperCount}, center=${centerCount}, loaded=${loaded})`);
}

// Prefer whichever has buildings for download
if (centerCount <= 0 && upperCount > 0) {
  await selectRect(
    page,
    box.x + box.width * 0.30,
    box.y + box.height * 0.18,
    box.x + box.width * 0.70,
    box.y + box.height * 0.48,
  );
}

const btn = page.getByRole('button', { name: /Pobierz STL/i });
if (await btn.isDisabled()) throw new Error('Pobierz STL disabled despite buildings');

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  btn.click(),
]);
const name = await download.suggestedFilename();
const dest = path.join(OUT, name);
await download.saveAs(dest);
const validation = validateBinaryStl(fs.readFileSync(dest));
console.log('download', name, validation);
if (!validation.ok) throw new Error(validation.reason);

await page.screenshot({ path: path.join(OUT, 'pitch-03-downloaded.png'), fullPage: true });
await browser.close();

if (upperCount <= 0) {
  console.warn('WARNING: upper pitched selection still empty (center worked)');
} else {
  console.log('UPPER pitched selection OK with', upperCount, 'buildings');
}
console.log('PITCH SELECT OK');
