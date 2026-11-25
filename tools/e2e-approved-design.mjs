import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';

const design = resolve(process.env.RT_DESIGN_DIR || '.design-flow/requesttranslate-ui');
const approval = JSON.parse(readFileSync(join(design, 'approval.json'), 'utf8'));
const evidence = resolve(process.env.RT_STAGE02_EVIDENCE || join('test-results', 'approved-' + approval.sha256.slice(0, 8)));
const extension = resolve(process.argv[2] || '.');
const edge = process.env.RT_STAGE02_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sha256 = name => createHash('sha256').update(readFileSync(join(design, name))).digest('hex');
mkdirSync(evidence, {recursive: true});

const browser = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'rt-approved-')), {
  executablePath: edge,
  headless: true,
  locale: 'zh-CN',
  deviceScaleFactor: 1,
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  viewport: {width: 1440, height: 920}
});
const report = {
  approval,
  assets: Object.fromEntries(['flow.yaml', 'prototype.html', 'request-template-mapping.md', 'comments.json'].map(name => [name, sha256(name)])),
  screens: {}
};
let reply = 'success';
await browser.route('https://api.openai.com/v1/chat/completions', async route => {
  if (reply === 'error') return route.fulfill({status: 401, body: 'Fixture authentication failed: demo-credential'});
  if (reply === 'slow') await new Promise(resolveResponse => setTimeout(resolveResponse, 1100));
  await route.fulfill({json: {choices: [{message: {content: '请求模板支持长行横向滚动。'}}]}});
});

