/**
 * 面板的 DOM 骨架 + 槽位 HTML + 增量更新 —— **网页和设置页预览共用的唯一一份**。
 *
 * 为什么要有这个文件：设置页的「效果预览」以前是在 options.js 里**手抄**了一份
 * 面板 DOM，于是每加一个部件（眼睛图标、诊断按钮、rt-actions 容器）预览就落后一步，
 * 表现为「和网页上不一样」。这份文件用普通脚本写成（挂 window.RTPanelCore），
 * 让 content script（manifest 的 js 数组）和设置页（script 标签）都能加载同一份，
 * 从结构上消灭第二份。
 *
 * content script 不能 import，所以这里**不能是 ES module**（只能是普通脚本、挂全局）。
 *
 * **样式表也归这里了**（2026-11-09 合并）：TRIGGER_CSS 与 PANEL_CSS 曾是两份 ——
 * content.js 里手抄一份、lib/trigger-styles.js / lib/panel-styles.js 里各一份 ESM，
 * 靠 test-lib 的逐字比对断言防漂移。那套做法一直在付成本（改一个样式要同步两处，
 * text-align 就漏过一次）。现在合成一处：CSS 挂 window.RTPanelCore，content script
 * 和 options.js 都从全局取，谁都不用 import —— content script 本来也不能 import。
 *
 * lib/trigger-styles.js 仍保留 TRIGGER_STYLES / SVG_GUARDS 等（设置页要的预设清单），
 * 但**不再导出 CSS** —— 样式表的唯一真相源是这里。
 */
