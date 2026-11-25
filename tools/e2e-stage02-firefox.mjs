import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {once} from 'node:events';

const firefox = process.env.RT_FF;
assert(firefox && process.argv[2], 'Set RT_FF and pass the built XPI path');
const profile = mkdtempSync(join(tmpdir(), 'rt-stage02-ff-'));
const uuid = '2660fd0c-c0bb-4236-947d-0bd8daed4f2c';
writeFileSync(join(profile, 'user.js'), `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({'requesttranslate@kniph.github.io': uuid}))});
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("remote.experimental.enabled", true);\n`);
const evidence = process.env.RT_STAGE02_EVIDENCE || 'test-results/stage-02-firefox';
mkdirSync(evidence, {recursive: true});
const child = spawn(firefox, ['-no-remote', '-profile', profile, '--remote-debugging-port', '0'], {
  windowsHide: true,
  // Scope extension-page navigation to this disposable, loopback-bound browser instance.
  env: {...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1'}
});
let socket;
try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error('Firefox did not start its BiDi session endpoint')), 15000);
    let output = '';
    const collect = chunk => {
      output += chunk;
      const match = output.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolveEndpoint(match[1]);
      }
    };
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Firefox exited ${code}: ${output}`)); });
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
  });

  socket = new WebSocket(endpoint + '/session');
  await once(socket, 'open');
  let messageId = 0;
  function send(method, params = {}) {
    const id = ++messageId;
    return new Promise((resolveCommand, reject) => {
      const handler = event => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener('message', handler);
        if (message.type === 'error') reject(new Error(`${method}: ${message.error} ${message.message}`));
        else resolveCommand(message.result);
      };
      const timer = setTimeout(() => {
        socket.removeEventListener('message', handler);
        reject(new Error('BiDi command timed out: ' + method));
      }, 15000);
      socket.addEventListener('message', handler);
      socket.send(JSON.stringify({id, method, params}));
    });
  }

  const {capabilities} = await send('session.new', {capabilities: {alwaysMatch: {}}});
  const {extension} = await send('webExtension.install', {extensionData: {type: 'path', path: resolve(process.argv[2])}});
  assert.equal(extension, 'requesttranslate@kniph.github.io');
  const {contexts} = await send('browsingContext.getTree', {maxDepth: 0});
  assert(contexts.length, 'Firefox did not expose its startup tab');
  const {context} = contexts[0];
  async function viewport(width, height) {
    await send('browsingContext.navigate', {context, url: 'data:text/html,<title>Resize test tab</title>', wait: 'complete'});
    await send('browsingContext.setViewport', {context, viewport: {width, height}, devicePixelRatio: 1});
  }
  const navigate = path => send('browsingContext.navigate', {context, url: `moz-extension://${uuid}/${path}`, wait: 'complete'});
  async function evaluate(expression) {
    const response = await send('script.evaluate', {expression, target: {context}, awaitPromise: true});
    assert.notEqual(response.type, 'exception', JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  const screenshot = async name => {
    const {data} = await send('browsingContext.captureScreenshot', {context, origin: 'viewport'});
    writeFileSync(resolve(evidence, name), Buffer.from(data, 'base64'));
  };
  await viewport(1024, 820);
  await navigate('options.html');
  await evaluate(`new Promise(resolve => {
    const timer = setInterval(() => {
      if (!document.querySelector('#cfg-list .cfg-item')) return;
      clearInterval(timer);
      resolve(true);
    }, 30);
  })`);
  assert.equal(await evaluate(`(() => {
    document.querySelector('[data-tab="settings"]').click();
    const query = document.querySelector('#settings-search');
    query.value = '深色';
    query.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#settings-results button').click();
    return document.querySelector('#s-theme').closest('.search-hit') !== null;
  })()`), true);
  assert.equal(await evaluate(`document.querySelector('#s-theme').hidden`), true);
  await screenshot('firefox-settings-segments.png');
  await evaluate(`document.querySelector('#s-theme + .segments input:checked').focus()`);
  await send('input.performActions', {context, actions: [{type: 'key', id: 'keyboard', actions: [
    {type: 'keyDown', value: '\uE015'}, {type: 'keyUp', value: '\uE015'}
  ]}]});
  assert.equal(await evaluate(`document.querySelector('#s-theme').value`), 'dark');

  await viewport(390, 844);
  await navigate('options.html');
  await evaluate(`new Promise(resolve => {
    const timer = setInterval(() => {
      if (!document.querySelector('.builtin-entries details')) return;
      clearInterval(timer);
      resolve(true);
    }, 30);
  })`);
  assert.equal(await evaluate(`(() => {
    document.querySelector('[data-tab="vars"]').click();
    return [...document.querySelectorAll('.builtin-entries details')].filter(item => item.open).length;
  })()`), 12);
  await screenshot('firefox-V02.png');

  await viewport(1024, 820);
  await navigate('options.html');
  const popup = JSON.parse(await evaluate(`(async () => {
    await browser.action.openPopup();
    for (let attempt = 0; attempt < 60; attempt++) {
      const view = browser.extension.getViews({type:'popup'})[0];
      if (view?.document.querySelector('#sel option')) {
        const doc = view.document;
        const rect = id => {
          const box = doc.querySelector(id).getBoundingClientRect();
          return {x:box.x, y:box.y, width:box.width, height:box.height, right:box.right};
        };
        doc.querySelector('#btn-go').click();
        return JSON.stringify({
          width:view.innerWidth, height:view.innerHeight, dpr:view.devicePixelRatio,
          scrollWidth:doc.documentElement.scrollWidth, empty:!doc.querySelector('#empty-input').hidden,
          appearance:view.getComputedStyle(doc.querySelector('#sel')).appearance,
          config:rect('#sel'), language:rect('#lang'), settings:rect('#link-options')
        });
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Native Firefox popup did not become ready');
  })()`));
  assert.equal(popup.width, 400);
  assert.equal(popup.scrollWidth, popup.width);
  assert.equal(popup.empty, true);
  assert(popup.config.right < popup.language.x && popup.language.right < popup.settings.x);
  assert.equal(popup.config.y, popup.settings.y);
  assert.equal(popup.settings.width, 34);
  writeFileSync(resolve(evidence, 'toolbar-firefox-regression.json'), JSON.stringify({version: capabilities.browserVersion, ...popup}, null, 2) + '\n');
  console.log(`Firefox ${capabilities.browserVersion}: installed the XPI and verified keyboard segments, mobile variables and the native 400 CSS px toolbar popup.`);

  await send('session.end');
} finally {
  socket?.close();
  child.kill();
}