try {
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const origin = worker.url().replace(/\/[^/]+$/, '');
  const page = browser.pages()[0];
  const prototype = await browser.newPage();
  const errors = [];
  for (const current of [page, prototype]) {
    current.setDefaultTimeout(8000);
    current.on('pageerror', error => errors.push(error.message));
  }
  report.browser = await page.evaluate(() => ({userAgent: navigator.userAgent, dpr: devicePixelRatio, lang: navigator.language}));
  await page.goto(origin + '/options.html');
  const fixture = await page.evaluate(async () => {
    const {loadState} = await import(chrome.runtime.getURL('lib/store.js'));
    const state = await loadState();
    const openai = state.configs.find(config => config.id === 'builtin-openai');
    const deepseek = state.configs.find(config => config.id === 'builtin-deepseek');
    const ollama = state.configs.findIndex(config => config.id === 'builtin-ollama');
    state.configs.splice(5, 0, state.configs.splice(ollama, 1)[0]);
    openai.fallbacks = [{...deepseek, id: 'demo-deepseek', enabled: true}];
    state.configs.push({...openai, id: 'demo-dictionary', name: '自定义词典接口',
      request: 'GET https://dictionary.example/lookup?q={{text}}&target={{targetCode}}\nAccept: application/json',
      imageRequest: '', fallbacks: [], path: 'result.translation'});
    state.configs.push({...openai, id: 'demo-image', name: '自定义图片接口', imageRequest: '',
      fallbacks: [{request: '', imageRequest: state.configs[1].imageRequest, id: 'demo-image-backup', enabled: true}]});
    state.activeConfigId = openai.id;
    const ocr = state.ocr.providers.find(provider => provider.id === 'builtin-openai-vl');
    ocr.fallbacks = [{...state.ocr.providers[0], id: 'demo-ocr-backup', enabled: true}];
    // The approved fixture omits the real providers' notes. Production still renders them.
    state.ocr.activeId = ocr.id;
    state.vars = [{name: 'apiKey', value: 'demo-credential'}, {name: 'model', value: 'gpt-4o-mini\ndeepseek-chat'},
      {name: 'baseUrl', value: 'https://api.openai.com'}];
    state.settings.targetLang = 'ZH-HANS';
    return state;
  });

  const captureReference = async (id, width, height, theme) => {
    await prototype.setViewportSize({width, height});
    await prototype.goto(pathToFileURL(join(design, 'prototype.html')).href + '#' + id);
    await prototype.reload();
    const screen = prototype.locator('[data-screen="' + id + '"]');
    await screen.locator('.rt').evaluate((element, color) => { element.dataset.theme = color; }, theme);
    if (id.startsWith('P')) {
      await screen.locator('.preview-tools').evaluate(element => { element.hidden = true; });
    } else {
      // Exclude the demo-only test toggle and review shortcut from acceptance captures.
      await screen.locator('details:has([data-fail]), [data-id=review]').evaluateAll(nodes => nodes.forEach(node => { node.hidden = true; }));
    }
    await prototype.screenshot({path: join(evidence, 'prototype-' + id + '.png'), animations: 'disabled'});
    return screen;
  };

  const measure = async locator => {
    const first = locator.first();
    if (!await first.isVisible()) return null;
    return first.evaluate(element => {
      const {x, y, width, height} = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const names = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight', 'padding', 'gap',
        'borderRadius', 'borderColor', 'gridTemplateColumns', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin'];
      return {
        bounds: [x, y, width, height].map(value => Number(value.toFixed(2))),
        css: Object.fromEntries(names.map(name => [name, style[name]])),
        drawnHeight: height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        svg: element instanceof SVGElement ? [element.getAttribute('viewBox'), ...[...element.querySelectorAll('path')].map(path => path.getAttribute('d'))] : undefined
      };
    });
  };

  const componentPairs = {
    top: ['.top', '.top'],
    tabs: ['nav button:not([hidden]) .icon', 'nav button .icon'],
    bottom: ['.bottom-nav', '.bottom-nav'],
    sidebar: ['.sidebar, .settings-sidebar, .list-page', '.tabpanel.is-active > .list'],
    row: ['.cfg-row', '.tabpanel.is-active .cfg-row'],
    name: ['.config-overview input[data-name]', '.tabpanel.is-active .editor-name'],
    segment: ['.request-modes label span', '.tabpanel.is-active .request-modes label span'],
    input: ['.basic-fields input', '.tabpanel.is-active .basic-fields input'],
    search: ['.settings-search', '.tabpanel.is-active .settings-search'],
    category: ['.settings-entry', '.tabpanel.is-active .settings-entry'],
    card: ['.setting-row.card-wide', '.tabpanel.is-active .setting.card-wide'],
    file: ['.file-picker', '.tabpanel.is-active .file-picker'],
    switch: ['.ocr-switch input', '.tabpanel.is-active .ocr-switch input']
  };

  async function pair(id, screen, options) {
    const target = options?.popup || page;
    await target.screenshot({path: join(evidence, 'production-' + id + '.png'), animations: 'disabled'});
    const dimensions = await target.evaluate(() => ({width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth}));
    assert(dimensions.scrollWidth <= dimensions.width, id + ': production layout overflow');
    const elements = {};
    for (const [name, [reference, production]] of Object.entries(options?.components || componentPairs)) {
      const [from, to] = await Promise.all([measure(screen.locator(reference)), measure(target.locator(production))]);
      if (from || to) elements[name] = {reference: from, production: to};
    }
    report.screens[id] = {dimensions, theme: options.theme, elements};
    for (const name of ['bottom', 'tabs', 'top', 'search', 'gear', 'run', 'selector']) {
      if (!(name in elements)) continue;
      const {reference, production} = elements[name];
      assert(reference && production, id + ': missing ' + name);
      assert(Math.abs((reference.svg ? reference.drawnHeight : reference.bounds[3]) - (production.svg ? production.drawnHeight : production.bounds[3])) <= 2, id + ': height differs for ' + name);
      if (reference.svg) assert.deepEqual(production.svg, reference.svg, id + ': SVG differs for ' + name);
    }
  }

  const specs = [
    ['D14', 1440, 920, 'light', 'configs'], ['D10', 1024, 900, 'light', 'configs'], ['D07', 768, 950, 'dark', 'configs'],
    ['B01', 390, 844, 'light', 'configs'], ['B02', 390, 844, 'dark', 'configs'],
    ['O04', 1024, 920, 'light', 'ocr'], ['O01', 390, 844, 'light', 'ocr'], ['O02', 390, 844, 'dark', 'ocr'],
    ['O05', 1024, 920, 'dark', 'ocr'], ['O06', 390, 844, 'light', 'ocr'],
    ['V01', 1024, 820, 'dark', 'vars'], ['V02', 390, 844, 'light', 'vars'], ['V03', 390, 844, 'dark', 'vars'],
    ['S01', 1024, 820, 'light', 'settings'], ['S02', 390, 844, 'dark', 'settings'], ['S07', 390, 844, 'light', 'settings']
  ];

  for (const [id, width, height, theme, module] of specs) {
    const screen = await captureReference(id, width, height, theme);
    await page.setViewportSize({width, height});
    await worker.evaluate(({state, theme}) => {
      state.settings.theme = theme;
      return chrome.storage.local.set({state});
    }, {state: fixture, theme});
    await page.reload();
    await page.locator('#cfg-list .cfg-item').first().waitFor();
    if (module !== 'configs') await page.locator('[data-tab=' + module + ']').click();
    if (id === 'B02') await page.locator('#cfg-list [data-id=builtin-openai] .cfg-item').click();
    if (id === 'O02') await page.locator('#ocr-list [data-id=builtin-openai-vl] .cfg-item').click();
    if (id === 'O05' || id === 'O06') await page.locator('#o-disabled').check();
    if (id === 'O06') await page.locator('#imgcfg-list .cfg-item').first().click();
    if (id === 'V03') await page.locator('#vars-body .cfg-item').first().click();
    if (id === 'S07') await page.locator('#settings-categories [data-category=backup]').click();
    await pair(id, screen, {theme});
  }

  // Use the real controls and storage to verify a basic edit, fallbacks, locale-sensitive search and the dialog.
  await page.locator('[data-tab=configs]').click();
  await page.locator('#cfg-list [data-id=builtin-openai] .cfg-item').click();
  const main = page.locator('#req-blocks .req-block').first();
  const raw = main.locator('.rb-request');
  const original = await raw.inputValue();
  const model = main.locator('[data-request-field=model]');
  const initialModel = await model.inputValue();
  await model.fill('approval-fixture-model');
  const updated = await raw.inputValue();
  assert.equal(updated, original.replace('"' + initialModel + '"', '"approval-fixture-model"'));
  await main.locator('[data-request-view][value=advanced]').check();
  assert.equal(await raw.inputValue(), updated);
  await raw.fill(updated.replace('"stream":', '"custom-option": true,\n  "stream":'));
  await page.waitForFunction(async () => (await chrome.storage.local.get('state')).state.configs
    .find(config => config.id === 'builtin-openai').request.includes('"custom-option"'));
  assert(await raw.isVisible());
  await page.setViewportSize({width: 1024, height: 880});
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await raw.inputValue(), updated.replace('"stream":', '"custom-option": true,\n  "stream":'));
  await page.locator('#btn-duplicate').click();
  await page.locator('#btn-delete').click();
  await page.locator('#confirm-action[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#confirm-action').waitFor({state: 'hidden'});
  assert.match(await page.locator('#f-name').inputValue(), /副本/);
  await page.locator('#btn-delete').click();
  await page.locator('#confirm-action [value=confirm]').click();
  await page.locator('[data-tab=settings]').click();
  await page.locator('#settings-search').fill('深色');
  await page.locator('#settings-results button').first().click();
  assert(await page.locator('.search-hit .segments input[value=dark]').isVisible());
  await page.locator('.set-group:visible [data-list-back]').click();
  assert.equal(await page.locator('#settings-search').inputValue(), '深色');

  const english = JSON.parse(readFileSync(resolve('i18n/en.json'), 'utf8'));
  await worker.evaluate(pack => chrome.storage.local.set({rt_i18n: pack}), english);
  await page.reload();
  await page.locator('#cfg-list .cfg-item').first().waitFor();
  await page.locator('[data-tab=settings]').click();
  assert.equal(await page.locator('#s-ui-lang').inputValue(), 'en');
  await page.locator('#settings-search').fill('Restore all default configs');
  await page.locator('#settings-results button').first().click();
  await page.locator('#btn-reset').click();
  assert.equal(await page.locator('#confirm-title').innerText(), 'Restore all default configs');
  await page.locator('#confirm-action [value=confirm]').click();
  await page.waitForFunction(async () => {
    const {state} = await chrome.storage.local.get('state');
    return !state || !state.configs.some(config => config.id.startsWith('demo-'));
  });
  await worker.evaluate(() => chrome.storage.local.remove('rt_i18n'));

  const popup = await browser.newPage();
  const popupPairs = {
    selector: ['.selects select', '#sel'], gear: ['.selects button.icon-btn', '#link-options'],
    source: ['.popup-source textarea', '#txt'], run: ['.popup-action button', '#btn-go'],
    copy: ['[data-action=copy-result]', '#btn-copy']
  };
  for (const [id, theme] of [['P01', 'light'], ['P02', 'light'], ['P03', 'light'], ['P04', 'dark']]) {
    const height = id === 'P01' ? 263 : 370;
    await popup.setViewportSize({width: 400, height});
    const screen = await captureReference(id, 400, height, theme);
    await worker.evaluate(({state, theme}) => {
      state.settings.theme = theme;
      return chrome.storage.local.set({state});
    }, {state: fixture, theme});
    reply = id === 'P04' ? 'error' : id === 'P02' ? 'slow' : 'success';
    await popup.goto(origin + '/popup.html');
    await popup.locator('#sel option').first().waitFor({state: 'attached'});
    if (id !== 'P01') {
      await popup.locator('#txt').fill('Request templates support horizontal scrolling.');
      await popup.locator('#btn-go').click();
      await popup.locator({P02: '#loading', P03: '#translation', P04: '#failure'}[id]).waitFor();
    }
    await pair(id, screen, {popup, theme, components: popupPairs});
  }
  assert.deepEqual(errors, []);
  console.log('Approved design evidence: ' + Object.keys(report.screens).length + ' paired viewports.');
} finally {
  writeFileSync(join(evidence, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