(function () {
  /* 文案查表。lib/i18n.js 是普通脚本、排在前面加载；万一它没加载（老页面、
     或者用户禁用了），这里回落成中文原文 —— 面板不能因为少一个文件就显示成 key。 */
  function T(key, fallback) {
    var api = window.RTI18n;
    if (api && typeof api.t === "function") {
      var got = api.t(key);
      if (got && got !== key) return got;
    }
    return fallback;
  }
  'use strict';

  /* ---- 图标：和原来 content.js 里那几份逐字一致 ---- */
  var EYE_SVG =
    "<svg viewBox='0 0 20 20' width='19' height='19' fill='none' stroke='currentColor' stroke-width='1.6' " +
    "stroke-linecap='round' stroke-linejoin='round'><path d='M1.6 10S4.9 4.6 10 4.6 18.4 10 18.4 10 15.1 15.4 10 15.4 1.6 10 1.6 10Z'/>" +
    "<circle cx='10' cy='10' r='2.3'/></svg>";
  var ACT_COPY_SVG =
    "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' " +
    "stroke-linecap='round' stroke-linejoin='round'><rect x='7' y='7' width='9' height='9' rx='1.6'/>" +
    "<path d='M13 4.5H5.6A1.6 1.6 0 0 0 4 6.1V13'/></svg>";
  var ACT_RETRY_SVG =
    "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' " +
    "stroke-linecap='round' stroke-linejoin='round'><path d='M16.5 10a6.5 6.5 0 1 1-1.9-4.6'/>" +
    "<path d='M16.5 3.5V7H13'/></svg>";

/* 图钉：钉住面板位置，不再跟着选区跑（kniph 2026-11-13 要求，多数划词翻译都有）。
   针的形状和眼睛/✕ 同一套线性风格，19×19 同一个 viewBox。 */
var ACT_PIN_SVG =
  "<svg viewBox='0 0 20 20' width='19' height='19' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>" +
  "<path d='M7.6 2.6h4.8l-.8 4.3 3.1 3H5.3l3.1-3z'/>" +
  "<path d='M10 9.9v7.5'/>" +
  '</svg>';
  var ACT_SPEAK_SVG =
    "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' " +
    "stroke-linecap='round' stroke-linejoin='round'><path d='M3.5 7.5h2.8L10 4.2v11.6l-3.7-3.3H3.5z'/>" +
    "<path d='M13 7.6a3.4 3.4 0 0 1 0 4.8'/><path d='M15.2 5.4a6.6 6.6 0 0 1 0 9.2'/></svg>";
  var ACT_STOP_SVG =
    "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' " +
    "stroke-linecap='round' stroke-linejoin='round'><path d='M3.5 7.5h2.8L10 4.2v11.6l-3.7-3.3H3.5z'/>" +
    "<path d='M13 8l4 4M17 8l-4 4'/></svg>";

  /** HTML 转义：只包三个字符，和原来 content.js 里那份一致。 */
  function esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * 面板的**静态骨架**（顶栏 / 正文 / 底栏 / 诊断区）。
   * 和 content.js 原来那段 panel.innerHTML 逐字对应 —— 眼睛的 SVG、
   * rt-actions 容器、data-placeholder、底栏那个「⋯」、诊断区一个都不少。
   */
  function shellHtml() {
    return (
      "<div class='rt-head' data-drag>" +
      "<span class='rt-dot'></span>" +
      "<select class='rt-cfg' title='" + T('panel_cfg_title', '翻译接口') + "'></select>" +
      "<select class='rt-lang' title='" + T('panel_lang_title', '目标语言') + "'></select>" +
      "<div class='rt-actions'>" +
      "<button class='rt-btn rt-pin' data-act='pin' title='" + T('panel_pin_title', '固定面板位置') + "'>" + ACT_PIN_SVG + "</button>" +
      "<button class='rt-btn' data-act='src' title='" + T('panel_src_toggle', '显示 / 隐藏原文') + "'>" + EYE_SVG + "</button>" +
      "<button class='rt-btn' data-act='close' title='" + T('panel_close', '关闭 (Esc)') + "'>&#10005;</button>" +
      "</div></div>" +
      "<div class='rt-body'><div class='rt-src'></div>" +
      "<div class='rt-out empty' data-placeholder='" + T('panel_waiting', '等待结果…') + "'></div></div>" +
      "<div class='rt-foot'><span class='rt-msg'></span>" +
      "<button class='rt-more' data-act='more' title='" + T('panel_more_title', '查看详细信息') + "' hidden>&#8943;</button></div>" +
      "<div class='rt-diag' hidden></div>"
    );
  }

  /**
   * 一条译文尾巴上那排「复制 / 朗读 / 重试」。
   *
   * `speaking` 由调用方传进来（原来是读闭包里的 speakingKey）—— 这是把它抽成
   * 公共函数的唯一代价，换来的是两边共用同一份 HTML。
   */
  function actsHtml(cid, text, speaking) {
    var hasText = !!(text && String(text).trim());
    var stop = !!speaking;
    return (
      "<div class='rt-acts'>" +
      "<button class='rt-act' data-act='copy' data-cid='" + cid + "'" + (hasText ? '' : ' disabled') + " title='" + T('panel_copy_title', '复制这条译文') + "'>" +
      ACT_COPY_SVG + "<span>" + T('panel_copy', '复制') + "</span></button>" +
      "<button class='rt-act' data-act='speak' data-cid='" + cid + "'" + (hasText ? '' : ' disabled') + " " +
      "data-icon='" + (stop ? 'rt-act-stop' : 'rt-act-speak') + "' " +
      "title='" + T(stop ? 'panel_stop_title' : 'panel_speak_title', stop ? '停止朗读' : '朗读这条译文') + "'>" +
      (stop ? ACT_STOP_SVG : ACT_SPEAK_SVG) +
      "<span>" + T(stop ? 'panel_stop' : 'panel_speak', stop ? '停止' : '朗读') + "</span></button>" +
      "<button class='rt-act' data-act='retry-one' data-cid='" + cid + "' title='" + T('panel_retry_title', '只重试这一条') + "'>" +
      ACT_RETRY_SVG + "<span>" + T('panel_retry', '重试') + "</span></button>" +
      "</div>"
    );
  }

  /**
   * 一个槽位块。
   *
   * `s` = { configId, name, state, text, error, statusText }，和 content.js 的槽位对象同形。
   * `opts.allowDel` 决定要不要那个 ×（原逻辑：只有一个槽位时不显示）。
   * `opts.speaking` 同 actsHtml。
   */
  /**
   * 一条结果的状态行 / 正文 / 是否出错。
   *
   * 原来 renderSlots 和 patchSlot 各写了一遍同样的四分支 —— 改一处文案得改两处，
   * 抽 key 的时候正是这种重复最容易漏（漏了就是「首屏英文、更新后变回中文」）。
   */
  function slotStatus(s) {
    var st = "";
    var body = "";
    var err = false;
    if (s.state === "busy") {
      st = T("panel_status_translating", "翻译中…") + (s.statusText || "");
      body = s.text || "";
    } else if (s.state === "done") {
      st = T("panel_status_done", "完成");
      body = s.text || "";
    } else if (s.state === "fail") {
      st = T("panel_status_failed", "失败");
      err = true;
      body = s.error || T("panel_error_fallback", "出错了");
    } else {
      st = T("panel_status_waiting", "等待…");
    }
    return { st: st, body: body, err: err };
  }
  function slotHtml(s, opts) {
    opts = opts || {};
    var st = '';
    var got = slotStatus(s);
    st = got.st;
    var body = got.body;
    var cls = got.err ? ' err' : '';
    var del = opts.allowDel
      ? "<button class='rt-slot-x' data-del='" + esc(s.configId) + "' title='" + T('panel_slot_remove', '不再显示这一条（只影响这次，不改设置里的默认组合）') + "'>×</button>"
      : '';
    return (
      "<div class='rt-slot' data-cid='" + esc(s.configId) + "'>" +
      "<div class='rt-slot-h'><span class='rt-slot-name' data-p='name'>" + esc(s.name) + "</span>" +
      del +
      "<span class='rt-slot-st" + cls + "' data-p='st'>" + esc(st) + "</span></div>" +
      "<div class='rt-slot-b" + cls + "' data-p='body'>" + esc(body) + "</div>" +
      actsHtml(esc(s.configId), body, opts.speaking) +
      "</div>"
    );
  }

  /**
   * 把一个槽位的新状态**就地**写进已经存在的那份 DOM（增量渲染）。
   *
   * 只碰值不碰结构：文本、状态字、err 类、按钮的 disabled 与朗读图标。
   * 子元素用 data-p 定位而不是类名 —— 那几个类名是拼在模板里的，
   * tools/check-dom.mjs 的正则识别不到，会误报「类没有定义」。
   */
  function patchSlot(el, s, speaking) {
    var got = slotStatus(s);
    var st = got.st;
    var body = got.body;
    var err = got.err;

    var nameEl = el.querySelector('[data-p=\"name\"]');
    if (nameEl && nameEl.textContent !== s.name) nameEl.textContent = s.name;

    var stEl = el.querySelector('[data-p=\"st\"]');
    if (stEl) {
      if (stEl.textContent !== st) stEl.textContent = st;
      stEl.classList.toggle('err', err);
    }

    var bodyEl = el.querySelector('[data-p=\"body\"]');
    if (bodyEl) {
      if (bodyEl.textContent !== body) bodyEl.textContent = body;
      bodyEl.classList.toggle('err', err);
    }

    var acts = el.querySelector('.rt-acts');
    if (!acts) return;
    var hasText = !!(body && String(body).trim());
    var stop = !!speaking;
    var copyBtn = acts.querySelector('[data-act=\"copy\"]');
    var speakBtn = acts.querySelector('[data-act=\"speak\"]');
    var retryBtn = acts.querySelector('[data-act=\"retry-one\"]');
    if (copyBtn) copyBtn.disabled = !hasText;
    if (retryBtn) retryBtn.disabled = !hasText;
    if (speakBtn) {
      speakBtn.disabled = !hasText;
      speakBtn.title = stop ? T('panel_stop_title', '停止朗读') : T('panel_speak_title', '朗读这条译文');
      var label = speakBtn.querySelector('span');
      var want = stop ? T('panel_stop', '停止') : T('panel_speak', '朗读');
      if (label && label.textContent !== want) label.textContent = want;
      var wantSvg = stop ? 'rt-act-stop' : 'rt-act-speak';
      if (speakBtn.getAttribute('data-icon') !== wantSvg) {
        var old = speakBtn.querySelector('svg');
        if (old) old.remove();
        speakBtn.insertAdjacentHTML('afterbegin', stop ? ACT_STOP_SVG : ACT_SPEAK_SVG);
        speakBtn.setAttribute('data-icon', wantSvg);
      }
    }
  }

  /** 结果区的一整批槽位（整块重建时用）。 */
  function slotsHtml(slots, opts) {
    opts = opts || {};
    return slots.map(function (s) {
      return slotHtml(s, { allowDel: slots.length > 1, speaking: opts.speaking === s.configId });
    }).join('');
  }

  /**
   * 把诊断行填进容器 —— 真面板的「⋯」展开区与设置页预览**共用这一份**。
   *
   * `rows` = [{ k, v, err?, warn?, hint? }]，和 content.js 组装出来的那份同形。
   * 只负责画行；moreBtn 的显隐、容器 hidden 那些状态属于各自的逻辑。
   */
  function renderDiag(el, rows) {
    if (!el) return;
    el.textContent = "";
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      var line = document.createElement("div");
      line.className = "d-row";
      var k = document.createElement("span");
      k.className = "d-k";
      /* r.k 直接就是文案（调用方已经决定写什么），但允许它带一个 key ——
         content.js 那边的「错误」「截图直传」这些是 label，走查表才有多语言。 */
      k.textContent = r.kKey ? T(r.kKey, r.k) : r.k;
      var v = document.createElement("span");
      v.className = "d-v" + (r.err ? " err" : r.warn ? " warn" : "");
      v.textContent = r.v;
      line.appendChild(k);
      line.appendChild(v);
      if (r.hint) line.title = r.hint;
      el.appendChild(line);
    }
  }
  /* ---- 样式表（唯一真相源，见文件头注）----------------------------------- */

  /* 划词按钮的样式。原在 lib/trigger-styles.js 里 export，content.js 手抄一份 */
  const TRIGGER_CSS = `
/* ---- 翻译按钮（划词后出现在选区旁边） ---- */
.rt-trigger {
  position: fixed;
  display: none;
  align-items: center;
  justify-content: center;
  /* 尺寸由 JS 写成变量：网页缩放时跟着 1/zoom 缩，观感保持不变 */
  width: var(--rt-tr-size, 45px);
  height: var(--rt-tr-size, 45px);
  border-radius: var(--rt-tr-radius, 13px);
  font-size: var(--rt-tr-font, 21px);
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  transition: transform .12s ease;
  /* 线性图标样式（地球 / 自定义）用的底色与描边，跟面板主题一起变 */
  --rt-tr-bg: #1c1c22;
  --rt-tr-fg: #c084fc;
  --rt-tr-bd: #3d3d49;
}
.rt-trigger.light { --rt-tr-bg: #ffffff; --rt-tr-fg: #6d28d9; --rt-tr-bd: #d5d5e0; }
.rt-trigger.show { display: flex; }
.rt-trigger:hover { transform: scale(1.08); }

/* 按钮里的内容：文字或图标，都撑满整个按钮 */
.rt-trigger .rt-ico {
  display: flex; align-items: center; justify-content: center;
  width: 100%; height: 100%; line-height: 1;
}
.rt-trigger .rt-ico svg { width: 100%; height: 100%; display: block; }

/* 预设一：紫色渐变方块 + 「译」字（默认） */
.rt-trigger:where(.s-badge) {
  font: 600 var(--rt-tr-font, 21px)/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #fff;
  background: linear-gradient(135deg, #6d5cf0, #a855f7);
  box-shadow: 0 6px 18px rgba(109, 92, 240, .45);
}

/* 预设二：正圆底 + 线性图标 */
.rt-trigger:where(.s-globe) {
  background: var(--rt-tr-bg);
  color: var(--rt-tr-fg);
  border: 1px solid var(--rt-tr-bd);
  box-shadow: 0 4px 14px rgba(0, 0, 0, .3);
}
.rt-trigger:where(.s-globe) .rt-ico { padding: 21%; }

/* 预设三：自定义 —— 不给任何底座，整块就是用户那段 SVG 本身
   （想要圆盘 / 方块，自己在 SVG 里画一个）。
   background / border / box-shadow 显式清零而不是「不写」：基础样式将来要是加了底色，
   这一条照样压得住，不用回来补。 */
.rt-trigger:where(.s-custom) {
  background: none;
  border: 0;
  box-shadow: none;
  color: var(--rt-tr-fg);
}
.rt-trigger:where(.s-custom) .rt-ico { padding: 0; }
`;

  /* 结果面板的样式。原在 lib/panel-styles.js 里 export，content.js 手抄一份。
     用了 :host 选择器，所以两边都必须放进 shadow root 里跑。 */
  const PANEL_CSS = `:host, * { box-sizing: border-box; }

/* 字号由设置页控制（运行时往 .rt-panel 上写 --rt-fs），这里只是兜底值 */
:host {
  --rt-fs: 20px;
  --rt-fs-sm: 18.4px;
  --rt-fs-xs: 17px;
}

${TRIGGER_CSS}

.rt-panel {
  /* ---- 暗色（默认） ---- */
  --rt-bg: #0f0f11;
  --rt-bg-head: #16161a;
  --rt-bg-sub: #131317;
  --rt-bg-diag: #101014;
  --rt-border: #2b2b33;
  --rt-border-soft: #24242b;
  /* 对比槽位之间的分界线：--rt-border-soft 在暗色下几乎和底色一样，
     单独给一个更亮的（2026-10-17 kniph 报「暗色下看不见」） */
  --rt-slot-line: #3d3d47;
  --rt-text: #d0ccc5;
  --rt-text-dim: #a29d95;
  --rt-text-out: #d8d4cd;
  --rt-text-foot: #908b84;
  --rt-hover: #24242b;
  --rt-accent: #a855f7;
  --rt-accent-soft: #241b38;
  --rt-accent-text: #c084fc;
  --rt-placeholder: #88837b;
  --rt-scroll: #33333c;
  --rt-shadow: 0 18px 50px rgba(0, 0, 0, .62);

  position: fixed;
  display: none;
  flex-direction: column;
  background: var(--rt-bg);
  border: 1px solid var(--rt-border);
  border-radius: 12px;
  box-shadow: var(--rt-shadow);
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: var(--rt-fs);
  line-height: 1.7;
  color: var(--rt-text);
  /* 反向补偿页面缩放：网页放大 150% 时面板按 1/1.5 缩回来，看上去尺寸不变 */
  transform: scale(var(--rt-zs, 1));
  transform-origin: top left;
  overflow: hidden;
  pointer-events: auto;
  user-select: text;

  /* text-align 也是**继承属性**，一样能穿过 shadow DOM —— 和上面 scrollbar-color
     那个坑同源。宿主页是居中排版（博客正文、漫画站、某些 CMS 的容器）时，
     面板里的原文区和译文会一起被居中，看起来像我们自己的排版坏了。
     显式写回 start 把继承掐断：面板自己说了算，永远左对齐。 */
  text-align: start;
}
.rt-panel.show { display: flex; }

/* ---- 亮色 ---- */
.rt-panel.light {
  --rt-bg: #ffffff;
  --rt-bg-head: #f5f5f8;
  --rt-bg-sub: #fafafc;
  --rt-bg-diag: #f4f4f7;
  --rt-border: #d9d9e3;
  --rt-border-soft: #e8e8f0;
  /* 对比槽位之间的分界线（浅色下比 --rt-border-soft 深一点，和暗色对称） */
  --rt-slot-line: #c4c4d0;
  --rt-text: #1b1b22;
  --rt-text-dim: #5f5f6c;
  --rt-text-out: #12121a;
  --rt-text-foot: #6b6b78;
  --rt-hover: #ececf3;
  --rt-accent: #7c3aed;
  --rt-accent-soft: #f0e8ff;
  --rt-accent-text: #6d28d9;
  --rt-placeholder: #72727e;
  --rt-scroll: #c9c9d4;
  --rt-shadow: 0 16px 44px rgba(20, 20, 43, .18);
}

/* 设了固定高度时，正文区自己撑满剩余空间 */
.rt-panel.fixed-h .rt-body { flex: 1 1 auto; min-height: 0; }
.rt-panel.fixed-h .rt-out { flex: 1 1 auto; max-height: none; min-height: 0; }

/* 顶栏：所有间距都按字号走（em），保证任何字号下都只是「包住控件」而已 */
.rt-head {
  display: flex;
  align-items: center;
  gap: .3em;
  padding: .14em .4em;
  background: var(--rt-bg-head);
  border-bottom: 1px solid var(--rt-border-soft);
  cursor: move;
  /* 顶栏恒为一行：子元素再长也不许把它撑高（配置名那条详见 .rt-cfg） */
  flex-wrap: nowrap;
  min-height: 0;
}

/* 顶栏那盏状态灯：透明 = 还没动静，紫 = 正在翻译，绿 = 成功，红 = 失败。
   三个「亮」的状态都带一点辉光 —— 不发光的话小圆点跟背景糊在一起，看不出是灯。 */
.rt-dot {
  width: .45em; height: .45em; border-radius: 50%;
  background: transparent; flex: none;
  transition: background .2s, box-shadow .2s;
}
.rt-dot.on { background: var(--rt-accent); box-shadow: 0 0 .4em var(--rt-accent); }
.rt-dot.ok { background: #22c55e; box-shadow: 0 0 .4em rgba(34, 197, 94, .65); }
.rt-dot.err { background: #ef4444; box-shadow: 0 0 .4em rgba(239, 68, 68, .6); }

/* 顶栏两个下拉（翻译接口 / 目标语言）共用一套外观 —— 多了一个控件，
   面板的样子不该跟着变。宽度分配不同：接口那条吃掉剩下的空间，
   语言那条按内容定长（语言名最长四个字，别去跟接口抢地方）。 */
.rt-cfg, .rt-lang {
  appearance: none;
  background: var(--rt-bg);
  color: var(--rt-text);
  border: 1px solid var(--rt-border);
  border-radius: .3em;
  padding: .1em .4em;
  font: inherit;
  font-size: var(--rt-fs-sm);
  line-height: 1.35;
  cursor: pointer;
  outline: none;
}
/* 配置名可能很长（"OpenAI-compatible (vision)"、"bilibili (free)" 之类），
   <select> 默认**不会截断**——内容一多就把顶栏撑成两行，整个面板跟着往下掉
   （kniph 2026-11-12 报的）。三件套一起上才管用：
     white-space: nowrap  —— 不许换行
     overflow: hidden      —— 溢出裁掉
     text-overflow: ellipsis —— 裁的地方给省略号
   另外下拉框的高度由 line-height 定死，避免不同浏览器把它撑高。 */
.rt-cfg {
  flex: 1 1 auto; min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* 字号跟正文走，不用 --rt-fs-sm —— 那个值 (1.15×正文) 会让这个框比旁边的
     眼睛 / 关闭按钮高出一圈，看起来上下都是空的（kniph 2026-11-12 报的「上边距大」）。
     高度用 line-height + padding 精确压到和 .rt-btn 一样高。 */
  font-size: var(--rt-fs);
  line-height: 1.25;
  padding: .1em .4em;
}
.rt-lang {
  flex: 0 1 auto; min-width: 4.6em; max-width: 5.6em;
  white-space: nowrap;
  font-size: var(--rt-fs);
  line-height: 1.25;
  padding: .1em .4em;
}
.rt-cfg:hover, .rt-lang:hover { border-color: var(--rt-accent); }
.rt-cfg option, .rt-lang option { background: var(--rt-bg-head); color: var(--rt-text); }

.rt-actions { display: flex; gap: .1em; flex: none; }

.rt-btn {
  width: 1.5em; height: 1.5em;
  display: flex; align-items: center; justify-content: center;
  background: transparent;
  border: none;
  border-radius: .3em;
  color: var(--rt-text-foot);
  font-size: 1em;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.rt-btn:hover { background: var(--rt-hover); color: var(--rt-text); }
.rt-btn:disabled { opacity: .35; cursor: default; }
.rt-btn.on { color: var(--rt-accent-text); background: var(--rt-accent-soft); }
.rt-btn svg { display: block; width: 1em; height: 1em; }

.rt-body { display: flex; flex-direction: column; overflow: hidden; }

.rt-src {
  /* 同上：右侧给滚动条槽让位，左右才对称 */
  padding: .5em calc(.7em - 8px) .5em .7em;
  scrollbar-gutter: stable;
  font-size: var(--rt-fs-sm);
  line-height: 1.6;
  color: var(--rt-text-dim);
  background: var(--rt-bg-sub);
  border-bottom: 1px solid var(--rt-border-soft);
  max-height: 6em;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.rt-src.hidden { display: none; }
/* 直传那一屏：原文区贴的就是那张截图本身（原文在图上，贴文字没意义）。
   图可能被页面 CSP 挡掉，挡了只剩下面那句说明 —— translate 里有兜底。 */
.rt-src.has-img { max-height: 14em; }
.rt-src .rt-srcimg {
  display: block;
  max-width: 100%;
  max-height: 11em;
  margin-bottom: .3em;
  border-radius: 6px;
  /* 截的图常常是浅色底，暗色主题下贴出来要有个底衬才看得清边界 */
  background: #fff;
}

.rt-out {
  /* 右边留出滚动条槽（8px）：scrollbar-gutter: stable 让它始终占着，
     出现/消失都不跳；再从右内边距扣掉这 8px，左右才一样宽。
     calc 算出负数时浏览器按 0 处理（最小字号下最多差不到 1px）。 */
  /* 上下留白收到 .3em：原来 .6em（≈10px）跟 .rt-slot 自己的 padding 叠起来，
     配置名上方凭空多出 15px 空隙（kniph 三次报「上边距大」）。左右不动。 */
  padding: .3em calc(.7em - 8px) .3em .7em;
  scrollbar-gutter: stable;
  min-height: 3.6em;
  /* 自适应时的上限 = 设置里那条「结果区最大高度」（vh），默认 46 就是原来写死的那个值。
     单位是 vh 而不是 px：这条上限的用意是「别顶出视口」，跟着窗口走才对。
     下面这个是「页面 CSS 像素」的 vh，被反向缩放再缩一次，所以要乘回来。 */
  max-height: calc(var(--rt-max-h, 46vh) * var(--rt-zoom, 1));
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: calc(var(--rt-fs) * 1.04);
  line-height: 1.8;
  color: var(--rt-text-out);
}
/* 设置成 0（不限）时显式关掉，而不是把变量设成 none —— calc(none * 1) 是无效值，
   会让整条 max-height 失效，行为不好预期。 */
.rt-panel.no-max-h .rt-out { max-height: none; }
.rt-out.empty::before {
  content: attr(data-placeholder);
  color: var(--rt-placeholder);
}

.rt-foot {
  display: flex;
  align-items: center;
  gap: .4em;
  padding: .12em .5em;
  border-top: 1px solid var(--rt-border-soft);
  background: var(--rt-bg-sub);
  font-size: var(--rt-fs-xs);
  line-height: 1.4;
  color: var(--rt-text-foot);
}
.rt-foot .rt-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt-foot .rt-msg.err { color: #dc2626; }
.rt-foot .rt-msg.warn { color: #b45309; }
.rt-panel:not(.light) .rt-foot .rt-msg.err { color: #f87171; }
.rt-panel:not(.light) .rt-foot .rt-msg.warn { color: #fbbf24; }

.rt-more {
  flex: none;
  background: transparent;
  border: 1px solid var(--rt-border);
  border-radius: .3em;
  color: var(--rt-text-foot);
  font: inherit;
  line-height: 1.35;
  padding: 0 .35em .06em;
  cursor: pointer;
}
.rt-more:hover { color: var(--rt-text); border-color: var(--rt-accent); }
.rt-more.warn { color: #b45309; border-color: #e0b060; }
.rt-panel:not(.light) .rt-more.warn { color: #fbbf24; border-color: #4d3f14; }
.rt-more[hidden] { display: none; }

.rt-diag {
  border-top: 1px solid var(--rt-border-soft);
  background: var(--rt-bg-diag);
  /* 同上：15px = 7px 内边距 + 8px 滚动条槽 */
  padding: 10px 7px 10px 15px;
  scrollbar-gutter: stable;
  font-family: ui-monospace, Consolas, "Cascadia Mono", monospace;
  font-size: calc(var(--rt-fs) * 0.8);
  line-height: 1.9;
  color: var(--rt-text-dim);
  max-height: calc(34vh * var(--rt-zoom, 1));
  overflow: auto;
}
.rt-diag[hidden] { display: none; }
.rt-diag .d-row { display: flex; gap: 10px; }
.rt-diag .d-k { flex: none; width: 5.2em; color: var(--rt-placeholder); }
.rt-diag .d-v { min-width: 0; color: var(--rt-text); word-break: break-all; }
.rt-diag .d-v.warn { color: #b45309; }
.rt-diag .d-v.err { color: #dc2626; }
.rt-panel:not(.light) .rt-diag .d-v.warn { color: #fbbf24; }
.rt-panel:not(.light) .rt-diag .d-v.err { color: #f87171; }

/* 滚动条必须自己说了算。网页上继承下来的 scrollbar-color **能穿过 shadow DOM**
   （它是继承属性，普通选择器挡不住），而只要它算出来不是 auto，浏览器就把下面
   那套 ::-webkit-scrollbar 整段忽略 —— 面板里于是冒出一条网页配色的滚动条
   （实测某站是浅蓝滑块 + 白轨道，杵在纯黑面板上格外扎眼）。
   显式写回 auto 把继承掐断，自绘的 8px 灰滑块才生效；scrollbar-width 得一起
   写回 —— 它俩是「任一非 auto 就废掉 ::-webkit-scrollbar」的同一对开关。 */
.rt-out, .rt-src, .rt-diag { scrollbar-color: auto; scrollbar-width: auto; }

.rt-out::-webkit-scrollbar, .rt-src::-webkit-scrollbar, .rt-diag::-webkit-scrollbar { width: 8px; }

/* ---- 对比槽位：结果区里一条一块（只在 ≥2 条时出现；1 条时和以前一模一样） ---- */
/* 上下各留一点：多条对比时槽位之间要有呼吸，否则译文贴着分界线。
   但下边距比上边距小 —— 操作条（复制/朗读/重试）本身就在底部，再垫一层会显得
   「按钮下面空一块」（kniph 两次报「下边距还是大」）。 */
/* 上不留白（上面 .rt-out 已经有了），下只留 0——操作条自己就是底边。 */
.rt-slot { padding: 0; }
/* 槽位之间的分界：暗色下 --rt-border-soft(#24242b) 贴在面板底(#0f0f11)上几乎看不见 ——
   换成专用色 --rt-slot-line（明暗各一档），两种主题下都分得开（kniph 2026-10-17 报的）。
   第一条不画（顶上就是原文区，本来就有一条线）。 */
.rt-slot + .rt-slot {
  border-top: 1px solid var(--rt-slot-line);
  margin-top: .1em;
  padding-top: .5em;
}
.rt-slot-h {
  display: flex; align-items: center; gap: .4em;
  font-size: .72em; color: var(--rt-fg-dim);
  margin-bottom: .1em;
}
.rt-slot-name { font-weight: 550; color: var(--rt-fg); }
/* 配置名旁边的 ×（只在多条时出现）：平时压得很淡，鼠标进这一块才亮 ——
   免得一屏都是叉号显得吵（kniph 2026-10-17）。 */
.rt-slot-x {
  flex: none;
  display: flex; align-items: center; justify-content: center;
  width: 1.1em; height: 1.1em;
  padding: 0; margin-left: .1em;
  background: none; border: none; border-radius: .2em;
  font: inherit; font-size: 1.05em; line-height: 1;
  color: var(--rt-text-foot);
  cursor: pointer;
  opacity: .45;
  transition: opacity .13s, background .13s, color .13s;
}
.rt-slot:hover .rt-slot-x { opacity: 1; }
.rt-slot-x:hover { background: var(--rt-hover); color: #ef4444; }
.rt-slot-st { margin-left: auto; }
.rt-slot-st.err { color: #ef4444; }
.rt-slot-b { white-space: pre-wrap; word-break: break-word; }

/* ---- 译文尾部的操作条（复制 / 朗读 / 重试）----
   kniph 2026-10-17：重试从顶栏搬下来（顶栏那个只管主配置，多条对比时
   「只重试最上面那条」很别扭）；朗读一并放这儿。每条结果自己带一排。 */
.rt-acts {
  display: flex; align-items: center; gap: .1em;
  /* 上下边距一律 0，行高由 .rt-act 自己撑 —— 这排是译文的附属物，
     有任何一截留白都会让每条结果看起来分成两段（kniph 两次报「边距大」）。 */
  margin: 0;
  /* 字号**显式钉死**：这个容器在 .rt-out 里，继承下来的是 1.04 × 正文字号
     （16.64px），按钮跟着变高、整排往下多占一截。 */
  font-size: calc(var(--rt-fs) * .8);
  line-height: 1;
  opacity: .55;
  transition: opacity .13s;
}
.rt-slot:hover .rt-acts,
.rt-acts:hover { opacity: 1; }
.rt-act {
  display: flex; align-items: center; gap: .22em;
  background: none; border: none;
  padding: 0 .3em;
  border-radius: .25em;
  font: inherit;
  font-size: .74em;
  line-height: 1.25;
  color: var(--rt-text-foot);
  cursor: pointer;
}
.rt-act:hover { background: var(--rt-hover); color: var(--rt-text); }
.rt-act svg { display: block; width: 1.05em; height: 1.05em; }
.rt-act[disabled] { opacity: .4; cursor: default; }
.rt-act[disabled]:hover { background: none; color: var(--rt-text-foot); }

/* 图钉：钉住时描边点亮，和状态灯一个色系 —— 一眼能看出「现在是固定状态」。
   钉住后面板不再跟着选区跑，用户可以放着慢慢看 / 对照原文。 */
.rt-pin.on {
  color: var(--rt-accent);
  background: var(--rt-accent-soft);
}
.rt-slot-b.err { color: #ef4444; font-size: .82em; }

.rt-out::-webkit-scrollbar-thumb, .rt-src::-webkit-scrollbar-thumb, .rt-diag::-webkit-scrollbar-thumb {
  background: var(--rt-scroll); border-radius: 4px;
}
`;

  window.RTPanelCore = {
    EYE_SVG: EYE_SVG,
    ACT_COPY_SVG: ACT_COPY_SVG,
    ACT_RETRY_SVG: ACT_RETRY_SVG,
    ACT_SPEAK_SVG: ACT_SPEAK_SVG,
    ACT_STOP_SVG: ACT_STOP_SVG,
  ACT_PIN_SVG: ACT_PIN_SVG,
    esc: esc,
    shellHtml: shellHtml,
    actsHtml: actsHtml,
    slotHtml: slotHtml,
    slotsHtml: slotsHtml,
    patchSlot: patchSlot,
    renderDiag: renderDiag,
    TRIGGER_CSS: TRIGGER_CSS,
    PANEL_CSS: PANEL_CSS
  };
})();
