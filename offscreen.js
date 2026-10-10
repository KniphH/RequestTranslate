/**
 * offscreen 文档：把剪切板里的图片转成 data URL
 * service worker 里没有 navigator.clipboard，读剪切板只能在有 DOM 的
 * 地方做。这个页面就是那个「有 DOM 的地方」，只在需要的时候被创建，
 * 读完立刻被 background 关掉。
 *
 * Chromium 里 offscreen 文档**拿不到焦点**，所以 navigator.clipboard.read()
 * 通常会以 NotAllowedError 收场 —— 虽然它也能用（理论上），但不指望。
 * 稳的那条路是把一个 contenteditable 元素 focus() 起来，
 * execCommand('paste')，然后从 paste 事件的 clipboardData 里捞图片。
 * 需要 manifest 里的 clipboardRead 权限，否则 execCommand 直接返回 false。
 *
 * 两条路都走一遍：先 API（它给的类型信息最全），不行再退回去。
 * 两条都不通就如实说「读不到剪切板」，别把「机制坏了」说成「里面没图片」。
 */

import { pickImageMime, isImageMime, toDataUrl } from './lib/clipboard.js';

const TARGET = 'rt-offscreen';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== TARGET) return false;

  if (msg.type === 'read-image') {
    readClipboardImage()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, reason: 'unavailable', error: errText(err) }));
    return true; // 异步回复
  }
  return false;
});

function errText(err) {
  return String((err && err.message) || err || '未知错误');
}

/** 统一把 blob 变成结果对象 */
async function imageResult(blob, mime) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dataUrl = toDataUrl(bytes, mime || blob.type);
  return { ok: true, dataUrl, bytes: bytes.length, mime: dataUrl.slice(5, dataUrl.indexOf(';')) };
}

/**
 * 读一张图。
 * 返回 { ok:true, dataUrl, bytes, mime }
 *   或 { ok:false, reason:'no-image' | 'unavailable' }
 */
async function readClipboardImage() {
  const viaApi = await viaClipboardApi();
  if (viaApi !== undefined) return viaApi;
  return viaPasteEvent();
}

/**
 * 第一条路：navigator.clipboard.read()。
 * 返回 undefined = 这条路走不通（换下一条），其余就是最终结果。
 */
async function viaClipboardApi() {
  if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') return undefined;

  let items;
  try {
    items = await navigator.clipboard.read();
  } catch {
    return undefined; // 没焦点 / 没权限，正常
  }

  for (const item of Array.from(items || [])) {
    const mime = pickImageMime(item.types || []);
    if (!mime) continue;
    try {
      const blob = await item.getType(mime);
      return await imageResult(blob, mime);
    } catch (err) {
      return { ok: false, reason: 'unavailable', error: errText(err) };
    }
  }
  return { ok: false, reason: 'no-image' };
}

/** 从 DataTransfer 里挑出第一张图（保持剪贴板给的顺序） */
function pickImageFile(dt) {
  if (!dt) return null;
  for (const it of Array.from(dt.items || [])) {
    if (it.kind === 'file' && isImageMime(it.type)) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  for (const f of Array.from(dt.files || [])) {
    if (isImageMime(f.type)) return f;
  }
  return null;
}

/**
 * 第二条路：focus 一个 contenteditable，execCommand('paste')，
 * 从 paste 事件里捞。要 manifest 里的 clipboardRead 权限。
 */
function viaPasteEvent() {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.setAttribute('contenteditable', 'true');
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(box);

    let settled = false;
    let timer = 0;

    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener('paste', onPaste, true);
      box.remove();
      resolve(value);
    };

    const onPaste = (e) => {
      e.preventDefault();
      const file = pickImageFile(e.clipboardData);
      if (!file) {
        done({ ok: false, reason: 'no-image' });
        return;
      }
      imageResult(file, file.type)
        .then(done)
        .catch((err) => done({ ok: false, reason: 'unavailable', error: errText(err) }));
    };

    // 兜底超时：万一 execCommand 返回 true 但谁也没收到事件
    timer = setTimeout(() => done({ ok: false, reason: 'no-image' }), 1500);

    document.addEventListener('paste', onPaste, true);

    let ok = false;
    try {
      box.focus();
      ok = document.execCommand('paste');
    } catch {
      ok = false;
    }
    // 返回 false = 这条机制本身不可用（十有八九是没给 clipboardRead 权限）
    if (!ok) setTimeout(() => done({ ok: false, reason: 'unavailable' }), 120);
  });
}
