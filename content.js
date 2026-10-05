/**
 * content script：划词 → 小圆点 → 结果面板
 * ------------------------------------------------------------------
 * 全部 UI 放在 Shadow DOM 里，页面样式进不来，我们也不污染页面。
 * 真正的请求交给 background 发（页面里 fetch 会被 CORS 拦）。
 */

(() => {
  if (window.__requestTranslateInjected) return;
  window.__requestTranslateInjected = true;

  const HOST_ID = 'request-translate-host';
  if (document.getElementById(HOST_ID)) return;

  /* ------------------------------------------------------------------ */
  /* 状态                                                                */
  /* ------------------------------------------------------------------ */

  let prefs = {
    trigger: 'button',
    triggerStyle: 'badge',
    triggerSize: 45,
    triggerSvg: '',
    panelWidth: 460,
    panelHeight: 0,
    fontSize: 20,
    theme: 'auto',
    showOriginal: true,
    // 顶栏那个「目标语言」下拉也改它（{{target}} / {{targetCode}} 都读这里）
    targetLang: '简体中文',
    maxChars: 8000
  };
  let configs = [];
  let activeConfigId = '';
  let currentText = '';
  let currentConfigId = '';
  let busy = false;
  let lastAuto = { text: '', at: 0 };

  /* 每个配置各自留一份结果快照。顶栏那个下拉的规矩（kniph 定的，两条缺一不可）：

       * **翻过的配置** → 把上次的结果原样放回来，一个请求都不发；
       * **没翻过的配置** → 当场用这个配置翻一次，不能只清空面板等用户去点 ↻；
       * 「↻」的语义是**重发同一条请求**（结果不满意才按），不是「第一次翻」。

     这样才够用：a 翻 → 切 b（b 自己翻）→ 切回 a（立刻看到 a 刚才那条），
     切来切去对比接口不用重复付钱。

     只对**同一段原文**有效：原文一变（新划词 / 右键 / 换一张截图）整批作废。
     判据是下面的 cacheKey —— 数据驱动，不指望每个调用点都记得来清。 */
  const resultCache = new Map();   // configId → { r, ocr, action, fatal }
  let cacheKey = null;
  /** 发出去的那条请求用的是哪个配置 —— 结果回来时按它归档（用户可能已经切走了） */
  let pendingConfigId = '';

  /** 当前标签页的缩放比（1 = 100%）。面板与按钮要按这个值反向补偿，才不会被网页缩放带着一起变大变小 */
  let zoom = 1;
  /** 面板最近一次的定位锚点，缩放变化时用来重算位置 */
  let lastAnchor = null;
  /** 最近一次松手的位置：用来判断用户是从哪头拖选的 */
  let lastMouse = null;
  /** 最近一次右键的位置。右键菜单的 onClicked 不给坐标，面板只能记着用户点在哪儿 */
  let lastRightClick = null;
  /** 这次翻译是不是从截图来的（{provider, ms, bytes}）—— 状态栏和诊断里标出来 */
  let lastOcr = null;
  /** 最近一次动作：'ocr' 时「重新翻译」按钮要重跑识别，而不是重翻一段空文本 */
  let lastAction = '';
  /** 截图翻译时面板的落点，重试还要用 */
  let lastOcrAnchor = null;

  /* ------------------------------------------------------------------ */
  /* 按钮预设                                                            */
  /* ------------------------------------------------------------------ */
  /* ⚠️ 下面这两块与 lib/trigger-styles.js 里的**逐字一致**（content script 不能
     import，只能复制）。tools/test-lib.mjs 会读本文件比对，改一边必须改另一边。
     为什么用户填的 SVG 是「整段校验、不通过就不用」，见 lib/trigger-styles.js 顶部的说明。 */

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

  /* 用户粘进来的自定义 SVG 要过的几道关。⚠️ 同样与 lib/trigger-styles.js 的
     SVG_GUARDS 一致（测试逐个正则比对）。为什么是「整体拒绝」而不是「改写危险标签」，
     见那边的注释 —— 这段 HTML 会插进 shadow DOM，而 content script 的世界能碰 chrome.*。 */
  const SVG_GUARDS = [
    { re: /^<svg[\s>]/i, negate: true, reason: '要以 <svg 开头' },
    { re: /<\/svg>\s*$/i, negate: true, reason: '要以 </svg> 结尾' },
    {
      re: /<\s*(?:script|foreignObject|iframe|image|use|a|style|animate|set)\b/i,
      reason: '不能有 <script> / <foreignObject> / <use> / <image> / <a> / <style> 这类标签'
    },
    { re: /\son[a-z]+\s*=/i, reason: '不能带 onload / onclick 这类事件属性' },
    { re: /\b(?:xlink:)?href\s*=/i, reason: '不能带 href 外链' }
  ];

  /** 通过检查就原样返回，否则返回空串（页面这边不需要原因，设置页会告诉用户） */
  function sanitizeTriggerSvg(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    for (const g of SVG_GUARDS) {
      const hit = g.re.test(raw);
      if (g.negate ? !hit : hit) return '';
    }
    return raw;
  }

  const TRIGGER_PRESETS = {
    badge: { round: true, html: '译' },
    globe: {
      round: false,
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><ellipse cx="12" cy="12" rx="3.9" ry="8.6"/><path d="M3.6 9.1h16.8M3.6 14.9h16.8"/></svg>'
    },
    // 自定义：没有底座（CSS 里 .s-custom 全是 none / 0），html 是「还没填图标」时的占位。
    // ⚠️ 写成模板字符串（真换行）而不是 '\n'：test-lib 是拿**文件原文**去比对这份 SVG 的，
    //    单引号写法在原文里是「反斜杠 + n」两个字符，squash 掉空白也对不上。
    custom: {
      round: false,
      html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3.5 7.5h11M3.5 12h7.5M3.5 16.5h9"/>
  <path d="M14.5 9.5 18 13l-3.5 3.5"/>
  <path d="M18 13h-6.5"/>
</svg>`
    }
  };

  /* ------------------------------------------------------------------ */
  /* 宿主节点 + 样式                                                     */
  /* ------------------------------------------------------------------ */

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:0',
    'height:0',
    'z-index:2147483647',
    'pointer-events:none'
  ].join(';');

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
:host, * { box-sizing: border-box; }

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
  --rt-text: #e8e8ea;
  --rt-text-dim: #7d7d88;
  --rt-text-out: #f2f2f4;
  --rt-text-foot: #6c6c78;
  --rt-hover: #24242b;
  --rt-accent: #a855f7;
  --rt-accent-soft: #241b38;
  --rt-accent-text: #c084fc;
  --rt-placeholder: #5a5a66;
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
  --rt-text: #1b1b22;
  --rt-text-dim: #5f5f6c;
  --rt-text-out: #12121a;
  --rt-text-foot: #6b6b78;
  --rt-hover: #ececf3;
  --rt-accent: #7c3aed;
  --rt-accent-soft: #f0e8ff;
  --rt-accent-text: #6d28d9;
  --rt-placeholder: #9a9aa6;
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
.rt-cfg { flex: 1 1 auto; min-width: 0; }
.rt-lang { flex: 0 1 auto; min-width: 5.4em; max-width: 6.6em; }
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
  padding: .5em .7em;
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

.rt-out {
  padding: .6em .7em;
  min-height: 3.6em;
  /* vh 是「页面 CSS 像素」，被上面的反向缩放再缩一次，所以要乘回来 */
  max-height: calc(46vh * var(--rt-zoom, 1));
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: calc(var(--rt-fs) * 1.04);
  line-height: 1.8;
  color: var(--rt-text-out);
}
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
  padding: 10px 15px;
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
.rt-out::-webkit-scrollbar-thumb, .rt-src::-webkit-scrollbar-thumb, .rt-diag::-webkit-scrollbar-thumb {
  background: var(--rt-scroll); border-radius: 4px;
}
`;

  shadow.appendChild(style);

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */

  const trigger = document.createElement('div');
  trigger.className = 'rt-trigger s-badge';
  trigger.title = '翻译选中内容';
  const triggerIcon = document.createElement('span');
  triggerIcon.className = 'rt-ico';
  triggerIcon.textContent = TRIGGER_PRESETS.badge.html;
  trigger.appendChild(triggerIcon);

  const panel = document.createElement('div');
  panel.className = 'rt-panel';
  panel.innerHTML = `
    <div class="rt-head" data-drag>
      <span class="rt-dot"></span>
      <select class="rt-cfg" title="翻译接口"></select>
      <select class="rt-lang" title="目标语言"></select>
      <div class="rt-actions">
        <button class="rt-btn" data-act="src" title="显示 / 隐藏原文">
          <svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 10S4.9 4.6 10 4.6 18.4 10 18.4 10 15.1 15.4 10 15.4 1.6 10 1.6 10Z"/><circle cx="10" cy="10" r="2.3"/></svg>
        </button>
        <button class="rt-btn" data-act="retry" title="重新翻译">&#8635;</button>
        <button class="rt-btn" data-act="copy" title="复制译文">&#10697;</button>
        <button class="rt-btn" data-act="close" title="关闭 (Esc)">&#10005;</button>
      </div>
    </div>
    <div class="rt-body">
      <div class="rt-src"></div>
      <div class="rt-out empty" data-placeholder="等待结果…"></div>
    </div>
    <div class="rt-foot">
      <span class="rt-msg"></span>
      <button class="rt-more" data-act="more" title="查看详细信息" hidden>&#8943;</button>
    </div>
    <div class="rt-diag" hidden></div>
  `;

  shadow.appendChild(trigger);
  shadow.appendChild(panel);

  const dot = panel.querySelector('.rt-dot');
  const cfgSelect = panel.querySelector('.rt-cfg');
  const langSelect = panel.querySelector('.rt-lang');
  const srcBox = panel.querySelector('.rt-src');
  const outBox = panel.querySelector('.rt-out');
  const msgBox = panel.querySelector('.rt-msg');
  const moreBtn = panel.querySelector('.rt-more');
  const diagBox = panel.querySelector('.rt-diag');
  const srcBtn = panel.querySelector('[data-act="src"]');
  const retryBtn = panel.querySelector('[data-act="retry"]');
  const copyBtn = panel.querySelector('[data-act="copy"]');

  function mount() {
    if (!document.documentElement.contains(host)) document.documentElement.appendChild(host);
  }

  /* ------------------------------------------------------------------ */
  /* 外观：主题 / 字号 / 尺寸                                            */
  /* ------------------------------------------------------------------ */

  const lightQuery = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;

  function resolveDark() {
    const t = prefs.theme || 'auto';
    if (t === 'light') return false;
    if (t === 'dark') return true;
    return lightQuery ? !lightQuery.matches : true;
  }

  function applyTheme() {
    const light = !resolveDark();
    panel.classList.toggle('light', light);
    // 按钮不在面板里（是 shadow 的另一个子节点），主题得单独同步一次
    trigger.classList.toggle('light', light);
  }

  function applyFontSize() {
    const fs = Math.min(48, Math.max(11, Number(prefs.fontSize) || 20));
    panel.style.setProperty('--rt-fs', fs + 'px');
    panel.style.setProperty('--rt-fs-sm', (fs * 0.92).toFixed(2) + 'px');
    panel.style.setProperty('--rt-fs-xs', (fs * 0.85).toFixed(2) + 'px');
  }

  function panelWidth() {
    return Math.min(1600, Math.max(280, Number(prefs.panelWidth) || 460));
  }

  function applyPanelSize() {
    panel.style.width = panelWidth() + 'px';

    const h = Number(prefs.panelHeight) || 0;
    if (h > 0) {
      panel.style.maxHeight = Math.min(2400, Math.max(200, h)) + 'px';
      panel.classList.add('fixed-h');
    } else {
      panel.style.maxHeight = '';
      panel.classList.remove('fixed-h');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 页面缩放补偿                                                        */
  /* ------------------------------------------------------------------ */
  /* 网页被 Ctrl+加减号放大时，整页的 CSS 像素都会跟着变大，
     我们这些 fixed 定位的面板同样逃不掉。这里把标签页的真实缩放比
     从后台问出来（chrome.tabs.getZoom），再用 1/zoom 缩回去。
     面板走 transform，小圆点直接改尺寸 —— 后者能让 hover 放大照常工作。 */

  /** 按钮边长（px）。限制在 20~96，和设置页的输入框范围一致 */
  function triggerSize() {
    return Math.min(96, Math.max(20, Math.round(Number(prefs.triggerSize) || 45)));
  }

  /** 当前选中的按钮预设 */
  function triggerPreset() {
    return TRIGGER_PRESETS[prefs.triggerStyle] || TRIGGER_PRESETS.badge;
  }

  /** 换样式：切 class、换图标（底色和形状都在 CSS 里，按 class 走） */
  function applyTriggerStyle() {
    const id = TRIGGER_PRESETS[prefs.triggerStyle] ? prefs.triggerStyle : 'badge';
    for (const key of Object.keys(TRIGGER_PRESETS)) trigger.classList.toggle('s-' + key, key === id);
    // 用户自己粘的 SVG 优先，底座（底色 / 形状）还是用上面选的那个预设
    const markup = sanitizeTriggerSvg(prefs.triggerSvg) || TRIGGER_PRESETS[id].html;
    // 只在内容真变了才动 innerHTML：这个函数现在每次显示按钮都会走一遍，
    // 每次都重设等于每次把 SVG 重新解析一遍，还会把 hover 动画打断
    if (triggerIcon.__markup !== markup) {
      triggerIcon.innerHTML = markup;
      triggerIcon.__markup = markup;
    }
    applyZoom();
  }

  function applyAppearance() {
    applyTheme();
    applyFontSize();
    applyPanelSize();
    applyTriggerStyle();
  }

  function applyZoom() {
    const k = 1 / zoom;
    const size = triggerSize();

    panel.style.setProperty('--rt-zs', String(k));
    panel.style.setProperty('--rt-zoom', String(zoom));

    // 按钮不用 transform（会和 hover 的 scale 打架），直接把尺寸按 1/zoom 缩。
    // 而且写成 CSS 变量、不是内联 width/height —— 内联样式会挡住外面来的样式，
    // 尺寸一写死，外观就锁死了。
    // box-shadow 留在 CSS 里不带 k：它跟着元素一起被缩放，视觉上本来就是恒定的。
    trigger.style.setProperty('--rt-tr-size', (size * k).toFixed(2) + 'px');
    trigger.style.setProperty(
      '--rt-tr-radius',
      triggerPreset().round ? (size * 0.29 * k).toFixed(2) + 'px' : '50%'
    );
    trigger.style.setProperty('--rt-tr-font', (size * 0.47 * k).toFixed(2) + 'px');
  }

  /** 把 rect 按比例缩放（缩放变了，同一段文字在页面 CSS 像素里的坐标也会变） */
  function scaleRect(r, k) {
    if (!r) return null;
    return {
      left: r.left * k,
      right: r.right * k,
      top: r.top * k,
      bottom: r.bottom * k,
      width: r.width * k,
      height: r.height * k
    };
  }

  function setZoom(next) {
    const z = Math.min(5, Math.max(0.25, Number(next) || 1));
    if (Math.abs(z - zoom) < 0.001) return;
    const ratio = z / zoom;
    zoom = z;
    applyZoom();

    // 位置是按页面 CSS 像素记的，缩放一变就得重算
    if (panel.classList.contains('show')) {
      const found = readSelection();
      placePanel(found ? found.anchor.rect : scaleRect(lastAnchor, ratio));
    }
    if (trigger.classList.contains('show')) updateTrigger();
  }

  async function syncZoom() {
    try {
      const z = await chrome.runtime.sendMessage({ type: 'rt-get-zoom' });
      if (typeof z === 'number') setZoom(z);
    } catch {
      /* 拿不到就按 100% 算，最坏情况就是和以前一样跟着网页缩放 */
    }
  }

  if (lightQuery) {
    const onSchemeChange = () => {
      if ((prefs.theme || 'auto') === 'auto') applyTheme();
    };
    if (lightQuery.addEventListener) lightQuery.addEventListener('change', onSchemeChange);
    else if (lightQuery.addListener) lightQuery.addListener(onSchemeChange);
  }

  /* ------------------------------------------------------------------ */
  /* 位置                                                                */
  /* ------------------------------------------------------------------ */

  /** 面板 / 按钮与视口边缘的最小间距（物理像素，网页缩放后观感不变） */
  const EDGE = 12;

  /**
   * 把面板夹进视口，保证它**整个**都看得见。
   *
   * 坐标系容易搞错，记一下：面板是 fixed + `transform: scale(1/zoom)`，
   * 而 transform-origin 是左上角 —— 缩放**不会移动左上角**，
   * 所以 `left/top` 就是它的视觉左上角，但视觉宽高要乘 1/zoom
   * （`offsetWidth` 是不含 transform 的布局尺寸）。
   * 夹取必须在这个视觉尺寸上算，否则网页一缩放，右/下两边就会算错。
   *
   * 面板比视口还大（小窗口 + 大面板）时没得选，只能贴左上角。
   */
  function clampPanel(x, y) {
    const k = 1 / zoom;
    const edge = EDGE * k;
    const wVis = panel.offsetWidth * k;
    const hVis = panel.offsetHeight * k;
    const maxX = window.innerWidth - wVis - edge;
    const maxY = window.innerHeight - hVis - edge;

    return {
      x: maxX <= edge ? edge : Math.min(Math.max(x, edge), maxX),
      y: maxY <= edge ? edge : Math.min(Math.max(y, edge), maxY)
    };
  }

  function placePanel(anchor) {
    applyPanelSize();
    if (anchor) lastAnchor = scaleRect(anchor, 1);

    const k = 1 / zoom;
    const w = panelWidth();
    const rw = w * k;          // 反向缩放后面板在页面 CSS 像素里占多宽
    const gap = 14 * k;        // 物理上恒为 14px
    const edge = EDGE * k;
    const vw = window.innerWidth;

    // 默认贴选区右下；右边放不下就翻到选区左侧
    let x = anchor ? anchor.right + gap : vw - rw - edge;
    const y = anchor ? anchor.bottom + 10 * k : 80 * k;
    if (anchor && x + rw > vw - edge) x = anchor.left - rw - gap;

    const p = clampPanel(x, y);
    panel.style.left = p.x + 'px';
    panel.style.top = p.y + 'px';
  }

  /**
   * 内容变高之后（流式输出、展开诊断）面板可能顶出视口底部，把它拉回来。
   * 只在真的出界时才动，避免面板无谓地跳。
   */
  function keepPanelInView() {
    if (!panel.classList.contains('show')) return;
    const x = parseFloat(panel.style.left) || 0;
    const y = parseFloat(panel.style.top) || 0;
    const p = clampPanel(x, y);
    if (p.x !== x) panel.style.left = p.x + 'px';
    if (p.y !== y) panel.style.top = p.y + 'px';
  }

  /* ------------------------------------------------------------------ */
  /* 面板开关                                                            */
  /* ------------------------------------------------------------------ */

  function showPanel(anchor) {
    mount();
    // 先显示再定位：面板高度是内容撑出来的，藏着的时候量到的是 0，
    // 夹取会以为它塞得下而贴着底边放，结果底部被切掉。
    panel.classList.add('show');
    placePanel(anchor);
    keepPanelInView();
  }

  function hidePanel() {
    panel.classList.remove('show');
  }

  function hideTrigger() {
    trigger.classList.remove('show');
  }

  function setStatus(text, kind) {
    msgBox.textContent = text || '';
    msgBox.className = 'rt-msg' + (kind ? ' ' + kind : '');
  }

  /* 顶栏那盏灯的四种状态（悬停时给一句话，省得靠猜） */
  const DOT_TIP = { on: '正在翻译…', ok: '翻译成功', err: '翻译失败' };

  function setDot(kind) {
    dot.className = 'rt-dot' + (kind ? ' ' + kind : '');
    dot.title = DOT_TIP[kind] || '';
  }

  /* ------------------------------------------------------------------ */
  /* 顶部的「原文」开关                                                  */
  /* ------------------------------------------------------------------ */

  function syncSrcBtn() {
    const on = !!prefs.showOriginal;
    srcBox.classList.toggle('hidden', !on);
    srcBtn.classList.toggle('on', on);
    srcBtn.title = on ? '隐藏原文（当前显示中）' : '显示原文（当前隐藏中）';
  }

  /** 把一项设置写回 storage —— 和设置页共用同一份 state */
  /* 串行化：这里是「读整个 state → 改一个字段 → 写回去」，
     连着写两次（比如快速点两下顶部那个「原文」按钮）两次读写会交错，
     后完成的那次可能写的是先发起的值 —— 落盘的设置就和界面上的不一样了。 */
  let saveChain = Promise.resolve();

  function saveSetting(key, value) {
    saveChain = saveChain.then(async () => {
      try {
        const raw = await chrome.storage.local.get('state');
        const st = raw && raw.state;
        if (!st) return;
        st.settings = { ...(st.settings || {}), [key]: value };
        await chrome.storage.local.set({ state: st });
      } catch {
        /* 存不下就算了，本次会话内已经生效 */
      }
    });
    return saveChain;
  }

  /* ------------------------------------------------------------------ */
  /* 底部「…」里的诊断                                                   */
  /* ------------------------------------------------------------------ */

  let diagOpen = false;

  function formatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function buildDiag(r) {
    const rows = [];
    const secs = (v) => (typeof v === 'number' ? (v / 1000).toFixed(2) + ' s' : '—');
    // 截图翻译时先交代这段原文是怎么来的 —— 直传模式下压根没有原文，更要说清楚
    if (lastOcr) {
      rows.push(lastOcr.direct
        ? {
            k: '截图直传',
            v: '没有走 OCR，图片直接进了请求' + (lastOcr.bytes ? ' · 图 ' + formatBytes(lastOcr.bytes) : ''),
            hint: '设置里勾了「禁用外置 OCR」，这张图是靠 {{image}} 塞进请求模板的'
          }
        : {
            k: '截图 OCR',
            v: `${lastOcr.provider} · ${secs(lastOcr.ms)}` +
              (lastOcr.bytes ? ' · 图 ' + formatBytes(lastOcr.bytes) : ''),
            hint: '这段原文是剪切板里那张截图认出来的'
          });
    }
    rows.push({ k: '首字', v: secs(r.firstDeltaMs), hint: '第一个译文分片出现的时间，你等待的就是它' });
    rows.push({ k: '总耗时', v: secs(r.ms) });
    if (r.mode) rows.push({ k: '响应格式', v: String(r.mode).toUpperCase() });
    if (typeof r.chunks === 'number') rows.push({ k: '分片', v: String(r.chunks) });
    if (r.bytes) rows.push({ k: '响应大小', v: formatBytes(r.bytes) });
    if (r.usedPath) rows.push({ k: '命中路径', v: r.usedPath });

    if (r.reasoningChars) {
      rows.push({
        k: '模型思考',
        v: r.reasoningChars + ' 字 —— 思考没关掉，翻译场景把 reasoning_effort 设成 "none" 会快很多',
        warn: true
      });
    } else {
      rows.push({ k: '模型思考', v: '无（直接作答）' });
    }

    if (r.missingVars && r.missingVars.length) {
      rows.push({ k: '缺失变量', v: r.missingVars.join('、'), err: true });
    }
    for (const w of (r.warnings || [])) rows.push({ k: '提示', v: w, warn: true });
    if (r.error) rows.push({ k: '错误', v: r.error, err: true });
    return rows;
  }

  function showDiag(rows) {
    diagBox.textContent = '';
    for (const r of rows) {
      const line = document.createElement('div');
      line.className = 'd-row';
      const k = document.createElement('span');
      k.className = 'd-k';
      k.textContent = r.k;
      const v = document.createElement('span');
      v.className = 'd-v' + (r.err ? ' err' : r.warn ? ' warn' : '');
      v.textContent = r.v;
      line.appendChild(k);
      line.appendChild(v);
      if (r.hint) line.title = r.hint;
      diagBox.appendChild(line);
    }
    const any = rows.length > 0;
    moreBtn.hidden = !any;
    moreBtn.classList.toggle('warn', rows.some((x) => x.warn || x.err));
    diagBox.hidden = !any || !diagOpen;
  }

  function resetDiag() {
    diagOpen = false;
    diagBox.textContent = '';
    diagBox.hidden = true;
    moreBtn.hidden = true;
    moreBtn.classList.remove('warn');
  }

  /* ------------------------------------------------------------------ */
  /* 端口通信                                                            */
  /* ------------------------------------------------------------------ */

  let port = null;

  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: 'rt-translate' });
    } catch {
      port = null;
      return null;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
    });
    port.postMessage({ type: 'hello' });
    return port;
  }

  function ensurePort() {
    if (!port) connectPort();
    return port;
  }

  /* ------------------------------------------------------------------ */
  /* 流式渲染                                                            */
  /* ------------------------------------------------------------------ */

  // 实测（tools/perf-probe.mjs）：流式渲染是这个扩展唯一真正花钱的地方，
  // 成本正比于「渲染次数 × 文本长度」—— 每渲染一次，浏览器就要把整块译文重新排版。
  //
  // 试过但实测无效的做法：把两次强制布局减为一次、用 rAF 合并、原地改写文本节点。
  // 前两个在噪声内（±3%），因为分片间隔本身就接近刷新率，合并不了多少。
  // 唯一有效的杠杆是「少渲染几次」，所以这里做时间节流：
  //
  //   RENDER_INTERVAL = 50 → 约 20fps
  //   实测布局开销：A 常规 52→37ms，C 500分片 115→41ms，D 极端 435→136ms（−69%）
  //
  // 关键是它对慢速接口完全无副作用：分片间隔超过 50ms 时每个分片都立即渲染，
  // 和原来一模一样。只有分片涌进来的场景（本地模型、带思考的模型）才会触发节流，
  // 而那正是需要省的地方。请求结束时 done 会立刻写入最终文本，尾巴上不会少字。
  const RENDER_INTERVAL = 50;

  let pendingDelta = null;
  let deltaTimer = 0;
  let lastFlush = 0;

  function cancelPendingDelta() {
    if (deltaTimer) {
      clearTimeout(deltaTimer);
      deltaTimer = 0;
    }
    pendingDelta = null;
  }

  function applyDelta() {
    deltaTimer = 0;
    lastFlush = performance.now();

    const text = pendingDelta === null ? '' : pendingDelta;
    pendingDelta = null;

    outBox.classList.remove('empty');
    // 不自动跟随到底部（kniph 定的）：有些模型吐字很快，视口被一路拉着往下跑就
    // 根本读不了。文本是一段段往**后**接的，视口原地不动就能从头安静读完；
    // 想追尾巴自己拖滚动条。（顺带省掉一次强制布局 —— 以前那行要读 scrollHeight。）
    outBox.textContent = text;
    // 译文一段段变长，面板也跟着长高，底部可能顶出视口 —— 拉回来
    keepPanelInView();
  }

  function queueDelta(text) {
    pendingDelta = text || '';
    if (deltaTimer) return;
    const gap = performance.now() - lastFlush;
    if (gap >= RENDER_INTERVAL) applyDelta();
    else deltaTimer = setTimeout(applyDelta, RENDER_INTERVAL - gap);
  }

  /* ------------------------------------------------------------------ */
  /* 结果铺到界面上 / 按配置归档                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 把一次请求的结果铺到界面上。
   *
   * `done`、`fatal` 两条消息和「切回有缓存的配置」共用这一段 —— 三处各写一套的话，
   * 迟早有一套长歪（状态栏三段、灯、诊断都得跟着一起改）。
   * 所以这里连 busy / 重试按钮 也一并收口，调用方不用自己管。
   */
  function renderResult(r, ocr, action, fatal) {
    cancelPendingDelta();
    busy = false;
    retryBtn.disabled = false;
    // 截图那条路的上下文跟着结果一起换：状态栏的「截图 OCR」和诊断里的图片信息都读它
    lastOcr = ocr || null;
    if (action) lastAction = action;

    if (r && r.text) {
      outBox.classList.remove('empty');
      outBox.textContent = r.text;
      // 状态栏只留「HTTP · 耗时 · 路径」三段，其余都收进「…」
      const bits = [];
      if (lastOcr) bits.push(lastOcr.direct ? '截图直传' : '截图 OCR');
      if (r.status) bits.push('HTTP ' + r.status);
      if (typeof r.ms === 'number') bits.push((r.ms / 1000).toFixed(1) + 's');
      if (r.usedPath) bits.push(r.usedPath);
      const noisy = (r.warnings && r.warnings.length > 0) ||
        (r.missingVars && r.missingVars.length > 0);
      setStatus(bits.join(' · '), noisy ? 'warn' : '');
      setDot('ok');
      showDiag(buildDiag(r));
      return;
    }

    outBox.classList.remove('empty');
    outBox.textContent = '';
    outBox.dataset.placeholder = fatal ? '出错了' : '没有返回内容';
    const why = (r && r.error) || (fatal ? '出错了' : '没有拿到译文');
    setStatus(why, 'err');
    setDot('err');
    showDiag(fatal ? [{ k: '错误', v: why, err: true }] : buildDiag(r || {}));
  }

  /** 这次的结果按配置归档 —— 同一段原文内，切回来就靠它 */
  function rememberResult(configId, r, ocr, action, fatal) {
    if (!configId) return;
    resultCache.set(configId, { r, ocr, action, fatal: !!fatal });
  }

  /** 没东西可翻的那种切换（连原文都没有）：面板清干净，让用户点 ↻ 重来。
      有原文或图的时候不该走到这儿 —— 那条路会**直接发请求**（见 cfgSelect 的 change）。 */
  function showNoCachedResult(configId) {
    const hit = configs.find((c) => c.id === configId);
    cancelPendingDelta();
    busy = false;
    retryBtn.disabled = false;
    resetDiag();
    outBox.classList.remove('empty');
    outBox.textContent = '';
    outBox.dataset.placeholder = '点 ↻ 翻译';
    setDot('');
    setStatus(hit ? `已切到「${hit.name}」，点 ↻ 翻译` : '点 ↻ 翻译');
  }

  function onPortMessage(msg) {
    if (!msg) return;

    if (msg.type === 'ready') {
      configs = msg.configs || [];
      if (Array.isArray(msg.targetLangs)) targetLangs = msg.targetLangs;
      activeConfigId = msg.activeConfigId || (configs[0] && configs[0].id) || '';
      if (msg.settings) prefs = { ...prefs, ...msg.settings };
      renderConfigOptions();
      renderLangOptions();
      return;
    }

    if (msg.type === 'start') {
      // 这条是给「发请求时选中的那个配置」看的。用户可能已经切走了 ——
      // 切到**有缓存**的配置时那条请求不会被中止（后台只在收到新的 translate 时才 abort），
      // 所以它的 start / delta 还会继续来，不挡住就把人家刚铺好的结果冲掉了。
      if (pendingConfigId !== currentConfigId) return;
      cancelPendingDelta();
      setStatus('请求中…');
      setDot('on');
      outBox.classList.add('empty');
      outBox.textContent = '';
      resetDiag();
      return;
    }

    if (msg.type === 'delta') {
      // 和 start 同理：这条流是**别的配置**的，用户已经切走了，别往眼前这屏上涂
      if (pendingConfigId !== currentConfigId) return;
      queueDelta(msg.text);
      return;
    }

    /* ---- 截图 OCR 的三条消息（在翻译之前发生） ---- */

    if (msg.type === 'ocr-status') {
      setStatus(msg.message || '处理中…');
      return;
    }

    if (msg.type === 'ocr-error') {
      busy = false;
      retryBtn.disabled = false;
      cancelPendingDelta();
      outBox.classList.remove('empty');
      outBox.textContent = '';
      outBox.dataset.placeholder = '出错了';
      setStatus(msg.message || '截图识别失败', 'err');
      setDot('err');
      showDiag([{ k: '截图 OCR', v: msg.message || '截图识别失败', err: true }]);
      return;
    }

    if (msg.type === 'ocr-text') {
      const text = String(msg.text || '').trim();
      if (!text) {
        setStatus('没识别出文字', 'err');
        setDot('err');
        busy = false;
        retryBtn.disabled = false;
        return;
      }
      // 认出来的这段就是「原文」，接着走和划词一模一样的翻译链路 ——
      // 配置下拉、重新翻译、复制、诊断全都照常复用，不用另开一套。
      translate(text, cfgSelect.value || activeConfigId, {
        provider: msg.provider || 'OCR',
        ms: msg.ms,
        bytes: msg.bytes
      });
      return;
    }

    if (msg.type === 'ocr-image') {
      // 「禁用外置 OCR」模式：不做识别，图片直接塞进当前那条请求，
      // 由多模态模型自己看图 + 翻译（请求模板里用 {{image}} 引用它）
      translate('', cfgSelect.value || activeConfigId, {
        direct: true,
        image: msg.dataUrl,
        bytes: msg.bytes
      });
      return;
    }

    if (msg.type === 'done') {
      const r = msg.result || {};
      // 按「发出这条请求时选中的配置」归档，不是当前选中的那个 ——
      // 请求在飞的时候用户可能已经切到别的配置上了（见 cfgSelect 的 change）
      rememberResult(pendingConfigId, r, lastOcr, lastAction, false);
      if (pendingConfigId === currentConfigId) {
        // 必须先取消挂起的这一帧：done 往往在最后一个 delta 之后立刻到达，
        // 如果让那个 rAF 稍后执行，它会用更旧的文本把最终结果覆盖掉。
        renderResult(r, lastOcr, lastAction, false);
      } else {
        // 这次结果归另一个配置，只进缓存，别去动眼前这个配置的界面（切回去就能看到）
        cancelPendingDelta();
        busy = false;
        retryBtn.disabled = false;
        // 兜底：眼前这个配置连缓存都没有（正常到不了这儿 —— 切到没翻过的配置时
        // 会当场发新请求，而那条会把这条顶掉）
        if (!resultCache.has(currentConfigId)) showNoCachedResult(currentConfigId);
      }
      return;
    }

    if (msg.type === 'fatal') {
      const r = { error: msg.message || '出错了' };
      rememberResult(pendingConfigId, r, lastOcr, lastAction, true);
      if (pendingConfigId === currentConfigId) {
        renderResult(r, lastOcr, lastAction, true);
      } else {
        cancelPendingDelta();
        busy = false;
        retryBtn.disabled = false;
      }
    }
  }

  function renderConfigOptions() {
    cfgSelect.innerHTML = '';
    if (!configs.length) {
      const o = document.createElement('option');
      o.textContent = '（没有配置）';
      o.value = '';
      cfgSelect.appendChild(o);
      cfgSelect.title = '翻译接口';
      return;
    }
    for (const c of configs) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      cfgSelect.appendChild(o);
    }
    // 当前选中的配置可能已经被删了
    if (!configs.some((c) => c.id === currentConfigId)) {
      currentConfigId = activeConfigId && configs.some((c) => c.id === activeConfigId)
        ? activeConfigId
        : configs[0].id;
    }
    cfgSelect.value = currentConfigId;
    // 顶栏现在挤了两个下拉，长名字会被截掉 —— 鼠标停上去给全名
    const cur = configs.find((c) => c.id === currentConfigId);
    cfgSelect.title = cur ? '翻译接口：' + cur.name : '翻译接口';
  }

  /* 顶栏那个「目标语言」下拉的候选，由后台随 ready 一起发过来
     （content script 不能 import，别在这儿手抄一份 —— 加了语言就对不上了）。 */
  let targetLangs = [];

  function renderLangOptions() {
    const cur = String(prefs.targetLang || '简体中文');
    // 存档里的值不在候选里（手填的代码、老存档）：临时补一条顶上，**别**让下拉
    // 显示成别的语言 —— 那才是真的误导。用户挑走别的之后它自然就没了。
    const list = targetLangs.includes(cur) ? targetLangs.slice() : [cur].concat(targetLangs);
    langSelect.innerHTML = '';
    for (const name of list) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      langSelect.appendChild(o);
    }
    langSelect.value = cur;
    langSelect.title = '目标语言：' + cur;
  }

  /* ------------------------------------------------------------------ */
  /* 翻译                                                                */
  /* ------------------------------------------------------------------ */

  function translate(text, configId, ocr) {
    const limit = Number(prefs.maxChars) || 8000;
    let payload = String(text || '');
    let truncated = false;
    if (payload.length > limit) {
      payload = payload.slice(0, limit);
      truncated = true;
    }
    // 直传模式下没有原文（图片就是原文），空文本是合法的
    const hasImage = !!(ocr && ocr.image);
    if (!payload.trim() && !hasImage) return;

    lastOcr = ocr || null;
    // 截图那条路要记住是「截图来的」：直传模式下 currentText 是空串，
    // 一旦翻译失败，重试按钮得靠这个标记回去重读一遍剪切板。
    lastAction = ocr ? 'ocr' : 'translate';
    currentText = payload;
    currentConfigId = configId || cfgSelect.value || activeConfigId;
    pendingConfigId = currentConfigId;

    // 原文一变，所有配置的结果都快照过期了 —— 数据驱动地作废，不指望每个调用点记得清。
    // 直传（截图）模式没有文字原文，就拿图片的「长度 + 尾巴」当指纹。
    const key = hasImage
      ? '\u0001img|' + (ocr.image || '').length + '|' + (ocr.image || '').slice(-64)
      : payload;
    if (key !== cacheKey) {
      cacheKey = key;
      resultCache.clear();
    }

    busy = true;
    retryBtn.disabled = true;
    outBox.classList.remove('empty');
    outBox.textContent = '';
    outBox.dataset.placeholder = '等待结果…';

    // 原文区在直传模式下没有文字可放，就写一句它是怎么来的 ——
    // 空着的话用户会以为哪里坏了
    srcBox.textContent = hasImage
      ? '（这张截图直接发给了模型，没有先做外置 OCR）'
      : (payload.length > 400 ? payload.slice(0, 400) + ' …' : payload);
    syncSrcBtn();
    resetDiag();
    setStatus(
      hasImage ? '正在看图…' : (truncated ? `内容过长，已截断到 ${limit} 字` : '…'),
      !hasImage && truncated ? 'warn' : ''
    );
    setDot('on');
    // 原文区是**开面板之后**才填进去并显示出来的（showPanel 定位时它还是空的），
    // 这里让面板长高了几十像素 —— 不重新夹一次，贴着视口底部开的面板就会切底。
    keepPanelInView();

    const p = ensurePort();
    if (!p) {
      setStatus('扩展已更新，请刷新页面后重试', 'err');
      setDot('err');
      busy = false;
      retryBtn.disabled = false;
      return;
    }

    p.postMessage({
      type: 'translate',
      text: payload,
      configId: currentConfigId,
      context: {
        url: location.href,
        title: document.title,
        // 直传模式下这张图会变成请求模板里的 {{image}}
        image: hasImage ? ocr.image : ''
      }
    });
  }

  function openWith(text, anchor) {
    showPanel(anchor);
    hideTrigger();
    translate(text, cfgSelect.value || activeConfigId);
  }

  /** 右键点在哪儿 —— 右键菜单 API 不给坐标，只能自己记一个零大小的锚点 */
  function pointRect(x, y) {
    return { left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
  }

  /**
   * 截图翻译的入口（右键菜单里那条「翻译剪切板中的截图」）。
   *
   * 面板先开出来、状态先写上 —— 读剪切板加 OCR 要好几秒，中间什么都不显示
   * 的话用户会以为没反应，然后再点一次。
   * 真正的活在 background 那边：content script 读不到剪切板（CORS 也好、
   * 权限也好，都不在它手里），识别完再把文字送回来。
   */
  function startOcr(anchor) {
    mount();
    showPanel(anchor);
    hideTrigger();

    lastAction = 'ocr';
    lastOcrAnchor = anchor || null;
    lastOcr = null;
    currentText = '';
    busy = true;
    retryBtn.disabled = true;
    cancelPendingDelta();
    outBox.classList.remove('empty');
    outBox.textContent = '';
    outBox.dataset.placeholder = '等待识别…';
    srcBox.textContent = '';
    resetDiag();
    setStatus('正在读取剪切板…');
    setDot('on');

    const p = ensurePort();
    if (!p) {
      busy = false;
      retryBtn.disabled = false;
      setStatus('扩展已更新，请刷新页面后重试', 'err');
      setDot('err');
      return;
    }
    p.postMessage({ type: 'ocr' });
  }

  /* ------------------------------------------------------------------ */
  /* 划词监听                                                            */
  /* ------------------------------------------------------------------ */

  function isEditable(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    let hops = 0;
    while (el && hops < 4) {
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      el = el.parentElement;
      hops += 1;
    }
    return false;
  }

  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().trim();
    if (!text || text.length < 1) return null;
    if (isEditable(sel.anchorNode)) return null;

    let rect;
    let segments;
    try {
      const range = sel.getRangeAt(0);
      rect = range.getBoundingClientRect();
      segments = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
    } catch {
      return null;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    // 选中多行时，整段的框会把右边界对齐到最长那行，离鼠标（选区末尾）很远。
    // 所以取「第一行 / 最后一行」各自的矩形，贴着字放按钮。
    const tail = segments.length ? segments[segments.length - 1] : rect;
    let anchor = { rect: tail, side: 'after' };

    // 倒着拖选时鼠标停在选区开头，按钮就贴开头
    if (lastMouse && segments.length > 1) {
      const head = segments[0];
      const dist2 = (x, y) => (lastMouse.x - x) ** 2 + (lastMouse.y - y) ** 2;
      if (dist2(head.left, head.top) < dist2(tail.right, tail.bottom)) {
        anchor = { rect: head, side: 'before' };
      }
    }

    return { text, rect, tail, anchor };
  }

  function updateTrigger() {
    if (prefs.trigger === 'off') {
      hideTrigger();
      return;
    }
    const found = readSelection();
    if (!found) {
      hideTrigger();
      return;
    }

    if (prefs.trigger === 'auto') {
      hideTrigger();
      // 鼠标一动就重新触发，同一段文本短时间内只翻一次
      const now = Date.now();
      if (lastAuto.text === found.text && now - lastAuto.at < 900) return;
      lastAuto = { text: found.text, at: now };
      openWith(found.text, found.anchor.rect);
      return;
    }

    mount();
    // 显示前再按当前设置确认一遍外观。设置是**异步**读进来的，而 applyAppearance()
    // 在 IIFE 末尾就先按默认值跑过一次 —— 万一那次读得晚、或者中途哪一步抛错，
    // 按钮就会一直停在默认的「译」字上。放在这里最保险：用户看到的永远是当前设置。
    applyTriggerStyle();

    const k = 1 / zoom;
    const size = triggerSize() * k;
    const gap = 6 * k;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const seg = found.anchor.rect;

    let x;
    let y;
    if (found.anchor.side === 'after') {
      // 贴着最后一个字的右下角
      x = seg.right + gap;
      y = seg.bottom + gap;
      if (x + size > vw - gap) x = seg.left - size - gap;
      if (y + size > vh - gap) y = seg.top - size - gap;
    } else {
      x = seg.left - size - gap;
      y = seg.top - size - gap;
      if (x < gap) x = seg.right + gap;
      if (y < gap) y = seg.bottom + gap;
    }
    x = Math.max(gap, Math.min(x, vw - size - gap));
    y = Math.max(gap, Math.min(y, vh - size - gap));

    trigger.style.left = x + 'px';
    trigger.style.top = y + 'px';
    trigger.classList.add('show');
    trigger.dataset.pendingText = found.text;
    trigger.__anchor = found.anchor.rect;
  }

  function onSelectionMaybeChanged() {
    window.setTimeout(updateTrigger, 10);
  }

  document.addEventListener('mouseup', (e) => {
    if (e.composedPath && e.composedPath().includes(host)) return;
    lastMouse = { x: e.clientX, y: e.clientY };
    onSelectionMaybeChanged();
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.key === 'Escape' || e.shiftKey) onSelectionMaybeChanged();
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (e.composedPath && e.composedPath().includes(host)) return;
    hideTrigger();
  }, true);

  // 右键位置得自己记：contextMenus.onClicked 只给菜单项 id，不给坐标
  document.addEventListener('contextmenu', (e) => {
    if (e.composedPath && e.composedPath().includes(host)) return;
    lastRightClick = { x: e.clientX, y: e.clientY };
  }, true);

  window.addEventListener('scroll', hideTrigger, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('show')) {
      hidePanel();
    }
  }, true);

  trigger.addEventListener('mousedown', (e) => {
    // 保住页面选区，别让点击把选中内容清掉
    e.preventDefault();
    e.stopPropagation();
  });

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = trigger.dataset.pendingText || (readSelection() || {}).text || '';
    if (text) openWith(text, trigger.__anchor);
  });

  /* ------------------------------------------------------------------ */
  /* 面板交互                                                            */
  /* ------------------------------------------------------------------ */

  panel.querySelector('[data-act="close"]').addEventListener('click', hidePanel);

  srcBtn.addEventListener('click', () => {
    prefs.showOriginal = !prefs.showOriginal;
    syncSrcBtn();
    saveSetting('showOriginal', prefs.showOriginal);
    keepPanelInView();   // 原文区一露出来面板就变高了
  });

  moreBtn.addEventListener('click', () => {
    if (moreBtn.hidden) return;
    diagOpen = !diagOpen;
    diagBox.hidden = !diagOpen || diagBox.childElementCount === 0;
    keepPanelInView();   // 诊断区展开会让面板变高
  });

  retryBtn.addEventListener('click', () => {
    if (busy) return;
    // 截图那一步就失败时 currentText 还是空的，重试得重新去认一遍图
    if (!currentText) {
      if (lastAction === 'ocr') startOcr(lastOcrAnchor);
      return;
    }
    translate(currentText, currentConfigId);
  });

  copyBtn.addEventListener('click', async () => {
    const text = outBox.textContent || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus('已复制');
    } catch {
      // 有些页面剪贴板不可用，退回 execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setStatus('已复制'); } catch { setStatus('复制失败', 'err'); }
      ta.remove();
    }
  });

  cfgSelect.addEventListener('change', () => {
    currentConfigId = cfgSelect.value;
    // 翻过的 → 放回上次的结果，一个请求都不发；
    // 没翻过的 → 当场用这个配置翻一次（重发同一条请求是 ↻ 的活儿，不是这儿）
    const hit = resultCache.get(currentConfigId);
    if (hit) {
      renderResult(hit.r, hit.ocr, hit.action, hit.fatal);
      return;
    }
    // 截图直传那一路没有文字原文，判据得看图片；OCR 认出来的文字在 currentText 里
    if (currentText || (lastOcr && lastOcr.image)) {
      translate(currentText, currentConfigId, lastOcr || undefined);
      return;
    }
    showNoCachedResult(currentConfigId);
  });

  /* 顶栏换目标语言。语言是藏在请求模板里的（{{target}} / {{targetCode}}），
     换了它等于换了整条请求 —— 所以和「换配置」一个规矩：手上有原文就当场重翻，
     别让用户自己再点一次 ↻。 */
  langSelect.addEventListener('change', async () => {
    const v = langSelect.value;
    if (v === prefs.targetLang) return;
    prefs.targetLang = v;
    langSelect.title = '目标语言：' + v;
    // 缓存里每一条都是上一门语言的译文，全作废
    resultCache.clear();
    // **必须等写下去再发请求**：后台是从存档里读目标语言来渲染 <{{target}}> 的
    // （loadState 每次都现读），写没落盘就发，这一条会带着上一门语言出去。
    // 真踩过 —— e2e 里「换成英语但请求还是 ZH-HANS」抓到的就是这个。
    await saveSetting('targetLang', v);
    if (currentText || (lastOcr && lastOcr.image)) {
      translate(currentText, currentConfigId, lastOcr || undefined);
      return;
    }
    setStatus('目标语言：' + v);
  });

  // 拖动
  (() => {
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let px = 0;
    let py = 0;

    const head = panel.querySelector('[data-drag]');
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('.rt-btn') || e.target.closest('.rt-cfg') ||
          e.target.closest('.rt-lang')) return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      px = parseFloat(panel.style.left) || 0;
      py = parseFloat(panel.style.top) || 0;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // 和自动定位共用一套夹取：整个面板都得留在视口里，
      // 不能像以前那样允许拖到只剩 80×40 露在外面
      const p = clampPanel(px + e.clientX - sx, py + e.clientY - sy);
      panel.style.left = p.x + 'px';
      panel.style.top = p.y + 'px';
    }, true);

    window.addEventListener('mouseup', () => {
      dragging = false;
    }, true);
  })();

  /* ------------------------------------------------------------------ */
  /* 来自右键菜单的指令                                                  */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;

    // 用户按了 Ctrl + 加减号：重新补偿，别让面板跟着变大变小
    if (msg.type === 'rt-zoom' && typeof msg.zoom === 'number') {
      setZoom(msg.zoom);
      return;
    }

    if (msg.type !== 'rt-translate-selection') {
      // 右键菜单里那条「翻译剪切板中的截图」
      if (msg.type === 'rt-ocr-clipboard') {
        startOcr(lastRightClick ? pointRect(lastRightClick.x, lastRightClick.y) : null);
      }
      return;
    }
    const text = String(msg.text || '').trim();
    if (!text) return;
    const sel = window.getSelection();
    let rect = null;
    try {
      if (sel && sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch { /* 忽略 */ }
    openWith(text, rect);
  });

  /* ------------------------------------------------------------------ */
  /* 读取设置                                                            */
  /* ------------------------------------------------------------------ */

  function applyState(state) {
    if (!state) return;
    if (Array.isArray(state.configs)) configs = state.configs.map((c) => ({ id: c.id, name: c.name }));
    if (state.activeConfigId) activeConfigId = state.activeConfigId;
    const prevLang = prefs.targetLang;
    if (state.settings) prefs = { ...prefs, ...state.settings };
    // 目标语言变了（顶栏改的，或者设置页改的）：缓存里全是**上一门语言**的译文，
    // 和换原文一样当场作废 —— 否则切配置会把旧语言的译文端出来冒充当次的
    if (prevLang !== prefs.targetLang) resultCache.clear();
    if (!currentConfigId) currentConfigId = activeConfigId;
    renderConfigOptions();
    renderLangOptions();
    syncSrcBtn();
    applyAppearance();
    // 字号 / 面板尺寸变了，面板高度跟着变，可能就顶出视口了
    keepPanelInView();
    if (prefs.trigger === 'off') hideTrigger();
  }

  try {
    chrome.storage.local.get('state').then((raw) => applyState(raw && raw.state)).catch(() => {});
  } catch { /* 忽略 */ }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.state) return;
      applyState(changes.state.newValue);
    });
  } catch { /* 忽略 */ }

  mount();
  syncSrcBtn();
  applyAppearance();
  syncZoom();
})();
