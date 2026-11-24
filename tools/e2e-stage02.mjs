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
const components = {};
let reply = 'success';
await context.route('https://api.openai.com/v1/chat/completions', async route => {
  if (reply === 'error') return route.fulfill({status: 401, body: 'Fixture authorization failed: fixture-secret'});
  if (reply === 'slow') await new Promise(done => setTimeout(done, 1800));
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
    const request = [
      'POST https://api.openai.com/v1/chat/completions', 'Content-Type: application/json', 'Authorization: Bearer {{apiKey}}', '',
      '{', '  "model": "gpt-4o-mini",', '  "messages": [', '    {"role": "system", "content": "仅输出{{target}}译文。"},',
      '    {"role": "user", "content": "{{text}}"}', '  ]', '}'
    ].join('\n');
    const fallback = {request, path: 'choices[0].message.content', responseMode: 'auto', enabled: true};
    const names = ['Bing (free)', 'bilibili (free)', 'OpenAI-compatible', 'DeepSeek', 'DeepL', 'Ollama (local)'];
    const hosts = ['api.openai.com', 'index-translate.bilibili.com', 'api.openai.com', 'api.deepseek.com', 'api-free.deepl.com', '127.0.0.1:11434'];
    state.configs = names.map((name, index) => ({
      ...fallback, request: request.replace('api.openai.com', hosts[index]), name, id: 'stage02-' + index,
      mainEnabled: true, adapter: index === 0 ? 'bing' : '',
      fallbacks: index === 2 ? [{...fallback, request: request.replace('api.openai.com', 'api.deepseek.com')}] : []
    }));
    state.activeConfigId = 'stage02-2';
    const ocr = state.ocr.providers.find(provider => provider.id === 'builtin-openai-vl');
    ocr.request = [
      ...request.split('\n').slice(0, 6),
      '  "messages": [{"role": "user", "content": [',
      '    {"type": "image_url", "image_url": {"url": "{{image}}"}},',
      '    {"type": "text", "text": "<image>\\nFree OCR."}', '  ]}]', '}'
    ].join('\n');
    ocr.path = '';
    ocr.note = '';
    ocr.fallbacks = [{...state.ocr.providers[0], id: 'stage02-ocr-fallback', enabled: true}];
    state.ocr.activeId = ocr.id;
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
  const captureReference = async (id, width, height, theme) => {
    await prototype.setViewportSize({width, height});
    await prototype.goto(pathToFileURL(join(design, 'prototype.html')).href + '#' + id);
    await prototype.reload();
    const screen = prototype.locator(`[data-screen="${id}"]`);
    await screen.locator('.rt').evaluate((element, color) => { element.dataset.theme = color; }, theme);
    if (id.startsWith('P')) await screen.locator('.preview-tools').evaluate(element => { element.hidden = true; });
    await prototype.screenshot({path: join(evidence, `prototype-${id}-${theme}.png`), animations: 'disabled'});
  };
  const rect = (page, selector) => page.locator(selector).first().evaluate(element => {
    const box = element.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height].map(value => Math.round(value));
  });
  const component = locator => locator.evaluate(element => {
    const {x, y, width, height} = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const properties = ['display', 'gridTemplateColumns', 'alignItems', 'columnGap', 'padding', 'borderRadius',
      'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'borderTopColor',
      'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'fill', 'opacity', 'transform'];
    return {
      rect: [x, y, width, height].map(number => Math.round(number * 100) / 100),
      style: Object.fromEntries(properties.map(key => [key, style[key]])),
      svg: element.tagName === 'svg' ? [element.getAttribute('viewBox'), element.querySelector('path')?.getAttribute('d')] : null
    };
  });
  const compare = async (id, name, reference, production, keys = [], crop = false) => {
    const pair = await Promise.all([component(reference), component(production)]);
    (components[id] ||= {})[name] = pair;
    if (pair[0].svg) {
      assert.deepEqual(pair[1].svg, pair[0].svg, `${id} ${name} SVG`);
      assert.deepEqual(pair[1].rect.slice(2), pair[0].rect.slice(2), `${id} ${name} SVG dimensions`);
    }
    for (const key of keys) assert.equal(pair[1].style[key], pair[0].style[key], `${id} ${name} ${key}`);
    if (crop) {
      await reference.screenshot({path: join(evidence, `component-${id}-${name}-prototype.png`), animations: 'disabled'});
      await production.screenshot({path: join(evidence, `component-${id}-${name}-production.png`), animations: 'disabled'});
    }
    return pair;
  };
  for (const [id, width, height, theme, module] of specs) {
    await page.setViewportSize({width, height});
    await page.evaluate(async state => chrome.storage.local.set({state}), {...fixture, settings: {...fixture.settings, theme}});
    await page.reload();
    await page.locator('#cfg-list .cfg-row').first().waitFor({state: 'attached'});
    await page.locator(`[data-tab="${module}"]`).click();
    if (id === 'B02' || id === 'O02') await page.locator('.tabpanel.is-active .cfg-item.is-active').click();
    await page.screenshot({path: join(evidence, `production-${id}-${theme}.png`)});
    await captureReference(id, width, height, theme);
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
    const screen = prototype.locator(art);
    const iconStyles = ['stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'fill'];
    const nativeFont = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight'];
    for (const [index, element] of (await page.locator('.top nav button').all()).entries()) {
      await compare(id, `nav-${index}`, screen.locator('.top nav button:visible svg').nth(index), element.locator('svg'), iconStyles);
    }
    await compare(id, 'brand', screen.locator('.mark svg').first(), page.locator('.mark svg'), iconStyles);
    await compare(id, 'theme', screen.locator('.top [data-id=theme] svg').first(), page.locator('#theme-toggle svg'), iconStyles);
    await compare(id, 'github', screen.locator('.top .github-link svg').first(), page.locator('.github-link svg'), iconStyles);
    if (['D14', 'B01', 'O04', 'V01', 'V02'].includes(id)) {
      const firstReference = screen.locator('.cfg-row').first();
      const firstProduction = page.locator('.tabpanel.is-active aside .cfg-row').first();
      await compare(id, 'list-row', firstReference, firstProduction, ['padding', 'borderRadius'], id === 'D14' || id === 'B01');
      const mobile = width < 640;
      await compare(id, 'order-icon', firstReference.locator(mobile ? '[data-grip] svg' : '.moves svg').first(),
        firstProduction.locator(mobile ? '.cfg-grip svg' : '.cfg-mv svg').first(), iconStyles);
    }
    if (id === 'D14' || id === 'D07' || id === 'B02') {
      const editor = page.locator('#editor');
      await compare(id, 'path', screen.locator('[data-id=response-path-0]').first(), editor.locator('.rb-path').first(), nativeFont);
      await compare(id, 'image-fold', screen.locator('[data-id=image-summary-0]').first(), editor.locator('.img-tpl summary').first(), ['columnGap', 'padding', 'fontSize', 'fontWeight'], id === 'D14');
      await compare(id, 'chips', screen.locator('.chips button').first(), editor.locator('.chips button').first(), ['fontFamily', 'fontSize', 'padding', 'borderRadius']);
      await compare(id, 'template', screen.locator('.code-box textarea').first(), editor.locator('.code-box textarea').first(), nativeFont, id === 'D14');
      const [field, action] = await Promise.all([rect(page, '#test-text'), rect(page, '#btn-test')]);
      assert.equal(field[1] + field[3], action[1] + action[3], `${id} input and send button align`);
      assert.equal(await editor.locator('.rb-tag').nth(1).textContent(), '后备 1');
    }
    if (id === 'S01' || id === 'S02') {
      const [reference, production] = await compare(id, 'search', screen.locator('.settings-search'), page.locator('.settings-search'), ['padding', 'borderRadius', 'columnGap'], true);
      assert.equal(production.rect[1], reference.rect[1], `${id} search top`);
      await compare(id, 'setting-category', screen.locator('.settings-entry').first(), page.locator('#settings-categories .settings-entry').first(), ['padding', 'fontSize', 'columnGap']);
      if (id === 'S01') {
        assert.equal(production.rect[1], (await rect(page, '.set-group:not([hidden]) h1'))[1], 'settings columns share the same top');
        await compare(id, 'setting-detail', screen.locator('[data-id=selection-trigger]').first(), page.locator('#s-trigger'), nativeFont);
      }
    }
    if (id === 'O04' || id === 'O02') {
      const [reference, production] = await compare(id, 'file-picker', screen.locator('.file-picker').first(), page.locator('#o-test-field .file-picker'), ['padding', 'borderRadius'], id === 'O04');
      assert.equal(production.rect[3], reference.rect[3], `${id} file picker height`);
      await compare(id, 'ocr-switch', screen.locator('[data-direct]').first(), page.locator('#o-disabled'));
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
  assert.equal((await rect(page, '#settings-search-clear'))[3], 26);
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

  await page.locator('#cfg-list .cfg-item.is-active').click();
  const hint = page.locator('[data-hint=cfg-test]');
  await hint.screenshot({path: join(evidence, 'component-B02-test-hint-shown-production.png')});
  await hint.getByRole('button').click();
  assert(await hint.isHidden());
  await page.waitForFunction(async () => (await chrome.storage.local.get('state')).state.settings.hiddenHints.includes('cfg-test'));
  await page.reload();
  await page.locator('#cfg-list .cfg-item.is-active').click();
  assert(await hint.isHidden());
  await page.locator('#editor .tests').screenshot({path: join(evidence, 'component-B02-test-hint-hidden-production.png')});
  await page.evaluate(async strings => chrome.storage.local.set({rt_i18n: {lang: 'en', strings}}),
    JSON.parse(readFileSync('i18n/en.json', 'utf8')).strings);
  await page.reload();
  await page.locator('#cfg-list .cfg-item.is-active').click();
  assert.equal(await page.locator('#req-blocks .rb-tag').nth(1).textContent(), 'Fallback 1');
  assert.equal(await page.evaluate(() => window.RTI18n.t('missing_stage02_key', ['2'], 'Fallback $1$')), 'Fallback 2');
  await page.evaluate(() => chrome.storage.local.remove('rt_i18n'));

  const popup = await context.newPage();
  // The context API owns the default viewport. Size this extension page to the toolbar popover.
  await popup.setViewportSize({width: 400, height: 300});
  const capturePopup = async (id, height, theme) => {
    await popup.setViewportSize({width: 400, height});
    await popup.screenshot({path: join(evidence, `production-${id}-${theme}.png`), animations: 'disabled'});
  };
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
  await capturePopup('P01', 300, 'light');
  await captureReference('P01', 400, 300, 'light');
  const referencePopup = prototype.locator('[data-screen=P01]');
  await compare('P01', 'translate', referencePopup.locator('.popup-action button'), popup.locator('#btn-go'), ['fontSize', 'fontWeight', 'padding', 'borderRadius'], true);
  await compare('P01', 'clear-icon', referencePopup.locator('.popup-source-head .icon'), popup.locator('#btn-clear .icon'), ['strokeWidth', 'opacity']);
  await compare('P01', 'source', referencePopup.locator('textarea'), popup.locator('#txt'), ['fontSize', 'padding', 'borderRadius']);
  await popup.locator('#btn-go').click();
  await popup.locator('#empty-input').waitFor();
  await capturePopup('P05', 330, 'light');
  await popup.locator('#txt').fill('Request templates support horizontal scrolling.');
  await popup.evaluate(async () => {
    const {state} = await chrome.storage.local.get('state');
    state.settings.theme = 'dark';
    await chrome.storage.local.set({state});
  });
  await popup.locator('html[data-theme="dark"]').waitFor({state: 'attached'});
  await popup.locator('#btn-go').click();
  await popup.locator('#out').getByText('请求模板支持长行横向滚动。').waitFor();
  await capturePopup('P03', 360, 'dark');
  await popup.locator('#btn-copy').click();
  await popup.locator('#status').filter({hasText: '已复制'}).waitFor();
  reply = 'error';
  await popup.locator('#btn-go').click();
  await popup.locator('#failure').waitFor();
  await capturePopup('P04', 400, 'dark');
  await popup.locator('#diagnostic summary').click();
  assert.match(await popup.locator('#diagnostic-text').textContent(), /401/);
  assert(!(await popup.locator('#diagnostic-text').textContent()).includes('fixture-secret'));
  reply = 'success';
  await popup.locator('#btn-retry').click();
  await popup.locator('#translation').waitFor();
  await popup.locator('#txt').fill('');
  assert(await popup.locator('#btn-clear').isEnabled());
  await popup.locator('#btn-clear').click();
  assert.equal(await popup.locator('#txt').inputValue(), '');
  assert(await popup.locator('#translation').isHidden());
  reply = 'slow';
  await popup.locator('#txt').fill('Request templates support horizontal scrolling.');
  await popup.locator('#btn-go').click();
  await popup.locator('#loading').waitFor();
  await capturePopup('P02', 340, 'dark');
  await popup.locator('#btn-clear').click();
  assert(await popup.locator('#btn-go').isEnabled());
  assert(await popup.locator('#loading').isHidden());
  for (const [id, height, theme] of [['P01', 300, 'light'], ['P02', 340, 'dark'], ['P03', 360, 'dark'], ['P04', 400, 'dark'], ['P05', 330, 'light']]) {
    await captureReference(id, 400, height, theme);
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, 'layout-measurements.json'), JSON.stringify(measurement, null, 2) + '\n');
  writeFileSync(join(evidence, 'component-measurements.json'), JSON.stringify(components, null, 2) + '\n');
  console.log('Stage 02: extension views, approved reference metrics, search, secret masking, and mocked Popup requests passed.');
} finally {
  await context.close();
}
