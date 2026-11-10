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
  function t(key, params) {
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
    return key;
  }

  /** 把 $1 $2 填进字符串。chrome.i18n 自己也做这件事，但生成包里存的是原文，得我们填 */
  function substitute(text, params) {
    if (!params || !params.length) return text;
    return String(text).replace(/\$(\d+)/g, (m, n) => {
      const v = params[Number(n) - 1];
      return v == null ? m : String(v);
    });
  }

  /**
   * 把带 data-i18n 的节点填上文案（HTML 里用）。
   * `data-i18n` = key；`data-i18n-title` = 写进 title 属性的 key。
   * 纯 DOM 操作用，不在 content script 的每帧路径上，性能无所谓。
   */
  function applyI18n(root) {
    const scope = root || document;
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

  /** 载入生成包（没有就保持 null）。失败静默 —— 拿不到语言包不是错误，回落中文即可 */
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
  async function fetchAny(path, timeoutMs) {
    let lastErr = null;
    for (const build of mirrors) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs || 8000);
      try {
        const res = await fetch(build(path), { signal: ctl.signal, cache: "no-cache" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text();
        clearTimeout(t);
        return text;
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
      }
    }
    throw lastErr || new Error("全部镜像都失败");
  }

  /** 清单：仓库 i18n/index.json，列出有哪些语言可以下 */
  async function fetchIndex() {
    const text = await fetchAny("i18n/index.json");
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("清单格式不对");
    return data;
  }

  /**
   * 校验一份语言包 —— **入库前就拦**，不能指望每个渲染点都转义。
   *
   * 语言包是外部数据：能改仓库的人就能往里面塞 <script>。虽然界面全走 textContent
   * 和 escapeHtml，但那是「渲染时兜底」，多一层入口检查不吃亏，而且能挡掉
   * 手改坏的文件（值不是字符串、超长、嵌了 js: 协议）。
   */
  function validatePack(data) {
    if (!data || typeof data !== "object") return { ok: false, why: "不是对象" };
    const strings = data.strings || data;
    if (!strings || typeof strings !== "object") return { ok: false, why: "没有 strings" };
    let n = 0;
    for (const [k, v] of Object.entries(strings)) {
      if (typeof v !== "string") return { ok: false, why: "key " + k + " 的值不是字符串" };
      if (v.length > 2000) return { ok: false, why: "key " + k + " 太长" };
      if (/<script|javascript:|on\w+\s*=/i.test(v)) return { ok: false, why: "key " + k + " 含可疑内容" };
      n++;
    }
    if (n === 0) return { ok: false, why: "一条都没有" };
    return { ok: true, count: n, strings: strings };
  }

  /**
   * 下载并装上一种语言。成功返回 { ok, count }，失败返回 { ok:false, why }。
   *
   * 失败时**不动现有的包** —— 用户当前界面不能因为一次下载失败就变回中文。
   */
  async function downloadPack(lang) {
    try {
      const text = await fetchAny("i18n/" + encodeURIComponent(lang) + ".json", 15000);
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
  window.RTI18n = {
    t: t,
    applyI18n: applyI18n,
    loadPack: loadPack,
    currentPack: currentPack,
    fetchIndex: fetchIndex,
    downloadPack: downloadPack,
    clearPack: clearPack,
    validatePack: validatePack,
    setBaseUrl: setBaseUrl
  };
})();
