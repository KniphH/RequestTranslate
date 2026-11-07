/**
 * 从剪切板读一张图 —— **offscreen 文档和火狐的事件页共用这一份**。
 *
 * 为什么要有这个文件：Chromium 的 MV3 后台是 service worker，**没有 DOM**，
 * 读剪切板只能借一个 offscreen 文档当「有 DOM 的地方」；而火狐的 MV3 后台是
 * **事件页**（一个隐藏的 HTML 页面），本身就有 DOM，直接读就行。
 * 两边要跑的读取逻辑是同一套，抽在这里，offscreen.js 与 background.js 各调一次。
 *
 * 两条路都走一遍：先 navigator.clipboard.read()（类型信息最全），不行再退回
 * focus + execCommand('paste')。两者都要 manifest 里的 clipboardRead 权限。
 * 两条都不通就如实说「读不到剪切板」，别把「机制坏了」说成「里面没图片」。
 */
import { pickImageMime, isImageMime, toDataUrl } from './clipboard.js';

export function errText(err) {
  return String((err && err.message) || err || '未知错误');
}

/** 统一把 blob 变成结果对象 */
async function imageResult(blob, mime) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dataUrl = toDataUrl(bytes, mime || blob.type);
  return { ok: true, dataUrl, bytes: bytes.length, mime: dataUrl.slice(5, dataUrl.indexOf(';')) };
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

/**
 * 第二条路：focus 一个 contenteditable，execCommand('paste')，
 * 从 paste 事件里捞。要 manifest 里的 clipboardRead 权限。
 * `doc` 由调用方给 —— offscreen 文档传自己的，火狐事件页传自己的。
 */
function viaPasteEvent(doc) {
  return new Promise((resolve) => {
    const box = doc.createElement('div');
    box.setAttribute('contenteditable', 'true');
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    doc.body.appendChild(box);

    let settled = false;
    let timer = 0;

    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      doc.removeEventListener('paste', onPaste, true);
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

    doc.addEventListener('paste', onPaste, true);

    let ok = false;
    try {
      box.focus();
      ok = doc.execCommand('paste');
    } catch {
      ok = false;
    }
    // 返回 false = 这条机制本身不可用（十有八九是没给 clipboardRead 权限）
    if (!ok) setTimeout(() => done({ ok: false, reason: 'unavailable' }), 120);
  });
}

/**
 * 读一张图。
 * 返回 { ok:true, dataUrl, bytes, mime }
 *   或 { ok:false, reason:'no-image' | 'unavailable' }
 */
export async function readClipboardImage(doc) {
  const viaApi = await viaClipboardApi();
  if (viaApi !== undefined) return viaApi;
  return viaPasteEvent(doc);
}
