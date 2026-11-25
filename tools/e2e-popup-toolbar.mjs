import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright-core';

const extension = resolve(process.argv[2] || '.');
const browserPath = process.env.RT_POPUP_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const evidence = process.env.RT_POPUP_EVIDENCE;
const name = process.env.RT_POPUP_NAME || 'edge';
const scale = process.env.RT_POPUP_DPR;
const palette = process.env.RT_POPUP_COLOR || '';
let responseMode = 'success';
const longText = Array.from({length: 80}, (_, index) => `第 ${index + 1} 行译文`).join('\n');
const fixture = createServer((request, response) => {
  setTimeout(() => {
    if (responseMode === 'error') {
      response.writeHead(401, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({error: 'fixture authentication failure'}));
    } else {
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({translation: longText}));
    }
  }, 950);
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');

let browser;
try {
  browser = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'rt-toolbar-')), {
    executablePath: browserPath,
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      ...(scale ? [`--force-device-scale-factor=${scale}`] : [])
    ]
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const page = browser.pages()[0];
  const url = worker.url().replace(/[^/]+$/, 'options.html');
  await page.goto(url);
  const userAgent = await page.evaluate(() => navigator.userAgent);
  await page.locator('#cfg-list .cfg-item').first().waitFor();
  const port = fixture.address().port;
  await page.evaluate(async ({fixturePort, palette}) => {
    const {loadState, saveState} = await import(chrome.runtime.getURL('lib/store.js'));
    const state = await loadState();
    state.activeConfigId = 'toolbar-test';
    state.configs = [{
      id: state.activeConfigId,
      name: '一条非常长的翻译配置'.repeat(16),
      request: `GET http://127.0.0.1:${fixturePort}/translate`,
      path: 'translation',
      responseMode: 'json'
    }];
    state.settings.theme = 'light';
    if (palette) state.settings.themeColor = palette;
    await saveState(state);
  }, {fixturePort: port, palette});

  // openPopup creates the same native toolbar surface as clicking the extension icon.
  const cdp = await browser.newCDPSession(page);
  await cdp.send('Target.setDiscoverTargets', {discover: true, filter: [{}]});
  await page.bringToFront();
  await worker.evaluate(() => chrome.action.openPopup());
  const {targetInfos} = await cdp.send('Target.getTargets', {filter: [{}]});
  const target = targetInfos.find(info => info.type === 'page' && info.url === url.replace('options.html', 'popup.html'));
  assert(target, 'Native toolbar popup target was not created');
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
  let nextId = 0;
  const callbacks = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const data = JSON.parse(event.message);
    callbacks.get(data.id)?.(data);
  });
  async function send(method, params = {}) {
    const id = ++nextId;
    const result = new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), method === 'Page.captureScreenshot' ? 20000 : 8000);
      callbacks.set(id, data => {
        clearTimeout(timer);
        callbacks.delete(id);
        if (data.error) reject(new Error(data.error.message));
        else resolveResult(data.result);
      });
    });
    await cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})});
    return result;
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, userGesture: true});
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
    return result.result.value;
  }
  async function waitFor(selector, visible = true) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const ready = await evaluate('(() => { const node = document.querySelector(' + JSON.stringify(selector)
        + '); return Boolean(node && (' + !visible + ' || node.getClientRects().length)); })()');
      if (ready) return;
      await new Promise(resolveResult => setTimeout(resolveResult, 35));
    }
    throw new Error('Native toolbar popup did not reach ' + selector);
  }
  await waitFor('#sel option', false);
  if (palette) {
    const actual = await evaluate("document.documentElement.style.getPropertyValue('--m3-primary')");
    const expected = await evaluate('window.RTM3Palettes[' + JSON.stringify(palette) + '].light.primary');
    assert.equal(actual, expected, 'native popup must use the saved palette');
  }
  const measurements = {userAgent};
  async function checkLayout(state) {
    const geometry = await evaluate(`(() => {
      const rects = {};
      for (const selector of ['html','body','.popup-frame','.popup','.selects','.field','#sel','#lang','#txt','#btn-go','#link-options']) {
        const element = document.querySelector(selector);
        const {x,y,width,height,right} = element.getBoundingClientRect();
        rects[selector] = {x,y,width,height,right,scrollWidth:element.scrollWidth};
      }
      const out=document.querySelector('#out');
      return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,rects,theme:document.documentElement.dataset.theme,
        translationHeight:out.clientHeight,translationScroll:out.scrollHeight};
    })()`);
    assert.equal(geometry.width, 400, `${state}: container shrank`);
    if (scale) assert.equal(geometry.dpr, Number(scale));
    const r = geometry.rects;
    assert.equal(r.html.scrollWidth, geometry.width, `${state}: document overflows`);
    assert.equal(r.body.width, r['.popup-frame'].width);
    assert(r['#sel'].width > 190 && r['#lang'].width >= 90 && r['#sel'].right < r['#lang'].x);
    assert.equal(r['#sel'].y, r['#lang'].y);
    assert.equal(r['#lang'].y, r['#link-options'].y);
    assert(r['#lang'].right < r['#link-options'].x);
    assert.equal(r['#link-options'].width, 34);
    for (const selector of ['#lang','#txt','#btn-go','#link-options']) assert(r[selector].right < r['.popup'].right);
    if (state === 'success') assert(geometry.translationHeight <= 150 && geometry.translationScroll > geometry.translationHeight);
    measurements[state] = geometry;
    if (evidence && process.env.RT_POPUP_SKIP_SCREENSHOTS !== '1') {
      const shot = await send('Page.captureScreenshot', {format: 'png'});
      writeFileSync(join(evidence, `toolbar-${name}-${state}.png`), Buffer.from(shot.data, 'base64'));
    }
  }

  await checkLayout('idle');
  if (evidence) {
    writeFileSync(join(evidence, 'toolbar-' + name + '-geometry.json'), JSON.stringify(measurements, null, 2) + '\n');
  }
  if (process.env.RT_POPUP_GEOMETRY_ONLY === '1') {
    console.log(name + ': native toolbar geometry passed at DPR ' + measurements.idle.dpr);
  } else {
    const pickerEnhanced = await evaluate(`getComputedStyle(document.querySelector('#sel')).appearance === 'base-select'`);
    if (pickerEnhanced) {
      const selection = await evaluate(`(() => {
        const content=document.querySelector('#sel selectedcontent');
        return {overflow:getComputedStyle(content).textOverflow,clipped:content.scrollWidth>content.clientWidth};
      })()`);
      assert.deepEqual(selection, {overflow: 'ellipsis', clipped: true});
      await evaluate(`document.querySelector('#sel').showPicker()`);
      assert(await evaluate(`document.querySelector('#sel').matches(':open')`));
      await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
      await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
      assert.equal(await evaluate(`document.querySelector('#sel').matches(':open')`), false);
    }
    await evaluate(`document.querySelector('#btn-go').click()`);
    await waitFor('#empty-input:not([hidden])');
    await checkLayout('empty');
    await evaluate(`(() => {
      const field=document.querySelector('#txt');
      field.value='Toolbar translation test';
      field.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#btn-go').click();
    })()`);
    await waitFor('#loading:not([hidden])');
    await checkLayout('loading');
    await waitFor('#translation:not([hidden])');
    await checkLayout('success');
    await evaluate("document.querySelector('#success-diagnostic summary').click()");
    assert.equal(await evaluate("document.querySelector('#success-diagnostic').open"), true);
    assert.match(await evaluate("document.querySelector('#request-details').textContent"), /200/);
    await worker.evaluate(async () => {
      const {state} = await chrome.storage.local.get('state');
      state.settings.theme = 'dark';
      await chrome.storage.local.set({state});
    });
    responseMode = 'error';
    await evaluate(`document.querySelector('#btn-go').click()`);
    await waitFor('#failure:not([hidden])');
    await checkLayout('error');
    assert.equal(measurements.error.theme, 'dark');
    responseMode = 'success';
    await evaluate(`document.querySelector('#btn-retry').click()`);
    await waitFor('#translation:not([hidden])');
    if (evidence) writeFileSync(join(evidence, `toolbar-${name}-regression.json`), JSON.stringify(measurements, null, 2) + '\n');
    console.log(`${name}: native toolbar popup passed at DPR ${measurements.idle.dpr}; enhanced picker ${pickerEnhanced ? 'verified' : 'unavailable'}.`);
  }
} finally {
  try { await browser?.close(); }
  finally { fixture.close(); }
}
