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
    return { ok: false, reason: `size ${buf.length} != expected ${expected} for ${triCount} tris` };
  }
  if (triCount < 12) return { ok: false, reason: `too few triangles: ${triCount}` };
  for (let i = 0; i < Math.min(triCount, 20); i++) {
    const off = 84 + i * 50;
    for (let f = 0; f < 12; f++) {
      const v = buf.readFloatLE(off + f * 4);
      if (!Number.isFinite(v)) return { ok: false, reason: `non-finite float at tri ${i}` };
    }
  }
  return { ok: true, triCount, bytes: buf.length };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 2,
});

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('.brand', { timeout: 15000 });

let status = '';
for (let i = 0; i < 45; i++) {
  status = await page.locator('.hud-line').innerText();
  console.log(`status[${i}]:`, status);
  if (/Załadowano\s+\d+/.test(status)) break;
  if (/Nie udało|Błąd/.test(status)) {
    await page.getByRole('button', { name: /Odśwież OSM/i }).click();
  }
  await page.waitForTimeout(1200);
}

await page.getByRole('button', { name: /Zaznacz obszar/i }).click();

// Panel must NOT appear mid-drag
const canvas = page.locator('.map-root canvas').first();
await canvas.waitFor({ state: 'visible' });
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

const x1 = box.x + box.width * 0.35;
const y1 = box.y + box.height * 0.40;
const x2 = box.x + box.width * 0.65;
const y2 = box.y + box.height * 0.75;

await page.mouse.move(x1, y1);
await page.mouse.down();
await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 8 });
const midDragPanel = await page.locator('[data-testid="export-panel"]').isVisible().catch(() => false);
console.log('export panel visible mid-drag (should be false):', midDragPanel);
await page.mouse.move(x2, y2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(600);

const exportVisible = await page.locator('[data-testid="export-panel"]').isVisible();
console.log('export panel after mouseup:', exportVisible);
if (!exportVisible) throw new Error('export panel missing after selection');

const panelText = await page.locator('[data-testid="export-panel"]').innerText();
console.log('panel:\n', panelText);

const selectingStill = await page.getByRole('button', { name: /Anuluj zaznaczenie/i }).isVisible().catch(() => false);
console.log('still in selecting mode (should be false):', selectingStill);

const btn = page.getByRole('button', { name: /Pobierz STL/i });
const disabled = await btn.isDisabled();
const btnBox = await btn.boundingBox();
console.log('button disabled:', disabled, 'bbox:', btnBox);

if (btnBox) {
  const midX = btnBox.x + btnBox.width / 2;
  const midY = btnBox.y + btnBox.height / 2;
  const top = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      return {
        tag: el.tagName,
        className: el.className?.toString?.() ?? '',
        text: (el.innerText || '').slice(0, 60),
      };
    },
    { x: midX, y: midY },
  );
  console.log('elementFromPoint:', JSON.stringify(top));
  if (top?.tag !== 'BUTTON') {
    throw new Error(`button covered by ${top?.tag}.${top?.className}`);
  }
}

await page.screenshot({ path: path.join(OUT, 'fix-01-selection.png'), fullPage: true });

if (disabled) throw new Error('Pobierz STL disabled after valid selection');

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  btn.click(),
]);

const name = await download.suggestedFilename();
const dest = path.join(OUT, name);
await download.saveAs(dest);
const buf = fs.readFileSync(dest);
const validation = validateBinaryStl(buf);
console.log('downloaded:', name, buf.length, 'bytes');
console.log('stl validation:', validation);
if (!validation.ok) throw new Error(`bad stl: ${validation.reason}`);

const fallback = page.locator('a.download-fallback');
await fallback.waitFor({ state: 'visible', timeout: 5000 });
console.log('fallback link:', await fallback.innerText());

await page.screenshot({ path: path.join(OUT, 'fix-02-after-download.png'), fullPage: true });
console.log('console errors:', consoleErrors.slice(0, 20));
await browser.close();

if (midDragPanel) {
  throw new Error('export panel appeared mid-drag — click-stealing regression');
}
console.log('FIX VERIFY OK');
