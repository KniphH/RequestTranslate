/**
 * 界面文案查表。
 *
 * 这个文件现在只干两件事：**查一条**（t）和**把 DOM 里标了 key 的节点填上**（applyI18n）。
 * 语言包的下载 / 校验 / 切换那一整套已经整块删掉了（kniph 2026-11-12：
 * 「取消用 bing 自动翻译并自我升级的功能，你来翻译再放 GitHub 更好」）。
 *
 * 现在：语言包就是 _locales/ 里的静态文件，跟着包一起发。
 *   · 打包内的 zh_CN 是 base（default_locale = en，但中文文案最全）
 *   · _locales/en 是英文，chrome.i18n 按浏览器语言自动选
 * 没有网络请求，没有 storage 缓存，没有「下载中…」状态。
 *
 * 为什么还留这一层而不是直接用 chrome.i18n：
 *   content script 和设置页都要用，而 content script 不能 import；
 *   走一个挂在全局的薄壳，两边同一套调用。
 */
(function () {
  'use strict';

  /**
   * 查一条文案。
   *
   * @param {string} key   messages.json 里的键
   * @param {string[]} [params]  占位符，按 $1 $2 顺序填进 message 的 $N$ 位置
   * @returns {string} 永远返回字符串（最差是 key 本身，绝不返回 undefined）
   */
  function t(key, params) {
    if (!key) return "";
    try {
      const got = chrome.i18n && chrome.i18n.getMessage(key, params);
      if (got) return got;
    } catch {
      /* 极端情况下拿不到 chrome.i18n，别让整段渲染挂掉 */
    }
    return key;
  }

  /* ---- 带内联标签的文案（data-i18n-html）----
   *
   * 提示句里嵌着 <b> / <code>（「只列<b>填了图片模板</b>的配置」），按纯文本抽会把句子切碎，
   * 翻译出来就是中英混排。所以整句一条 key，用 innerHTML 填。
   *
   * 但 innerHTML 是注入面 —— 只放行白名单标签，属性全部丢弃。
   * 现在的文案全是我们自己写进 _locales 的，理论上安全；但白名单留着不亏，
   * 将来万一有人 PR 一条带 <script> 的文案，这里能挡住。
   */
  const HTML_TAGS = ["b", "strong", "code", "br", "i", "em"];

  /** 把一段字符串清洗成「只含白名单标签、无任何属性」的 HTML */
  function sanitizeInlineHtml(text) {
    return String(text == null ? "" : text).replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, function (tag, name) {
      const lower = String(name).toLowerCase();
      if (HTML_TAGS.indexOf(lower) === -1) {
        return tag.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
      return tag.charAt(1) === "/" ? "</" + lower + ">" : "<" + lower + ">";
    });
  }

  /** 填所有 data-i18n-html 的节点（整句带内联标签） */
  function applyI18nHtml(root) {
    const scope = root || document;
    for (const el of scope.querySelectorAll("[data-i18n-html]")) {
      const html = t(el.dataset.i18nHtml);
      // 查不到就保留原文（t 返回 key 本身时说明没这条，别把界面清空）
      if (html && html !== el.dataset.i18nHtml) {
        el.innerHTML = sanitizeInlineHtml(html);
      }
    }
  }

  /**
   * 把带 data-i18n 的节点填上文案。
   * `data-i18n` = 正文；`data-i18n-title` = title；`data-i18n-ph` = placeholder；
   * `data-i18n-html` = 带内联标签的整句（走 innerHTML + 白名单）。
   */
  function applyI18n(root) {
    const scope = root || document;
    applyI18nHtml(scope);
    for (const el of scope.querySelectorAll("[data-i18n]")) {
      el.textContent = t(el.dataset.i18n);
    }
    for (const el of scope.querySelectorAll("[data-i18n-title]")) {
      el.title = t(el.dataset.i18nTitle);
    }
    for (const el of scope.querySelectorAll("[data-i18n-ph]")) {
      el.placeholder = t(el.dataset.i18nPh);
    }
  }

  const API = { t: t, applyI18n: applyI18n, applyI18nHtml: applyI18nHtml, sanitizeInlineHtml: sanitizeInlineHtml };

  /* 网页 / 设置页有 window；service worker 只有 globalThis */
  if (typeof window !== "undefined") window.RTI18n = API;
  globalThis.RTI18n = API;
})();
