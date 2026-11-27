import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const secret = 'sk-fixture-secret-value-123456';
const server = http.createServer((req, res) => {
  if (req.url === '/translate') {
    res.writeHead(400, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: {message: 'Invalid credential: ' + secret}}));
  } else {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end('<p id="sample">Hello, world!</p>');
  }
});
await new Promise(resolveServer => server.listen(0, '127.0.0.1', resolveServer));
const extension = resolve(process.argv[2] || '.');
const edge = process.env.RT_STAGE02_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'rt-redaction-')), {
  executablePath: edge, headless: true, viewport: {width: 1024, height: 800},
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = worker.url().replace(/\/[^/]+$/, '');
  const options = await context.newPage();
  await options.goto(origin + '/options.html');
  await options.locator('#cfg-list .cfg-item').first().waitFor();
  await options.evaluate(async ({port, secret}) => {
    const {state} = await chrome.storage.local.get('state');
    state.configs = [{id: 'security-fixture', name: 'Security fixture', request: `curl http://127.0.0.1:${port}/translate -H "Authorization: Bearer {{apiKey}}"`, path: '', responseMode: 'json'}];
    state.activeConfigId = 'security-fixture';
    state.vars = [{name: 'apiKey', value: secret}];
    state.settings.slotConfigs = [];
    state.settings.panelSlots = 1;
    await chrome.storage.local.set({state});
  }, {port: server.address().port, secret});
  await options.reload();
  await options.locator('#btn-test').waitFor();
  await options.locator('#test-text').fill('hello');
  await options.locator('#btn-test').click();
  await options.waitForFunction(() => document.querySelector('#test-result')?.textContent.includes('400'));
  const testResult = await options.locator('#test-result').textContent();
  assert(!testResult.includes(secret), 'Options request diagnostics exposed a credential');
  assert(testResult.includes('已隐藏'), 'Options did not show a masked diagnostic');

  const popup = await context.newPage();
  await popup.goto(origin + '/popup.html');
  await popup.locator('#txt').fill('hello');
  await popup.locator('#btn-go').click();
  await popup.locator('#failure').waitFor({state: 'visible'});
  const popupResult = await popup.locator('#failure').textContent();
  assert(!popupResult.includes(secret), 'Popup error exposed a credential');

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('#request-translate-host', {state: 'attached'});
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#sample'));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const rect = range.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: rect.right - 1, clientY: rect.top + 4}));
  });
  await page.locator('.rt-trigger').waitFor({state: 'visible'});
  await page.locator('.rt-trigger').click({force: true});
  await page.locator('.rt-slot-b.err').waitFor({state: 'visible'});
  assert(!(await page.locator('.rt-panel').textContent()).includes(secret), 'Translation panel exposed a credential');
  await page.locator('.rt-more').click();
  assert(!(await page.locator('.rt-diag').textContent()).includes(secret), 'Panel diagnostics exposed a credential');
  console.log('Options, Popup and webpage panel masked a simulated echoed credential.');
} finally {
  await context.close();
  server.close();
}
