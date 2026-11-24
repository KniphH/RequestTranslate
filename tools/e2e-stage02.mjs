import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';

const extension = resolve(process.argv[2] || '.');
const edge = process.env.RT_STAGE02_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
assert(existsSync(edge), 'Set RT_STAGE02_EDGE to the Edge executable');
const design = resolve('.design-flow/requesttranslate-ui');
const evidence = join(design, 'stage-02');
const baseline = JSON.parse(readFileSync(join(evidence, 'baseline.json'), 'utf8'));
for (const [name, hash] of Object.entries(baseline.sha256).filter(([name]) => name !== 'comments.json')) {
  assert.equal(createHash('sha256').update(readFileSync(join(design, name))).digest('hex'), hash, name);
}

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'rt-stage02-')), {
  executablePath: edge,
  headless: true,
  locale: 'zh-CN',
  deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: {width: 1024, height: 900}
});

const errors = [];
const measurement = {};
let reply = 'success';
await context.route('https://api.openai.com/v1/chat/completions', async route => {
  if (reply === 'error') return route.fulfill({status: 401, body: 'Fixture authorization failed'});
  if (reply === 'slow') await new Promise(done => setTimeout(done, 450));
  await route.fulfill({json: {choices: [{message: {content: '请求模板支持长行横向滚动。'}}]}});
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = new URL(worker.url()).origin === 'null' ? worker.url().split('/').slice(0, 3).join('/') : new URL(worker.url()).origin;
  const page = context.pages()[0];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.goto(origin + '/options.html');
  const fixture = await page.evaluate(async () => {
    const {loadState} = await import(chrome.runtime.getURL('lib/store.js'));
    const state = await loadState();
    const request = 'POST https://api.openai.com/v1/chat/completions\nContent-Type: application/json\nAuthorization: Bearer {{apiKey}}\n\n' + JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{role: 'system', content: '仅输出{{target}}译文。'}, {role: 'user', content: '{{text}}'}]
    }, null, 2);
    const fallback = {request, path: 'choices[0].message.content', responseMode: 'auto', enabled: true};
    const names = ['Bing (free)', 'bilibili (free)', 'OpenAI-compatible', 'DeepSeek', 'DeepL', 'Ollama (local)'];
    const hosts = ['api.openai.com', 'index-translate.bilibili.com', 'api.openai.com', 'api.deepseek.com', 'api-free.deepl.com', '127.0.0.1:11434'];
    state.configs = names.map((name, index) => ({
      ...fallback, request: request.replace('api.openai.com', hosts[index]), name, id: 'stage02-' + index,
      mainEnabled: true, adapter: index === 0 ? 'bing' : '',
      fallbacks: index === 2 ? [{...fallback, request: request.replace('api.openai.com', 'api.deepseek.com')}] : []
    }));
    state.activeConfigId = 'stage02-2';
    state.vars = [{name: 'apiKey', value: 'fixture-secret'}, {name: 'model', value: 'gpt-4o-mini\ndeepseek-chat'}, {name: 'baseUrl', value: 'https://api.openai.com'}];
    state.settings.theme = 'light';
    await chrome.storage.local.set({state});
    return state;
  });

  const specs = [
    ['D14', 1440, 920, 'light', 'configs'], ['D10', 1024, 900, 'light', 'configs'], ['D07', 768, 950, 'dark', 'configs'],
    ['B01', 390, 844, 'light', 'configs'], ['B02', 390, 844, 'dark', 'configs'],
    ['O04', 1024, 925, 'light', 'ocr'], ['O02', 390, 844, 'dark', 'ocr'],
    ['V01', 1024, 780, 'dark', 'vars'], ['V02', 390, 844, 'light', 'vars'],
    ['S01', 1024, 820, 'light', 'settings'], ['S02', 390, 844, 'dark', 'settings']
  ];
  const prototype = await context.newPage();
  const rect = (page, selector) => page.locator(selector).first().evaluate(element => {
    const box = element.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height].map(value => Math.round(value));
  });
  for (const [id, width, height, theme, module] of specs) {
    await page.setViewportSize({width, height});
    await page.evaluate(async state => chrome.storage.local.set({state}), {...fixture, settings: {...fixture.settings, theme}});
    await page.reload();
    await page.locator('#cfg-list .cfg-row').first().waitFor({state: 'attached'});
    await page.locator(`[data-tab="${module}"]`).click();
    if (id === 'B02' || id === 'O02') await page.locator('.tabpanel.is-active .cfg-item.is-active').click();
    await page.screenshot({path: join(evidence, `production-${id}-${theme}.png`)});
    await prototype.setViewportSize({width, height});
    await prototype.goto(pathToFileURL(join(design, 'prototype.html')).href + '#' + id);
    await prototype.reload();
    const art = `[data-screen="${id}"]`;
    const values = {top: [await rect(prototype, art + ' .top'), await rect(page, '.top')]};
    assert.deepEqual(values.top[0], values.top[1], id + ' header');
    if (width >= 768) {
      values.list = [await rect(prototype, art + ' aside'), await rect(page, '.tabpanel.is-active > aside')];
      assert.deepEqual(values.list[0].slice(0, 3), values.list[1].slice(0, 3), id + ' sidebar');
    }
    if (id === 'D10' || id === 'D14' || id === 'D07') {
      values.title = [await rect(prototype, art + ' .editor-title h1'), await rect(page, '#cfg-editor-title')];
      assert(Math.abs(values.title[0][0] - values.title[1][0]) <= 2, JSON.stringify(values.title));
    }
    measurement[id] = values;
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#settings-search').fill('深色');
  await page.locator('#settings-results button').first().click();
  await page.locator('.search-hit #s-theme').waitFor();
  await page.locator('.set-group:not([hidden]) [data-list-back]').click();
  assert.equal(await page.locator('#settings-search').inputValue(), '深色');
  await page.locator('#settings-search').fill('zzzz no setting');
  await page.locator('#settings-empty').waitFor();
  await page.locator('[data-tab="vars"]').click();
  assert.equal(await page.locator('.builtin-row').count(), 12);
  await page.locator('#vars-body .cfg-item').first().click();
  assert.equal(await page.locator('#var-value').inputValue(), '••••••');
  assert(!(await page.locator('#vars-body').innerText()).includes('fixture-secret'));
  await page.locator('#var-eye').click();
  assert.equal(await page.locator('#var-value').inputValue(), 'fixture-secret');

  await page.locator('[data-tab="ocr"]').click();
  await page.locator('#ocr-list .cfg-item.is-active').click();
  const file = page.locator('#ocr-test-img');
  await file.setInputFiles({name: 'stage-02-validation.png', mimeType: 'image/png', buffer: Buffer.from('fixture')});
  assert.equal(await page.locator('.editor:not([hidden]) [data-file-name]').textContent(), 'stage-02-validation.png');
  await page.locator('.editor:not([hidden]) [data-file-clear]').click();
  assert.equal(await file.evaluate(input => input.files.length), 0);

  await page.locator('[data-tab="configs"]').click();
  const touch = await context.newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 1});
  const grab = await page.locator('#cfg-list .cfg-grip').first().boundingBox();
  const drop = await page.locator('#cfg-list .cfg-row').nth(2).boundingBox();
  const start = {x: Math.round(grab.x + grab.width / 2), y: Math.round(grab.y + grab.height / 2)};
  const endY = Math.round(drop.y + drop.height - 6);
  await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [start]});
  for (let index = 1; index <= 8; index++) {
    await touch.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: start.x, y: Math.round(start.y + (endY - start.y) * index / 8)}]});
  }
  await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  assert.equal(await page.locator('#cfg-list .cfg-row').nth(2).getAttribute('data-id'), 'stage02-0');
  assert.equal(await page.locator('#cfg-list .cfg-item.is-active').count(), 1);
  assert(await page.locator('#cfg-list').isVisible());
  await touch.detach();

  const popup = await context.newPage();
  // The context API owns the default viewport. Size this extension page to the toolbar popover.
  await popup.setViewportSize({width: 400, height: 300});
  popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(origin + '/popup.html');
  await popup.locator('#sel option').first().waitFor({state: 'attached'});
  await popup.evaluate(async () => {
    const {state} = await chrome.storage.local.get('state');
    state.settings.theme = 'light';
    await chrome.storage.local.set({state});
  });
  await popup.locator('html[data-theme="light"]').waitFor({state: 'attached'});
  assert.equal(await popup.locator('#sel').evaluate(el => getComputedStyle(el).appearance), 'base-select');
  await popup.screenshot({path: join(evidence, 'production-P01-light.png')});
  await popup.locator('#btn-go').click();
  await popup.locator('#empty-input').waitFor();
  await popup.locator('#txt').fill('Request templates support horizontal scrolling.');
  await popup.evaluate(async () => {
    const {state} = await chrome.storage.local.get('state');
    state.settings.theme = 'dark';
    await chrome.storage.local.set({state});
  });
  await popup.locator('html[data-theme="dark"]').waitFor({state: 'attached'});
  await popup.locator('#btn-go').click();
  await popup.locator('#out').getByText('请求模板支持长行横向滚动。').waitFor();
  await popup.setViewportSize({width: 400, height: 360});
  await popup.screenshot({path: join(evidence, 'production-P03-dark.png')});
  reply = 'error';
  await popup.locator('#btn-go').click();
  await popup.locator('#failure').waitFor();
  await popup.setViewportSize({width: 400, height: 400});
  await popup.screenshot({path: join(evidence, 'production-P04-dark.png')});
  reply = 'success';
  await popup.locator('#btn-retry').click();
  await popup.locator('#translation').waitFor();
  await popup.locator('#btn-clear').click();
  assert.equal(await popup.locator('#txt').inputValue(), '');
  assert(await popup.locator('#translation').isHidden());
  reply = 'slow';
  await popup.locator('#txt').fill('Cancel this translation');
  await popup.locator('#btn-go').click();
  await popup.locator('#loading').waitFor();
  await popup.locator('#btn-clear').click();
  assert(await popup.locator('#btn-go').isEnabled());
  assert(await popup.locator('#loading').isHidden());
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, 'layout-measurements.json'), JSON.stringify(measurement, null, 2) + '\n');
  console.log('Stage 02: extension views, approved reference metrics, search, secret masking, and mocked Popup requests passed.');
} finally {
  await context.close();
}
