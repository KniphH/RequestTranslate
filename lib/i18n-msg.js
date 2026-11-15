/**
 * 给 ES module 用的文案查表（background.js / lib/*.js）。
 *
 * 为什么不直接用 lib/i18n.js：那个是普通脚本（IIFE 挂 window/globalThis），
 * 在 service worker 的 module 上下文里 import 不进来。而背景这边只需要「查一条」
 * 这一个能力，下载、校验、applyI18n 都不需要，所以不必把整套搬过来。
 *
 * 这里只读：打包内的走 chrome.i18n.getMessage（它会按 default_locale 回落 zh_CN），
 * 用户下载的包在 storage.rt_i18n 里。两者都不需要网络。
 *
 * 注意：这份逻辑和 lib/i18n.js 的 t() 是同一套优先级，改顺序时两处一起改
 * （test-lib 有一条断言钉住它们都在）。
 */

/** 已下载的语言包缓存（service worker 会被反复唤醒，别每次都读 storage） */
let cached = undefined;

async function getDownloaded() {
  if (cached !== undefined) return cached;
  try {
    const got = await chrome.storage.local.get("rt_i18n");
    const p = got && got.rt_i18n;
    cached = p && p.strings ? p.strings : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** storage 变了要失效缓存，否则用户换了语言、右键菜单还是旧的 */
export function invalidateI18nCache() {
  cached = undefined;
}

/**
 * 查一条文案。
 *
 * `params` 用于替换 `$1$` / `$2$` —— **和 lib/i18n.js 的 t() 同一套规则**（第十版指出这里以前不替换，
 * 带占位符的菜单文案会原样显示成「已链上 $1$ 条」）。
 *
 * @param {string} key
 * @param {string} fallback  查不到时用（通常是中文原文）
 * @param {string[]} [params]
 * @returns {Promise<string>}
 */
  export async function msg(key, fallback, params) {
  const pack = await getDownloaded();
  let out = null;
  if (pack && typeof pack[key] === "string") out = pack[key];
  if (out == null) {
      try {
        const got = chrome.i18n && chrome.i18n.getMessage(key, params);
        if (got) out = got;
      } catch { /* 忽略 */ }
  }
  if (out == null) out = fallback;
  /* chrome.i18n 自己会替换 params；下载包里的原文得我们自己替。
       两处都做一次是幂等的（已经替过的字符串里不再有 $N$）。 */
  if (params && params.length) {
      out = String(out).replace(/\$(\d+)\$?/g, (m, n) => {
        const v = params[Number(n) - 1];
        return v == null ? m : String(v);
      });
  }
  return out;
  }

/** 带 i18n key 的错误：code 给显示层翻译，text 留中文原文（测试与日志可读）。
 *  边界层（background / 设置页）用 localizeErr / localizeResult 按当前语言渲染。 */
export function i18nError(code, text, extra) {
  const e = new Error(text);
  e.code = code;
  if (extra != null) e.extra = extra;
  return e;
}
