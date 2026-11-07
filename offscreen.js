/**
 * offscreen 文档 —— **Chromium 专用**。
 *
 * service worker 里没有 DOM，读剪切板只能借一个有 DOM 的页面，就是这里。
 * 用完立刻被 background 关掉（创建一次几十毫秒，常驻不划算）。
 *
 * **真正的读取逻辑在 lib/clipboard-read.js** —— 火狐的 MV3 后台是事件页，
 * 本身就有 DOM，跑的是同一份（见 background.js 里的 readClipboardImage）。
 * 这个文件只剩「转个话」这件事。
 */
import { readClipboardImage, errText } from './lib/clipboard-read.js';

const TARGET = 'rt-offscreen';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== TARGET) return false;

  if (msg.type === 'read-image') {
    readClipboardImage(document)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, reason: 'unavailable', error: errText(err) }));
    return true; // 异步回复
  }
  return false;
});
