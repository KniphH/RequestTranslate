/**
 * 界面文案的查表入口（i18n 第一阶段）。
 *
 * 为什么需要它：`chrome.i18n` 只能在**打包时**绑定语言（getMessage 连 locale 参数都没有，
 * 实测传第 3 个参数直接 TypeError），所以在设置页里换语言、或者从网上下载语言包，
 * 都塞不进 chrome.i18n。这里在外面套一层：先查「用户生成 / 下载的语言包」，
 * 查不到再回落 chrome.i18n（它会自己按 default_locale 回落 zh_CN）。
 *
 * 为什么是普通脚本：content script 不能 import（和 lib/panel-core.js 同一套理由）。
 * 挂 window.RTI18n。
 *
 * 【当前阶段】只有「面板 + 触发按钮」那一族文案走这里（key 前缀 panel_ / trigger_）。
 * 设置页仍是中文硬编码 —— 那一步单独做（362 条里它占最大一块）。
 */
(function () {
  'use strict';

  /* 从 storage 读出来的生成包。结构：
       { lang: "ja", strings: { panel_copy: "コピー", ... } }
     启动时异步加载，加载完成前 t() 直接走 chrome.i18n（回落中文，不会白屏）。 */
  let pack = null;

  /**
   * 查一条文案。
   *
   * @param {string} key   messages.json 里的键
   * @param {string[]} [params]  占位符，按 $1 $2 顺序填进 message 的 $N$ 位置
   * @returns {string} 永远返回字符串（最差是 key 本身，绝不返回 undefined ——
   *   否则调用处拼进 innerHTML 会变成 "undefined" 三个字显示在界面上）
   */
  function t(key, params, fallback = key) {
    if (!key) return "";
    if (pack && pack.strings && typeof pack.strings[key] === "string") {
      return substitute(pack.strings[key], params);
    }
    try {
      /* chrome.i18n.getMessage 第二个参数是「替换数组」，对应 message 里的 $1 $2。
         它认不出的 key 返回空串 —— 那比 key 本身更糟（界面上一片空白，没法排查），
         所以下面回落成 key。 */
      const got = chrome.i18n && chrome.i18n.getMessage(key, params);
      if (got) return got;
    } catch {
      /* content script 在某些极端情况下拿不到 chrome.i18n，别让整段渲染挂掉 */
    }
    return substitute(fallback, params);
  }

  /** 把 $1 $2 填进字符串。chrome.i18n 自己也做这件事，但生成包里存的是原文，得我们填 */
  /**
   * 把 $1$ / $2$ 填进字符串。
   *
   * **Chrome 的占位符写法是前后各一个 `$`**（`$1$`），不是 `$1` ——
   * 以前正则写 /\$(\d+)/g，只吃掉前一个 `$`，尾部的 `$` 留在文案里：
   * 英文包那里就会出现「已链上 3$ 条」（第八版 §2 指出）。
   * 现在两种写法都认：$1$ 和 $1 都能替换。
   */
  function substitute(text, params) {
    if (!params || !params.length) return text;
    return String(text).replace(/\$(\d+)\$?/g, (m, n) => {
      const v = params[Number(n) - 1];
      return v == null ? m : String(v);
    });
  }
  /**
   * 把带 data-i18n 的节点填上文案。
   *
   * `opts.onlyMissing` = true 时**只填还没填过的节点**（用 dataset.i18nDone 标记）。
   *
   * 为什么需要这个（第九版 §2 P2）：设置页启动时会调两次 —— 一次填 HTML 里的静态节点，
   * 一次在 renderXxx 之后补填新建节点。但第二次会把**运行时写过 textContent 的动态文本**
   * 也一起改回 i18n 的静态值（例如「OCR 配置」这个标题，切换模式时被 JS 改成别的，
   * 再一刷又变回来）。
   *
   * 加了标记之后：第一次全填并打标；第二次只看没打标的，动态写过的自然留在原样。
   */
  function applyI18n(root, opts) {
    var onlyMissing = !!(opts && opts.onlyMissing);
    const scope = root || document;
    /* 第二次（onlyMissing）也要跑 html 通道：renderXxx 之后新建的
       data-i18n-html 节点同样需要补填。以前整条跳过，靠生成时内联文案兜着，
       机制其实是死的；现在两条通道都支持「只补没打过标的」。 */
    applyI18nHtml(scope, opts);
    for (const el of scope.querySelectorAll("[data-i18n]")) {
      if (onlyMissing && el.dataset.i18nDone) continue;
      el.textContent = t(el.dataset.i18n);
      el.dataset.i18nDone = "1";
    }
    for (const el of scope.querySelectorAll("[data-i18n-title]")) {
      if (onlyMissing && el.dataset.i18nTitleDone) continue;
      el.title = t(el.dataset.i18nTitle);
      el.dataset.i18nTitleDone = "1";
    }
    for (const el of scope.querySelectorAll("[data-i18n-ph]")) {
      if (onlyMissing && el.dataset.i18nPhDone) continue;
      el.placeholder = t(el.dataset.i18nPh);
      el.dataset.i18nPhDone = "1";
    }
  }

  /* ---- 带内联标签的文案（data-i18n-html）----
   *
   * 为什么需要单独一条路：有些提示句里嵌着 <b> / <code>（「只列<b>填了图片模板</b>的配置」），
   * 按纯文本抽 key 会把句子切碎，翻译出来就是中英混排。所以整句一条 key，用 innerHTML 填。
   *
   * 但 innerHTML 是注入面 —— 语言包是**外部数据**。所以：
   *   1. 只放行白名单标签（b/strong/code/br/i/em），其余一律转义成文本
   *   2. 属性一个都不留（含 onclick、style、href）
   * 宁可丢格式，不留执行面。
   */
  const HTML_TAGS = ["b", "strong", "code", "br", "i", "em"];

  /** 把一段字符串清洗成「只含白名单标签、无任何属性」的 HTML */
  function sanitizeInlineHtml(text) {
    let out = String(text == null ? "" : text);
    // 先把所有标签挑出来，非白名单的整个转义
    out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, function (tag, name) {
      const lower = String(name).toLowerCase();
      if (HTML_TAGS.indexOf(lower) === -1) {
        return tag.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
      // 白名单标签：只保留标签名，属性全丢
      return tag.charAt(1) === "/" ? "</" + lower + ">" : "<" + lower + ">";
    });
    return out;
  }

  /** 填所有 data-i18n-html 的节点（整句带内联标签） */
  function applyI18nHtml(root, opts) {
    const scope = root || document;
    var onlyMissing = !!(opts && opts.onlyMissing);
    for (const el of scope.querySelectorAll("[data-i18n-html]")) {
      if (onlyMissing && el.dataset.i18nHtmlDone) continue;
      const html = t(el.dataset.i18nHtml);
      // 查不到就保留原文（t 返回 key 本身时说明没这条，别把界面清空）
      if (html && html !== el.dataset.i18nHtml) {
        el.innerHTML = sanitizeInlineHtml(html);
        el.dataset.i18nHtmlDone = "1";
      }
    }
  }

  /** 载入生成包（没有就保持 null）。失败静默 —— 拿不到语言包不是错误，回落中文即可 */
  /* 语言包**完全从仓库下载**（不进安装包，kniph 2026-11-15 明确要求）。
     这里只读「用户选中语言时下载并缓存」的那份；加载过程不发任何网络请求 ——
     更新由「点开下拉核对清单 / 重新选中语言」触发，不做隐式联网。 */
  async function loadPack() {
    try {
      const got = await chrome.storage.local.get("rt_i18n");
      const p = got && got.rt_i18n;
      if (p && p.strings && typeof p.strings === "object") {
        pack = p;
        return p;
      }
    } catch {
      /* 早于扩展上下文可用时（比如 content script 在 document_start 跑）会抛，忽略 */
    }
    return null;
  }

  /** 当前生效的生成包（没载入就是 null），调试用 */
  function currentPack() {
    return pack;
  }

  /* ---- 即时下载（不打包任何语言，用时才拉）----
   *
   * 为什么走 raw.githubusercontent 而不是 GitHub API：API 有 60 次/小时限流，
   * raw 是纯静态文件没这问题。备用 jsdelivr —— 国内有时比 raw 快，但实测不稳，
   * 所以两个都试，谁先成功用谁。
   *
   * 合规：语言包是 **JSON 数据**，不是可执行代码。Chrome/Edge 的「远程托管代码」
   * 政策原文明确「不包含数据，也不包含 JSON 或 CSS」，所以这样拉语言包不违规。
   */
  const REPO = "KniphH/RequestTranslate";
  const BRANCH = "main";
  /* 给测试用：把镜像指到本地假服务器（做法和 lib/adapters.js 的 setBingBase 一样，
     不然端到端测试就得真连 GitHub，CI 或断网时必挂） */
  let mirrors = [
    (p) => "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/" + p,
    (p) => "https://cdn.jsdelivr.net/gh/" + REPO + "@" + BRANCH + "/" + p
  ];
  function setBaseUrl(base) {
    mirrors = base ? [(p) => String(base).replace(/\/$/, "") + "/" + p] : mirrors;
  }

  /** 依次试镜像，返回第一个成功的结果。全失败抛最后一个错 */
  /** 单个响应的字节上限 —— 语言包实测 30 KB，512 KB 已极宽松 */
  const NET_MAX_BYTES = 512 * 1024;

  /** 边读边数，超了立刻停 —— 不能等 text() 读完再判（那时已经进内存了） */
  async function readCapped(res, max) {
    if (!res.body || typeof res.body.getReader !== "function") {
      const t = await res.text();
      if (t.length > max) throw new Error("响应体太大");
      return t;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) {
        try { reader.cancel(); } catch { /* 已经断了就算了 */ }
        throw new Error("响应体太大（超过 " + max + " 字节）");
      }
      chunks.push(value);
    }
    const all = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    return new TextDecoder().decode(all);
  }

  async function fetchAny(path, timeoutMs) {
    let lastErr = null;
    for (const build of mirrors) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs || 8000);
      try {
        const res = await fetch(build(path), { signal: ctl.signal, cache: "no-cache" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        /* 先看 Content-Length，再限流式读取 —— 不能先 text() 再判长度 */
        const len = Number(res.headers.get("content-length") || 0);
        if (len > NET_MAX_BYTES) throw new Error("响应体太大（" + len + " 字节）");
        const text = await readCapped(res, NET_MAX_BYTES);
        clearTimeout(t);
        return text;
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
      }
    }
    throw lastErr || new Error("全部镜像都失败");
  }

  /**
   * 探一个地址在不在（只发 HEAD，不下正文）。
   *
   * 为什么不直接 fetch 全文：核实 20 种语言时下全文就是 20 份文件，而用户可能只想看看
   * 有哪些。HEAD 只拿响应头，几十毫秒一个。有些 CDN 不支持 HEAD（回 405），退化成 GET。
   */
  async function probe(path, timeoutMs) {
    for (const build of mirrors) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs || 6000);
      try {
        const url = build(path);
        let res = await fetch(url, { method: "HEAD", signal: ctl.signal, cache: "no-store" });
        if (res.status === 405 || res.status === 501) {
          res = await fetch(url, { method: "GET", signal: ctl.signal, cache: "no-store" });
        }
        clearTimeout(t);
        if (res.ok) return true;
      } catch {
        clearTimeout(t);
      }
    }
    return false;
  }

  /**
   * 核实清单：把每条 file 都探一遍，只留下真的下得到的。
   *
   * 为什么不信 index.json 就够了：清单是手写的，写错一个文件名、或者某次只提交了清单
   * 没提交文件，用户就会看到一个点了必然失败的选项。所以列出来之前先验。
   * 并发探测（不是串行）：20 种串行 HEAD 要好几秒，并发几百毫秒就完了。
   * 探不到的**静默剔除**，不报错 —— 用户不需要知道仓库里有个文件名写错了。
   */
  async function verifyIndex(index) {
    const entries = Object.entries(index || {}).filter(
      ([code, meta]) =>
        // 跳过非语言条目（清单里可能有 $schema 这类说明字段）
        !code.startsWith("$") && meta && typeof meta === "object" && typeof meta.file === "string"
    );
    const checks = await Promise.all(
      entries.map(async (pair) => {
        const code = pair[0], meta = pair[1];
        try {
        /* 和 downloadPack 用同一种编码 —— 之前这里不编码、那里编码，
           文件名含特殊字符就会「探测通过、下载 404」。 */
        const ok = await probe("i18n/" + encodeURIComponent(meta.file));
          return ok ? { code: code, meta: meta } : null;
        } catch {
          return null;
        }
      })
    );
    return checks.filter(Boolean);
  }

  /** 清单：仓库 i18n/index.json，列出有哪些语言可以下 */
  async function fetchIndex() {
    const text = await fetchAny("i18n/index.json");
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("清单格式不对");
    return data;
  }

  /**
   * 校验一份语言包 —— **入库前就拦**。语言包是外部数据，渲染侧的白名单是第二道。
   * 四道上限不是洁癖：没有它们，一个 100 MB 的包能把 storage 撑爆。
   */
  const PACK_MAX_KEYS = 2000;
  const PACK_MAX_BYTES = 512 * 1024;
  const PACK_MAX_VALUE = 2000;
  /** 允许出现的内联标签 —— 与 sanitizeInlineHtml 的白名单必须一致 */
  const PACK_TAG_OK = /^<\/?(b|strong|code|br|i|em)>$/i;

  function validatePack(data) {
    if (!data || typeof data !== "object") return { ok: false, why: "不是对象" };
    const strings = data.strings || data;
    if (!strings || typeof strings !== "object") return { ok: false, why: "没有 strings" };
    const keys = Object.keys(strings);
    if (keys.length === 0) return { ok: false, why: "一条都没有" };
    if (keys.length > PACK_MAX_KEYS) return { ok: false, why: "条目太多" };
    let total = 0;
    for (const k of keys) {
      const v = strings[k];
      if (typeof v !== "string") return { ok: false, why: "key " + k + " 的值不是字符串" };
      if (v.length > PACK_MAX_VALUE) return { ok: false, why: "key " + k + " 太长" };
      total += k.length + v.length;
      if (total > PACK_MAX_BYTES) return { ok: false, why: "整包太大" };
      const tags = v.match(/<\/?[a-zA-Z][^>]*>/g) || [];
      for (const tag of tags) {
        if (!PACK_TAG_OK.test(tag)) return { ok: false, why: "key " + k + " 里有不允许的标签" };
      }
    }
    return { ok: true, count: keys.length, strings: strings };
  }
  /**
   * 下载并装上一种语言。成功返回 { ok, count }，失败返回 { ok:false, why }。
   *
   * `file` 来自清单里的 `meta.file` —— **和 verifyIndex 探的是同一个字段**。
   * 以前这里自己拼 `${lang}.json`，探测却用 meta.file；两者此刻恰好一致所以没暴露，
   * 但清单里一旦写 `"zh_CN": {file:"zh-CN.json"}` 就会「探测通过、下载 404」。
   *
   * 失败时**不动现有的包** —— 用户当前界面不能因为一次下载失败就变回中文。
   */
  async function downloadPack(lang, file) {
    try {
      const name = file || (lang + '.json');
      const text = await fetchAny("i18n/" + encodeURIComponent(name), 15000);
      const data = JSON.parse(text);
      const check = validatePack(data);
      if (!check.ok) return { ok: false, why: "校验没过：" + check.why };
      pack = { lang: lang, strings: check.strings, fetchedAt: Date.now() };
      try {
        await chrome.storage.local.set({ rt_i18n: pack });
      } catch { /* 存不下也能用，只是下次要重下 */ }
      return { ok: true, count: check.count };
    } catch (e) {
      return { ok: false, why: String((e && e.message) || e) };
    }
  }
  /** 清掉已下载的语言包，回落到打包内置的 zh_CN */
  async function clearPack() {
    pack = null;
    try { await chrome.storage.local.remove("rt_i18n"); } catch { /* 忽略 */ }
  }
  const API = {
    t: t,
    applyI18n: applyI18n,
    applyI18nHtml: applyI18nHtml,
    sanitizeInlineHtml: sanitizeInlineHtml,
    loadPack: loadPack,
    currentPack: currentPack,
    fetchIndex: fetchIndex,
    downloadPack: downloadPack,
    clearPack: clearPack,
    validatePack: validatePack,
    setBaseUrl: setBaseUrl,
    verifyIndex: verifyIndex,
    probe: probe
  };

  /* 挂在两个全局上：网页 / 设置页有 window；service worker（背景）没有 window，只有
     globalThis。右键菜单的标题要在背景里拼，所以那边也得拿得到。 */
  if (typeof window !== "undefined") window.RTI18n = API;
  globalThis.RTI18n = API;
})();
