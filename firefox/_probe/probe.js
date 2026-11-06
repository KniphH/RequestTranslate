/**
 * 火狐 API 行为探测（RequestTranslate 移植的待验 #1）。
 *
 * 要回答的问题只有一个：**火狐的 chrome.* 到底返不返回 Promise**。
 * 这一个答案决定移植方案里那 23 处 `await chrome.*` 要不要全改，
 * 也决定 lib/ext.js 有没有必要存在。
 *
 * 顺带把几个相关的也一并测了：browser 命名空间在不在、offscreen 有没有、
 * 以及 manifest 里写 background.scripts（而不是 service_worker）能不能被接受 ——
 * 能加载起来本身就说明能。
 *
 * 用法见 firefox/README.md：about:debugging → 临时载入 → 选本目录的 manifest.json。
 */

const lines = [];
function log(k, v) {
  lines.push(k + "：" + v);
  console.log('[RT-PROBE]', k, '=', v);
}

const chromeLike = typeof chrome !== 'undefined' ? chrome : undefined;
const browserLike = typeof browser !== 'undefined' ? browser : undefined;

log('chrome 命名空间', typeof chromeLike);
log('browser 命名空间', typeof browserLike);
log('manifest 用的 background.scripts', '已被接受（否则本扩展不会运行）');

/* ══ 核心问题：chrome.* 返回的是不是 Promise ══ */
function probePromise(label, fn) {
  let r;
  try {
    r = fn();
  } catch (e) {
    log(label, '抛错：' + e.message);
    return;
  }
  const isPromise = !!(r && typeof r.then === 'function');
  log(label + ' 返回 Promise', isPromise ? '是 ✓' : '否 ✗（拿到：' + Object.prototype.toString.call(r) + '）');
  if (isPromise) {
    r.then(
      () => log(label + '  .then() 能跑通', '✓'),
      (e) => log(label + '  .then() 被拒', String(e).slice(0, 80))
    );
  }
}

probePromise('chrome.storage.local.get()', () => chromeLike.storage.local.get('__rt_probe'));
probePromise('chrome.tabs.query()', () => chromeLike.tabs.query({}));
probePromise('chrome.runtime.getPlatformInfo()', () => chromeLike.runtime.getPlatformInfo());

if (browserLike && browserLike.storage) {
  probePromise('browser.storage.local.get()', () => browserLike.storage.local.get('__rt_probe'));
}

/* ══ 其余兼容点 ══ */
log('chrome.offscreen 存在', typeof (chromeLike && chromeLike.offscreen));
log('browser.offscreen 存在', typeof (browserLike && browserLike.offscreen));
log('chrome.scripting.executeScript 存在', typeof (chromeLike && chromeLike.scripting && chromeLike.scripting.executeScript));
log('chrome.action 存在', typeof (chromeLike && chromeLike.action));
log('navigator.clipboard 存在', typeof navigator.clipboard);
log('navigator.userAgent', navigator.userAgent);

/* ══ 把结果开成一个标签页（临时载入的扩展没有 popup 可用）══ */
setTimeout(() => {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html =
    '<!doctype html><meta charset="utf-8">' +
    '<title>RT Firefox Probe</title>' +
    '<style>body{font:14px/1.7 ui-monospace,Consolas,monospace;padding:24px;background:#1b1b1f;color:#e6e6e6}' +
    'h2{margin:0 0 14px;font-size:17px}pre{white-space:pre-wrap;background:#26262c;padding:16px;border-radius:8px}' +
    '.ok{color:#7ee787}.bad{color:#ff7b72}</style>' +
    '<h2>RT Firefox Probe —— 结果</h2><pre>' +
    lines.map((s) => esc(s)).join('\n') +
    '</pre><p>把上面这块全部复制回给助手即可。</p>';
  chromeLike.tabs.create({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) }, () => {});
}, 1200);
