import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { installLocalizationHost } from './localization-host.mjs';

const localeNames = ['en', 'fr', 'de', 'es', 'pt-BR', 'id', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const dictionaries = Object.fromEntries(localeNames.map(locale => [locale, JSON.parse(fs.readFileSync(new URL(`../src/i18n/${locale}.json`, import.meta.url)))]));
const keys = Object.keys(dictionaries.en).sort();
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
for (const [locale, messages] of Object.entries(dictionaries)) {
  assert.deepEqual(Object.keys(messages).sort(), keys, `${locale}: exact key parity`);
  for (const key of keys) {
    assert.equal(typeof messages[key], 'string');
    assert(messages[key].trim(), `${locale}.${key} empty`);
    assert.deepEqual(placeholders(messages[key]), placeholders(dictionaries.en[key]), `${locale}.${key}: placeholders`);
  }
}
console.log(`PASS: ${keys.length} keys and interpolation parameters across ${localeNames.length} locales`);
if (process.argv.includes('--dictionaries-only')) process.exit(0);
const url = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const out = new URL('../output/localization/runtime/', import.meta.url);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'] });
const results = [];
try {
 for (const locale of localeNames) {
  const mobile = ['de', 'id', 'ko', 'zh-Hant'].includes(locale);
  const context = await browser.newContext({ viewport: mobile ? { width: 852, height: 393 } : { width: 1280, height: 720 }, hasTouch: mobile, deviceScaleFactor: 1 });
  await installLocalizationHost(context, { locale });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}?playdrop_channel=prod`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#boot')?.dataset.state === 'ready', null, { timeout: 90000 });
  assert.equal(await page.locator('html').getAttribute('lang'), locale);
  assert.equal(await page.title(), dictionaries[locale].title);
  assert.equal(await page.locator('#boot-title').textContent(), dictionaries[locale].title);
  assert(await page.locator('#boot-title').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${locale}: title fits`);
  await page.screenshot({ path: new URL(`${locale}-start.png`, out).pathname });
  if (mobile) await page.locator('#boot').tap({ position: { x: 25, y: 25 } });
  else await page.locator('#boot').click({ position: { x: 25, y: 25 } });
  await page.waitForFunction(() => window.__PLAYDROP_STARTED__ && document.querySelector('#boot').hidden);
  assert.equal(await page.evaluate(() => JSON.parse(window.render_game_to_text()).locale), locale);
  assert.equal(await page.locator('.ow-vt-lbl').first().textContent(), dictionaries[locale].health);
  assert.equal(await page.locator('.ow-match > div').first().textContent(), dictionaries[locale].wave.replace('{number}', '1'));
  const before = await page.evaluate(() => ({ position: window.__ENGINE__.camera.position.toArray(), ammo: window.__ENGINE__.ctx.get('weapons').getHudState().ammo }));
  if (mobile) {
    await page.locator('[data-weapon="pistol"]').tap();
    await page.waitForFunction(() => window.__ENGINE__.ctx.get('weapons').activeId === 'pistol');
    await page.locator('.ow-touch-ads').tap();
    await page.waitForFunction(() => window.__ENGINE__.input.touch.held('ads'));
  } else {
    await page.keyboard.down('w');
    await page.waitForTimeout(350);
    await page.keyboard.up('w');
    await page.mouse.down();
    await page.waitForTimeout(220);
    await page.mouse.up();
    const after = await page.evaluate(() => ({ position: window.__ENGINE__.camera.position.toArray(), ammo: window.__ENGINE__.ctx.get('weapons').getHudState().ammo }));
    assert(Math.hypot(...after.position.map((v, i) => v - before.position[i])) > 0.2, `${locale}: moves`);
    assert(after.ammo < before.ammo, `${locale}: fires`);
  }
  await page.screenshot({ path: new URL(`${locale}-play.png`, out).pathname });
  if (mobile) await page.locator('.ow-touch-pause').tap();
  else await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__ENGINE__.ctx.get('ui').menu.open);
  assert.equal(await page.locator('.ow-menu h1').textContent(), dictionaries[locale].paused);
  await page.screenshot({ path: new URL(`${locale}-pause.png`, out).pathname });
  await page.locator('.ow-menu .ow-btn').click();
  await page.waitForFunction(() => !window.__ENGINE__.ctx.get('ui').menu.open);
  // Exercise rare result/feedback presentations directly, independently from
  // normal-input smoke above. This is UI coverage, not a claim of winning combat.
  await page.evaluate(() => {
    const ui = window.__ENGINE__.ctx.get('ui');
    window.__ENGINE__.events.emit('damage:dealt', { target: {}, killed: true, headshot: true, amount: 100 });
  });
  assert.equal(await page.locator('.ow-banner-t').textContent(), dictionaries[locale].eliminated.toUpperCase());
  for (const won of [false, true]) {
    await page.evaluate(won => { const ui = window.__ENGINE__.ctx.get('ui'); ui._hideResult(); ui._showResult({ won, number: 7 }); }, won);
    await page.waitForFunction(() => !window.__ENGINE__.ctx.get('ui').resultButton.disabled);
    assert.equal(await page.locator('.ow-death-title').textContent(), dictionaries[locale][won ? 'areaSecured' : 'killedInAction']);
    await page.screenshot({ path: new URL(`${locale}-${won ? 'win' : 'loss'}.png`, out).pathname });
    const bounds = await page.locator('.ow-death-inner').evaluate(el => ({ w: el.scrollWidth, max: innerWidth, h: el.scrollHeight, maxH: innerHeight }));
    assert(bounds.w <= bounds.max && bounds.h <= bounds.maxH, `${locale}: result fits screen`);
  }
  if (mobile) {
    await page.setViewportSize({ width: 393, height: 852 });
    assert.equal(await page.locator('#rotate-overlay h2').textContent(), dictionaries[locale].rotate);
    await page.locator('#rotate-overlay').waitFor({ state: 'visible' });
    await page.screenshot({ path: new URL(`${locale}-rotate.png`, out).pathname });
  }
  assert.deepEqual(errors, [], `${locale}: browser errors`);
  results.push({ locale, mobile, checks: ['boot', 'host-locale', 'hud', mobile ? 'touch-weapon-aim' : 'keyboard-move-fire', 'pause-resume', 'kill-feedback', 'loss', 'win'] });
  console.log(`PASS: ${locale} ${mobile ? 'touch landscape' : 'desktop'}`);
  await context.close();
 }
 const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1280, height: 720 } });
 const page = await context.newPage();
 await page.goto(url, { waitUntil: 'domcontentloaded' });
 await page.waitForFunction(() => window.__READY__, null, { timeout: 90000 });
 assert.equal(await page.evaluate(() => JSON.parse(window.render_game_to_text()).locale), 'en', 'standalone is explicitly English regardless of browser');
 await context.close();
 console.log('PASS: standalone source English');
 // A standard mapped controller uses the same browser polling contract as
 // hardware. Inject only device readings, then exercise normal input actions.
 const padContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
 await installLocalizationHost(padContext, { locale: 'fr' });
 await padContext.addInitScript(() => {
   window.__PAD__ = { connected: true, index: 0, id: 'Xbox test controller', mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
   navigator.getGamepads = () => [window.__PAD__];
 });
 const padPage = await padContext.newPage();
 await padPage.goto(`${url}?playdrop_channel=prod`, { waitUntil: 'domcontentloaded' });
 await padPage.waitForFunction(() => document.querySelector('#boot')?.dataset.state === 'ready', null, { timeout: 90000 });
 await padPage.waitForFunction(() => document.querySelector('#boot-note').textContent.includes('A'));
 assert.equal(await padPage.locator('#boot-note').textContent(), dictionaries.fr.controllerStart.replace('{button}', 'A'));
 const pressPad = async index => {
   await padPage.evaluate(index => { window.__PAD__.buttons[index] = { pressed: true, value: 1 }; }, index);
   await padPage.waitForTimeout(150);
   await padPage.evaluate(index => { window.__PAD__.buttons[index] = { pressed: false, value: 0 }; }, index);
   await padPage.waitForTimeout(150);
 };
 await pressPad(0);
 await padPage.waitForFunction(() => document.querySelector('#boot').hidden);
 const padBefore = await padPage.evaluate(() => ({ pos: window.__ENGINE__.camera.position.toArray(), ammo: window.__ENGINE__.ctx.get('weapons').getHudState().ammo }));
 await padPage.evaluate(() => { window.__PAD__.axes[1] = -1; window.__PAD__.buttons[7] = { pressed: true, value: 1 }; });
 await padPage.waitForTimeout(500);
 await padPage.evaluate(() => { window.__PAD__.axes[1] = 0; window.__PAD__.buttons[7] = { pressed: false, value: 0 }; });
 const padAfter = await padPage.evaluate(() => ({ pos: window.__ENGINE__.camera.position.toArray(), ammo: window.__ENGINE__.ctx.get('weapons').getHudState().ammo }));
 assert(Math.hypot(...padAfter.pos.map((v, i) => v - padBefore.pos[i])) > 0.2, 'controller moves');
 assert(padAfter.ammo < padBefore.ammo, 'controller fires');
 await pressPad(9);
 await padPage.waitForFunction(() => window.__ENGINE__.ctx.get('ui').menu.open);
 assert.equal(await padPage.locator('.ow-menu .ow-btn').textContent(), `A · ${dictionaries.fr.resume}`);
 await pressPad(0);
 await padPage.waitForFunction(() => !window.__ENGINE__.ctx.get('ui').menu.open);
 for (const status of ['lost', 'won']) {
   await padPage.evaluate(status => window.__ENGINE__.ctx.get('waves').finish(status), status);
   await padPage.waitForFunction(() => !window.__ENGINE__.ctx.get('ui').resultButton.disabled);
   const waveBefore = await padPage.evaluate(() => window.__ENGINE__.ctx.get('waves').number);
   await pressPad(0);
   await padPage.waitForFunction(() => window.__ENGINE__.ctx.get('waves').status === 'playing');
   const state = await padPage.evaluate(() => JSON.parse(window.render_game_to_text()));
   assert.equal(state.wave.number, waveBefore + (status === 'won' ? 1 : 0));
   assert.equal(state.weapon.grenades, 2);
   assert.equal(state.player.dead, false);
 }
 await padContext.close();
 console.log('PASS: controller start/move/fire/pause/resume and result retry/next wave');
 fs.writeFileSync(new URL('results.json', out), JSON.stringify(results, null, 2));
} finally { await browser.close(); }
