// Drive archify's own in-viewer PNG export (Export -> Image -> PNG) so the
// committed README image is the clean diagram, without the viewer toolbar that
// visual-check screenshots necessarily include.
//
// Theme: the viewer resolves light/dark from prefers-color-scheme, which is
// light in a default headless context. We emulate the scheme AND assert
// data-theme afterwards, so a silently-wrong theme fails instead of shipping.
//
// Usage: node export-png.mjs <input.html> <output.png> <dark|light>
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const [, , inputArg, outputArg, themeArg = 'dark'] = process.argv;
if (!inputArg || !outputArg) {
  console.error('usage: node export-png.mjs <input.html> <output.png> <dark|light>');
  process.exit(2);
}
const wanted = themeArg === 'light' ? 'light' : 'dark';
const input = path.resolve(inputArg);
const output = path.resolve(outputArg);

const browser = await chromium.launch({
  // ARCHIFY_CHROME is the same variable the archify CLI reads, so one export
  // covers both steps of the regeneration flow. Unset falls through to
  // Playwright's own browser resolution.
  executablePath: process.env.ARCHIFY_CHROME || undefined,
  args: process.env.ARCHIFY_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
});
const page = await browser.newPage({
  viewport: { width: 2048, height: 1320 },
  colorScheme: wanted,
});
await page.goto('file://' + input, { waitUntil: 'load' });
await page.waitForTimeout(1500);

const themeOf = () => page.evaluate(() => document.documentElement.dataset.theme);
if ((await themeOf()) !== wanted) {
  await page.click('#btn-theme');
  await page.waitForTimeout(800);
}
const resolved = await themeOf();
if (resolved !== wanted) {
  throw new Error(`theme is "${resolved}", wanted "${wanted}" — refusing to export`);
}

const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
await page.click('button[aria-controls="export-menu"]');
await page.waitForTimeout(400);
await page.click('#export-menu button[data-format="png"]');

const download = await downloadPromise;
const stream = await download.createReadStream();
const chunks = [];
for await (const c of stream) chunks.push(c);
const buf = Buffer.concat(chunks);
await writeFile(output, buf);

const width = buf.readUInt32BE(16);
const height = buf.readUInt32BE(20);
console.log(JSON.stringify({ ok: true, output, bytes: buf.length, theme: resolved, width, height }));
await browser.close();
