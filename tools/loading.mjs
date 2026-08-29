import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  return match ? [match[1], match[2] ?? true] : [arg, true];
}));
const deadline = Number(args.timeout ?? 45000);
const browser = await chromium.launch({
  headless: true,
  ...(args.browser === 'chromium' ? {} : { channel: 'chrome' }),
  args: ['--mute-audio', ...(args.cold ? ['--disable-gpu-shader-disk-cache'] : []),
    ...(args.metal ? ['--use-angle=metal'] : [])],
});
const page = await browser.newPage({ viewport: { width: 3840, height: 1900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  let seed = 2468;
  Math.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
});
const errors = [];
const logs = [];
const requests = [];
const start = Date.now();
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  const log = { ms: Date.now() - start, type: message.type(), text: message.text() };
  logs.push(log);
  if (message.type() === 'error') errors.push(message.text());
  if (/\[engine\]|\[ai\]|\[boot\]/.test(log.text)) console.log(JSON.stringify(log));
});
page.on('request', (request) => requests.push(request.url()));
let report;
try {
  await page.goto(`http://127.0.0.1:${args.port ?? 4173}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#boot[data-state="ready"]').waitFor({ timeout: deadline });
  const readyMs = Date.now() - start;
  const ready = await page.evaluate(() => ({
    state: JSON.parse(window.render_game_to_text()),
    running: window.__ENGINE__._running,
    measures: performance.getEntriesByType('measure').map((measure) => ({ name: measure.name, ms: measure.duration })),
  }));
  assert.equal(ready.running, false, 'simulation must wait for the start click');
  assert.equal(ready.state.player.health, 100);
  if (args.screenshot) await page.screenshot({ path: `${args.screenshot}-ready.png` });
  await page.locator('#boot').click({ position: { x: 20, y: 20 } });
  await page.waitForFunction(() => window.__PLAYDROP_STARTED__ && window.__ENGINE__._running);
  await page.locator('#boot').waitFor({ state: 'hidden' });
  const playing = await page.evaluate(() => JSON.parse(window.render_game_to_text()));
  report = { ok: true, readyMs, ready, playing, errors, logs };
  assert.equal(playing.mode, 'playing');
  assert.equal(playing.weapon.name, 'M4A1');
  if (args.screenshot) await page.screenshot({ path: `${args.screenshot}-playing.png` });
  assert.deepEqual(errors, [], 'loading and starting must not emit browser errors');
  assert.equal(requests.filter((url) => /https?:\/\/[^/]*playdrop\.ai/.test(url)).length, 0);
} catch (error) {
  report = { ...report, ok: false, elapsedMs: Date.now() - start, error: error.message, errors, logs,
    status: await page.locator('#boot-status').textContent({ timeout: 1000 }).catch(() => null) };
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify(report, null, 2));
  if (args.output) await writeFile(String(args.output), JSON.stringify(report, null, 2));
  await browser.close();
}
