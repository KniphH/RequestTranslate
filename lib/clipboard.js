/**
 * 剪切板里的图片 → data URL
 * 这里只放**不碰 DOM 也不碰 chrome** 的纯函数：识别类型、拼 data URL、
 * 字节转 base64。真正去读剪切板的是 offscreen.js（拿不到焦点就不给读），
 * 两边的边界就在这儿。
 *
 * 为什么要自己拼 data URL，而不是 FileReader.readAsDataURL：
 * Windows 上截图工具（Win + Shift + S）丢出来的剪贴板项，type 经常是空串，
 * FileReader 会照着 bolb.type 拼出 `data:;base64,...` —— 少一段 MIME，
 * 接口那边直接就拒了。所以类型优先级是：
 * 剪贴板给的 type → 按文件头猜 → 兜底 image/png。
 */

/** 读不到图片时给用户看的那句话（也用在测试里，别再手写一遍） */
export const NO_IMAGE_MESSAGE = '剪切板里没有图片';

/** 读剪切板这件事本身就走不通（没权限 / 没焦点），和「里面没图」是两回事 */
export const CLIPBOARD_UNAVAILABLE_MESSAGE = '读不到剪切板，浏览器没放开剪贴板权限？';

export function isImageMime(type) {
  return /^image\//i.test(String(type || ''));
}

/**
 * 从一串 MIME 里挑出第一个图片类型。
 * 剪切板可能同时塞了 image/png 和 text/html，顺序就是它给的顺序。
 */
export function pickImageMime(types) {
  for (const t of Array.from(types || [])) {
    if (isImageMime(t)) return String(t).toLowerCase();
  }
  return '';
}

/**
 * 没带 MIME 时按文件头猜一个。
 * 认不出来返回空串，交给调用方兜底 —— 别在这里瞎猜成 png。
 */
export function sniffImageMime(bytes) {
  const b = bytes || [];
  const at = (i) => Number(b[i]) || 0;

  if (b.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return 'image/png';
  }
  if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (b.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'image/gif';
  if (b.length >= 2 && at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp';
  // RIFF....WEBP
  if (b.length >= 12 && at(0) === 0x52 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
    return 'image/webp';
  }
  return '';
}

/**
 * Uint8Array → base64。
 * 分块走 String.fromCharCode：一张 4K 截图有几十万字节，
 * 一次性 apply 会把调用栈撑爆（实测 RangeError: Maximum call stack size exceeded）。
 */
export function bytesToBase64(bytes) {
  const b = bytes || new Uint8Array(0);
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < b.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/** 拼 data URL。mime 没给或不合法就按文件头猜，再猜不出来当 png */
export function toDataUrl(bytes, mime) {
  const given = String(mime || '').toLowerCase();
  const type = (isImageMime(given) ? given : '') || sniffImageMime(bytes) || 'image/png';
  return 'data:' + type + ';base64,' + bytesToBase64(bytes);
}
