/**
 * content script：划词 → 小圆点 → 结果面板
 * 全部 UI 放在 Shadow DOM 里，页面样式进不来，我们也不污染页面。
 * 真正的请求交给 background 发（页面里 fetch 会被 CORS 拦）。
 */

(() => {
  if (window.__requestTranslateInjected) return;
  window.__requestTranslateInjected = true;

  const HOST_ID = 'request-translate-host';
  if (document.getElementById(HOST_ID)) return;

  /* ---- 状态 ---- */

  let prefs = {
    trigger: 'button',
    triggerStyle: 'badge',
    triggerSize: 45,
    triggerSvg: '',
    triggerIdleSec: 5,
    triggerLeaveSec: 0.5,
    panelWidth: 460,
    panelHeight: 0,
    panelMaxHeight: 46,
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

  /* ---- 「图片直传」那一屏顶栏列哪一份配置 ---------------------------------
     勾了「禁用外置 OCR」之后，截图不再过 OCR，图片直接交给多模态模型翻。
     这时顶栏那个下拉必须**换成「能翻图的那些配置」**，不能还列着一堆纯文字接口
     （那些选上去只会把图发给看不懂图的接口）。它和设置页 OCR 栏的「图片配置」是
     **同一份数据、同一个选中项**：
       * 列表 = state.configs 里「图片请求模板」非空的那些（判据只有一个）；
       * 选中的 = state.ocr.imageConfigId。
     所以在面板里拨这个下拉 = 在设置页里改选中项，拨完要**写回存档**（后台是现读存档
     挑配置的，见 lib/store.js 的 pickRequestConfig）。 */
  /** 能翻图的配置（后台的 ready 和存档两条路都会刷新它） */
  let imageConfigs = [];
  /** = state.ocr.imageConfigId */
  let imageConfigId = '';
  /** 顶栏现在列的是哪一份：'text' 列全部，'image' 列能翻图的那些 */
  let cfgMode = 'text';

  /** 当前标签页的缩放比（1 = 100%）。面板与按钮要按这个值反向补偿，才不会被网页缩放带着一起变大变小 */
  let zoom = 1;
  /** 面板最近一次的定位锚点，缩放变化时用来重算位置 */
  let lastAnchor = null;
  /** 最近一次鼠标位置（mousemove / mouseup 都更新）。浏览器不提供「当前鼠标在哪儿」
      的查询接口 —— 坐标只挂在事件对象上，只能自己记一个。用它干两件事：按钮贴鼠标、
      以及「键盘改选区」时把它清掉（那会儿手里这个是旧坐标，会指到别处去）。 */
  let lastMouse = null;
  /** 最近一次右键的位置。右键菜单的 onClicked 不给坐标，面板只能记着用户点在哪儿 */
  let lastRightClick = null;
  /** 这次翻译是不是从截图来的（{provider, ms, bytes}）—— 状态栏和诊断里标出来 */
  let lastOcr = null;
  /** 最近一次动作：'ocr' 时「重新翻译」按钮要重跑识别，而不是重翻一段空文本 */
  let lastAction = '';
  /** 截图翻译时面板的落点，重试还要用 */
  let lastOcrAnchor = null;

  /* ---- 按钮预设 ---- */
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

  /* ---- 宿主节点 + 样式 ---- */

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
  padding: .6em .7em;
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

  /* ---- DOM ---- */

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

  /* ---- 外观：主题 / 字号 / 尺寸 ---- */

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

  /** 自适应时正文区的上限（vh，0 = 不限）。认不出的值退回 46 —— 和改动前那条 CSS 一样 */
  function panelMaxHeight() {
    const v = Number(prefs.panelMaxHeight);
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 46;
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

    // 只在自适应模式下有用（固定高度时上面那条 max-height: none 说了算）
    const mh = panelMaxHeight();
    panel.classList.toggle('no-max-h', mh === 0);
    panel.style.setProperty('--rt-max-h', mh + 'vh');
  }

  /* ---- 页面缩放补偿 ---- */
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

  /** 抄一份 rect。必须写成显式的六个字段：DOMRect 的 left/top/right/bottom 挂在原型上，
      `{ ...rect }` 只会抄到 x / y / width / height 四个，另外四个是 undefined。 */
  function copyRect(r) {
    if (!r) return null;
    return {
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      width: r.width, height: r.height
    };
  }

  function setZoom(next) {
    const z = Math.min(5, Math.max(0.25, Number(next) || 1));
    if (Math.abs(z - zoom) < 0.001) return;
    zoom = z;
    applyZoom();

    /* 位置得按新缩放重算一遍（间距、面板宽度在 CSS 像素里都跟着 1/zoom 变，夹取也要
       按新的视口算）。锚点**原样**拿去重算：标签页缩放只把视口尺寸改了，页面里元素的
       CSS 坐标一动不动（`window.innerWidth` 1170 → 780，而同一个字的 x 还是 104）。
       也**不重新去读选区** —— 鼠标划词时读出来的是鼠标位置，缩放一下面板就跳到鼠标那儿了。 */
    if (panel.classList.contains('show')) placePanel(lastAnchor);
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
    lightQuery.addEventListener('change', onSchemeChange);
  }

  /* ---- 位置 ---- */

  /** 面板 / 按钮与视口边缘的最小间距（物理像素，网页缩放后观感不变） */
  const EDGE = 12;

  /** 按钮贴鼠标时离指针的偏移（物理像素）。必须拉开一点：压着指针的话按钮一出现就
      命中 :hover，于是「鼠标停在按钮上不消失」永远为真，那个计时器再也没机会到点。 */
  const MOUSE_GAP = 14;

  /**
   * 把面板夹进视口，保证它**整个**都看得见。
   *
   * 坐标系容易搞错：面板是 fixed + `transform: scale(1/zoom)`，origin 在左上角 ——
   * 缩放**不会移动左上角**，所以 `left/top` 就是视觉左上角，但视觉宽高要乘 1/zoom
   * （`offsetWidth` 是不含 transform 的布局尺寸）。夹取要在视觉尺寸上算，否则一缩放右/下就错。
   * 面板比视口还大时没得选，只能贴左上角。
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
    // 存一份副本：锚点是 DOMRect（活在页面里），下次缩放要拿它重算位置
    if (anchor) lastAnchor = copyRect(anchor);

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

  /* ---- 面板开关 ---- */

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
    /* 藏起来就等于用户不要这个结果了 —— 明确告诉后台停手。
       后台只在收到新的 translate 时才 abort，这里藏了面板、请求还在跑完（OCR 那种慢的能跑几十秒）。 */
    if (port) {
      try {
        port.postMessage({ type: 'abort' });
      } catch {
        /* 端口已断开 */
      }
    }
  }

  /* ---- 按钮自动消失 ----
     三条规矩：出现之后鼠标一直不动，过 triggerIdleSec 秒就消失；鼠标停在按钮上时不算
     （人明显在看它）；从按钮上移开又没点，过 triggerLeaveSec 秒消失，移回去就作废。
     两个时间都在设置页里调，填 0 = 关掉那一项。 */
  let trigIdleTimer = null;
  let trigLeaveTimer = null;
  /** 鼠标现在是不是停在按钮上（由 mousemove 那个监听维护） */
  let trigHovered = false;
  /** 按钮最近一次出现的时刻 —— 刚出现那一下不算「停在按钮上」，见 mousemove 里的说明 */
  let trigShownAt = 0;

  function clearTriggerTimers() {
    if (trigIdleTimer) { clearTimeout(trigIdleTimer); trigIdleTimer = null; }
    if (trigLeaveTimer) { clearTimeout(trigLeaveTimer); trigLeaveTimer = null; }
  }

  /** 主计时：从「按钮出现」或「鼠标又动了一下」开始数。
      两个计时一起清 —— 显示之前残留的那个「移开短计时」要是不干掉，它到点会把刚
      显示出来的按钮顺手抹掉（实测：鼠标刚好从按钮上滑过之后重划一次就踩到了）。 */
  function armTriggerIdle() {
    clearTriggerTimers();
    const sec = Number(prefs.triggerIdleSec) || 0;
    trigIdleTimer = sec > 0 ? setTimeout(hideTrigger, sec * 1000) : null;
  }

  /** 鼠标从按钮上移开：走那个「很短的时间」；没配就退回主计时 */
  function armTriggerLeave() {
    clearTriggerTimers();
    const sec = Number(prefs.triggerLeaveSec) || 0;
    if (sec > 0) trigLeaveTimer = setTimeout(hideTrigger, sec * 1000);
    else armTriggerIdle();
  }

  function hideTrigger() {
    clearTriggerTimers();
    trigHovered = false;
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

  /* ---- 两种「铺界面」的公共骨架 ----------------------------------------
     「进忙碌态」和「报失败」在多处出现（翻译开场 / OCR 开场 / 截图开场失败 /
     结果失败 / OCR 失败）。各写一套的话，总线数一样，但改一处（比如多收一个诊断行、
     换个灯的状态）就容易漏。收在这里，调用方只管传差异项。 */

  /**
   * 进忙碌态：清空结果区、写占位、灯转「进行中」、重试按钮禁用。
   * 调用方各自再补与本次动作相关的部分（原文区怎么填、状态栏那句具体写什么）。
   *
   * @param {string}  placeholder 结果区空着时显示的灰字（「等待结果…」/「等待识别…」）
   * @param {string}  statusText  状态栏那句
   * @param {object}  [opts]
   * @param {string}  [opts.statusKind] 状态栏语气（'warn' 等），不传就是普通色
   * @param {boolean} [opts.clearSrc]   连原文区一起清空（OCR 开场要，翻译开场自己有内容要写）
   * @param {boolean} [opts.cancelDelta] 先掐掉正在排队的流式分片（OCR 开场要）
   */
  function enterBusy(placeholder, statusText, opts = {}) {
    if (opts.cancelDelta) cancelPendingDelta();
    busy = true;
    retryBtn.disabled = true;
    outBox.classList.remove('empty');
    outBox.textContent = '';
    outBox.dataset.placeholder = placeholder;
    if (opts.clearSrc) {
      srcBox.textContent = '';
      srcBox.classList.remove('has-img');
    }
    resetDiag();
    setStatus(statusText, opts.statusKind || '');
    setDot('on');
  }

  /* 退出忙碌态的完整仪式：取消挂起的流式渲染、放开重试按钮。
     曾经这组三连在 5 个函数里各手抄一遍（showFailure / renderResult / showNoCachedResult /
     done 和 fatal 的兜底分支）＋ portGone 一个两行变体 —— 收口不彻底，改一处漏一处
     （827 行那条注释当初担心的就是这事）。没有挂起渲染时 cancelPendingDelta 是空操作，
     portGone 里多调它也无害。 */
  function leaveBusy() {
    cancelPendingDelta();
    busy = false;
    retryBtn.disabled = false;
  }

  /**
   * 报失败：结果区换成一句错、灯转红、诊断里留一行原因。
   * 不进忙碌态、也不碰「原文区」—— 失败时原文照旧留在那儿给用户看。
   *
   * @param {string} why     写进状态栏、也写进诊断的那句原因
   * @param {object} [opts]
   * @param {string} [opts.diagKey]    诊断行的标题（默认「错误」）
   * @param {string} [opts.placeholder] 结果区的灰字（默认「出错了」）
   * @param {Array}  [opts.diag]       诊断行；不传就用 `[{k: diagKey, v: why}]`
   *                                   （「没返回内容」那条要摊整块 buildDiag，所以留个口子）
   */
  function showFailure(why, opts = {}) {
    leaveBusy();
    outBox.classList.remove('empty');
    outBox.textContent = '';
    outBox.dataset.placeholder = opts.placeholder || '出错了';
    setStatus(why, 'err');
    setDot('err');
    showDiag(opts.diag || [{ k: opts.diagKey || '错误', v: why, err: true }]);
  }

  /* ---- 顶部的「原文」开关 ---- */

  function syncSrcBtn() {
    const on = !!prefs.showOriginal;
    srcBox.classList.toggle('hidden', !on);
    srcBtn.classList.toggle('on', on);
    srcBtn.title = on ? '隐藏原文（当前显示中）' : '显示原文（当前隐藏中）';
  }

  /* 写存档的唯一入口：**读整个 state → 让调用方改一改 → 写回去**。
     串行化：连着写两次（比如快速点两下顶部那个「原文」按钮）两次读写会交错，
     后完成的那次可能写的是先发起的值 —— 落盘的设置就和界面上的不一样了。
     `mutate(st)` 返回 false 表示「这次不该写」（存档里没这块东西），直接跳过。 */
  let saveChain = Promise.resolve();

  function mutateState(mutate) {
    saveChain = saveChain.then(async () => {
      try {
        const raw = await chrome.storage.local.get('state');
        const st = raw && raw.state;
        if (!st || mutate(st) === false) return;
        await chrome.storage.local.set({ state: st });
      } catch {
        /* 存不下就算了，本次会话内已经生效 */
      }
    });
    return saveChain;
  }

  /** 把一项设置写回 storage —— 和设置页共用同一份 state */
  function saveSetting(key, value) {
    return mutateState((st) => {
      st.settings = { ...(st.settings || {}), [key]: value };
    });
  }

  /* 写 state.ocr.imageConfigId —— 面板在图片模式下拨顶栏那个下拉时改的就是它。
     和 saveSetting 共用一条链，免得两次「读-改-写」互相盖掉。
     **必须先写下去再发请求**：后台是 loadState() 现读存档挑配置的（同换目标语言那个坑）。 */
  function saveImageConfigId(id) {
    return mutateState((st) => {
      if (!st.ocr) return false;
      st.ocr.imageConfigId = id;
    });
  }

  /* ---- 底部「…」里的诊断 ---- */

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
    // 这次到底调了哪个模型 —— 从请求体（或地址）里读出来的那个名字。
    // 读不到就整行不显示（内置适配器没有请求文本），别写个「未知」占地方。
    if (r.model) rows.push({ k: '模型', v: r.model, hint: '这条请求里写的模型名（读的是请求体 / 地址，不是猜的）' });

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

  /* ---- 端口通信 ---- */

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
      /* 扩展更新/重载或 SW 被杀都会走到这儿 —— 不复位的话 busy 永远是 true、
         重试按钮永久禁用，这一屏没有任何恢复手段。只在忙碌时收场：
         空闲时 SW 回收不该把已有结果抹成报错。 */
      if (busy) portGone();
    });
    port.postMessage({ type: 'hello' });
    return port;
  }

  function ensurePort() {
    if (!port) connectPort();
    return port;
  }

  /** 拿到端口才发消息 —— 拿不到（扩展刚更新、端口还没连上）就报一句并放弃这次请求。
      四个发送点共用，省得每处都手写一遍 `if (!p) { portGone(); return; }`。 */
  function postOrFail(p, msg) {
    if (!p) {
      portGone();
      return false;
    }
    p.postMessage(msg);
    return true;
  }

  /* ---- 流式渲染 ---- */

  /* 实测（tools/perf-probe.mjs）：成本正比于「渲染次数 × 文本长度」，每渲染一次整块译文就要重新排版。
     试过无效的：合并两次强制布局、rAF 合并、原地改写文本节点 —— 分片间隔本身就接近刷新率，合并不了多少。
     唯一有效的杠杆是「少渲染几次」：50ms（约 20fps），实测布局开销 A 52→37ms / C 500分片 115→41ms /
     D 极端 435→136ms（−69%）。对慢速接口无副作用：分片间隔超过 50ms 时每个分片都立即渲染；
     结束时 done 立刻写最终文本，尾巴上不会少字。 */
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

  /* ---- 结果铺到界面上 / 按配置归档 ---- */

  /**
   * 把一次请求的结果铺到界面上。
   *
   * `done`、`fatal` 两条消息和「切回有缓存的配置」共用这一段 —— 三处各写一套的话，
   * 迟早有一套长歪（状态栏三段、灯、诊断都得跟着一起改）。
   * 所以这里连 busy / 重试按钮 也一并收口，调用方不用自己管。
   */
  function renderResult(r, ocr, action, fatal) {
    leaveBusy();
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

    const why = (r && r.error) || (fatal ? '出错了' : '没有拿到译文');
    showFailure(why, fatal
      ? {}
      : { placeholder: '没有返回内容', diag: buildDiag(r || {}) });
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
    leaveBusy();
    resetDiag();
    outBox.classList.remove('empty');
    outBox.textContent = '';
    outBox.dataset.placeholder = '点 ↻ 翻译';
    setDot('');
    setStatus(hit ? `已切到「${hit.name}」，点 ↻ 翻译` : '点 ↻ 翻译');
  }

  /* 吃一份配置列表：面板顶栏下拉用的 `configs`（带 img 标记）和图片模式专用的
     `imageConfigs` 一次算完 —— `ready` 和设置页推过来的 `applyState` 都走这里，
     两处各算一遍的话迟早只改一处（`imageCapable()` 是 content 侧的那份判据）。 */
  function applyConfigList(list) {
    configs = (list || []).map((c) => ({ id: c.id, name: c.name, img: !!c.img }));
    imageConfigs = configs.filter((c) => c.img).map((c) => ({ id: c.id, name: c.name }));
  }

  function onPortMessage(msg) {
    if (!msg) return;

    if (msg.type === 'ready') {
      applyConfigList(msg.configs);
      if (typeof msg.imageConfigId === 'string') imageConfigId = msg.imageConfigId;
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
      if (pendingConfigId !== shownConfigId()) return;
      cancelPendingDelta();
      // 同一条请求里 model 变量填了多行时，后台会逐个试 —— 每次开始试一个就带一句
      // statusText（形如「（Qwen3-32B）」）。只有一个 model（或没写 {{model}}）时它是空串，
      // 状态就还是老样子「请求中…」，看不出一丝变化。
      setStatus(msg.statusText ? `请求中…${msg.statusText}` : '请求中…');
      setDot('on');
      outBox.classList.add('empty');
      outBox.textContent = '';
      resetDiag();
      return;
    }

    if (msg.type === 'delta') {
      // 和 start 同理：这条流是**别的配置**的，用户已经切走了，别往眼前这屏上涂
      if (pendingConfigId !== shownConfigId()) return;
      queueDelta(msg.text);
      return;
    }

    /* ---- 截图 OCR 的三条消息（在翻译之前发生） ---- */

    if (msg.type === 'ocr-status') {
      setStatus(msg.message || '处理中…');
      return;
    }

    if (msg.type === 'ocr-error') {
      showFailure(msg.message || '截图识别失败', { diagKey: '截图 OCR' });
      return;
    }

    if (msg.type === 'ocr-text') {
      const text = String(msg.text || '').trim();
      if (!text) {
        setStatus('没识别出文字', 'err');
        setDot('err');
        leaveBusy();
        return;
      }
      // 认出来的这段就是「原文」，接着走和划词一模一样的翻译链路 ——
      // 配置下拉、重新翻译、复制、诊断全都照常复用，不用另开一套。
      // 挑哪条交给 translate（它会先按模式重画下拉再读值）—— 这里别传下拉的当前值
      translate(text, '', {
        provider: msg.provider || 'OCR',
        ms: msg.ms,
        bytes: msg.bytes
      });
      return;
    }

    if (msg.type === 'ocr-image') {
      /* 「禁用外置 OCR」：不做识别，图片直接塞进当前那条请求，由多模态模型自己看图 + 翻译。
         配置 id **不传** —— translate 会先按「这一屏是图」切到「图片配置」那一份，
         再用它的选中项（= 存档里的 state.ocr.imageConfigId，后台认的也是它）。 */
      translate('', '', {
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
      if (pendingConfigId === shownConfigId()) {
        // 必须先取消挂起的这一帧：done 往往在最后一个 delta 之后立刻到达，
        // 如果让那个 rAF 稍后执行，它会用更旧的文本把最终结果覆盖掉。
        renderResult(r, lastOcr, lastAction, false);
      } else {
        // 这次结果归另一个配置，只进缓存，别去动眼前这个配置的界面（切回去就能看到）
        leaveBusy();
        // 兜底：眼前这个配置连缓存都没有（正常到不了这儿 —— 切到没翻过的配置时
        // 会当场发新请求，而那条会把这条顶掉）
        if (!resultCache.has(shownConfigId())) showNoCachedResult(shownConfigId());
      }
      return;
    }

    if (msg.type === 'fatal') {
      const r = { error: msg.message || '出错了' };
      rememberResult(pendingConfigId, r, lastOcr, lastAction, true);
      if (pendingConfigId === shownConfigId()) {
        renderResult(r, lastOcr, lastAction, true);
      } else {
        leaveBusy();
      }
    }
  }

  /* 一条配置能不能翻图 —— 判据只有一个：**轮换链里随便哪一条的图片请求模板非空**
     （主请求，或者某条勾上的后备请求）。和设置页 OCR 栏那份「图片配置」列表、
     后台 `lib/store.js` 的 `canTranslateImage` 是同一件事
     （content script 不能 import，只能在这儿再写一遍）。 */
  function imageCapable(c) {
    if (!c) return false;
    /* 口径必须和 `canTranslateImage`（requestChain）一致：主请求被取消勾选时**不算数** ——
       链里根本没有它。这份镜像少一个条件，两边的「图片配置」列表就会跟着
       「最后一次 storage 变化」漂（设置页说不能翻图、面板说能）。 */
    const on = [
      ...(c.mainEnabled !== false ? [c] : []),
      ...(Array.isArray(c.fallbacks) ? c.fallbacks.filter((f) => f.enabled !== false) : [])
    ];
    // 一条都没勾时 requestChain 会退回第一条 —— 这里跟着退，别让两边各说各话
    if (!on.length && c) on.push(c);
    return on.some((r) => !!String(r.imageRequest || '').trim());
  }

  /* 面板此刻「用的是哪条」= 顶栏那个下拉显示的那条。
     两个模式各记各的：文字用 currentConfigId，图片用 imageConfigId
     （后者和设置页 OCR 栏那个选中项是同一个，翻图那一下不该改掉你文字用哪条）。 */
  function shownConfigId() {
    return cfgMode === 'image' && imageConfigs.length > 0 ? imageConfigId : currentConfigId;
  }

  function renderConfigOptions() {
    /* 图片那一屏列表 = 能翻图的那些；一条都没填就退回全量 ——
       那时后台也会回退到顶栏当前那条（老行为），下拉跟着如实显示，别装。 */
    const imgMode = cfgMode === 'image' && imageConfigs.length > 0;
    const list = imgMode ? imageConfigs : configs;

    cfgSelect.innerHTML = '';
    if (!list.length) {
      const o = document.createElement('option');
      o.textContent = '（没有配置）';
      o.value = '';
      cfgSelect.appendChild(o);
      cfgSelect.title = '翻译接口';
      return;
    }
    for (const c of list) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      cfgSelect.appendChild(o);
    }

    // 选中的那条可能已经被删了 / 图片模板被清空了 → 挑一条顶上，别让选中项悬空
    let want = imgMode ? imageConfigId : currentConfigId;
    if (!list.some((c) => c.id === want)) {
      want = imgMode
        ? list[0].id
        : (activeConfigId && list.some((c) => c.id === activeConfigId) ? activeConfigId : list[0].id);
    }
    // 两个模式各记各的：翻图那一下不该顺手改掉「文字用哪条」。
    // 顶栏显示的就是当前这一屏要用的那条，两者靠 shownConfigId() 分辨。
    if (imgMode) imageConfigId = want;
    else currentConfigId = want;
    cfgSelect.value = want;

    // 顶栏现在挤了两个下拉，长名字会被截掉 —— 鼠标停上去给全名。
    // 图片模式但一条都没填时，把「为什么没缩成一小撮」写在 tooltip 里。
    const cur = list.find((c) => c.id === want);
    const who = cur ? cur.name : '';
    if (cfgMode !== 'image') {
      cfgSelect.title = cur ? '翻译接口：' + who : '翻译接口';
    } else if (imageConfigs.length) {
      cfgSelect.title = '图片接口：' + who;
    } else {
      cfgSelect.title =
        '还没有任何配置填过「图片请求模板」——去设置页的「配置」栏给能看图的那条填上，' +
        '它才会出现在这个列表里。现在用的是「' + who + '」';
    }
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

  /* ---- 翻译 ---- */

  const DIRECT_SRC_NOTE = '（这张截图直接发给了模型，没有先做外置 OCR）';

  /**
   * 直传那一屏：把截的图贴到原文区。
   * 页面的 CSP 可能挡住 data: 图，`error` 一到就退回那句说明 —— 说明不能丢，
   * 它是「这段原文为什么是张图」的唯一交代。
   */
  function renderSrcImage(dataUrl) {
    srcBox.textContent = '';
    srcBox.classList.add('has-img');
    const img = document.createElement('img');
    img.className = 'rt-srcimg';
    img.alt = '截取的图';
    img.addEventListener('error', () => {
      img.remove();
      srcBox.classList.remove('has-img');
      srcBox.textContent = DIRECT_SRC_NOTE;
    });
    img.src = dataUrl;
    const note = document.createElement('div');
    note.textContent = DIRECT_SRC_NOTE;
    srcBox.append(img, note);
  }

  function translate(text, configId, ocr) {
    // Math.max 兜负数（负的 limit 会把 slice(0, -n) 变成从尾部倒砍），与 background 同一口径
    const limit = Math.max(1, Number(prefs.maxChars) || 8000);
    let payload = String(text || '');
    let truncated = false;
    if (payload.length > limit) {
      payload = payload.slice(0, limit);
      truncated = true;
    }
    // 直传模式下没有原文（图片就是原文），空文本是合法的
    const hasImage = !!(ocr && ocr.image);
    if (!payload.trim() && !hasImage) return;

    // 顶栏那个下拉现在该列哪一份：拿图去翻 → 换成「图片配置」那一份（同设置页 OCR 栏）。
    // **必须在挑配置之前切** —— 不然会拿着上一次那条文字配置发出去。
    const nextMode = hasImage ? 'image' : 'text';
    if (cfgMode !== nextMode) {
      cfgMode = nextMode;
      renderConfigOptions();
    }

    lastOcr = ocr || null;
    // 截图那条路要记住是「截图来的」：直传模式下 currentText 是空串，
    // 一旦翻译失败，重试按钮得靠这个标记回去重读一遍剪切板。
    lastAction = ocr ? 'ocr' : 'translate';
    currentText = payload;

    /* 挑哪条：调用方**别传**「从下拉里读出来的那个值」—— 模式刚切过，那个值可能是
       上一屏的。上面已经按模式重画过下拉了，这里直接读它就是对的。 */
    const picked = configId || cfgSelect.value || activeConfigId;
    // 两个模式各记各的：图片那一屏记的是 imageConfigId（= 设置页那个选中项），
    // 别让它把「文字用哪条」顶掉。
    if (cfgMode === 'image' && imageConfigs.length > 0) imageConfigId = picked;
    else currentConfigId = picked;
    pendingConfigId = picked;

    // 原文一变，所有配置的结果都快照过期了 —— 数据驱动地作废，不指望每个调用点记得清。
    // 直传（截图）模式没有文字原文，就拿图片的「长度 + 尾巴」当指纹。
    const key = hasImage
      ? '\u0001img|' + (ocr.image || '').length + '|' + (ocr.image || '').slice(-64)
      : payload;
    if (key !== cacheKey) {
      cacheKey = key;
      resultCache.clear();
    }

    // 状态栏那句随「是不是截图 / 有没有截断」变，先算好再交给公共骨架
    enterBusy(
      '等待结果…',
      hasImage ? '正在看图…' : (truncated ? `内容过长，已截断到 ${limit} 字` : '…'),
      { statusKind: !hasImage && truncated ? 'warn' : '' }
    );

    // 原文区：直传时原文就是那张图，贴图（OCR 中转时原文是认出来的文字，照旧）
    if (hasImage) renderSrcImage(ocr.image);
    else {
      srcBox.classList.remove('has-img');
      srcBox.textContent = payload.length > 400 ? payload.slice(0, 400) + ' …' : payload;
    }
    syncSrcBtn();
    // 原文区是**开面板之后**才填进去并显示出来的（showPanel 定位时它还是空的），
    // 这里让面板长高了几十像素 —— 不重新夹一次，贴着视口底部开的面板就会切底。
    keepPanelInView();

    const p = ensurePort();
    postOrFail(p, {
      type: 'translate',
      text: payload,
      configId: picked,
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
    // 同上：别传下拉的当前值 —— 上一次可能是「图片那一屏」，值不是文字那条
    translate(text, '');
  }

  /** 右键点在哪儿 —— 右键菜单 API 不给坐标，只能自己记一个零大小的锚点 */
  function pointRect(x, y) {
    return { left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
  }

  /**
   * 「等一张图来翻译」的公共开场：面板先开出来、状态先写上 —— 读剪切板加 OCR 要好几秒，
   * 中间什么都不显示的话用户会以为没反应、再点一次。
   * 真正的活在 background（content script 读不到剪切板）。框选截图和剪切板截图两条路共用。
   * 返回端口（可能是 null —— 扩展刚更新过，页面还是旧脚本）。
   */
  function beginOcrPanel(anchor, statusText) {
    mount();
    showPanel(anchor);
    hideTrigger();

    lastAction = 'ocr';
    lastOcrAnchor = anchor || null;
    lastOcr = null;
    currentText = '';
    // 掐掉上一屏排队的流式分片 + 连原文区一起清（OCR 开场没有原文可留）
    enterBusy('等待识别…', statusText, { cancelDelta: true, clearSrc: true });

    /* 打断还在跑的翻译流：后台只在收到新的 translate 时才 abort，识别中的面板会被
       旧翻译的 delta 涂回旧译文、旧 done 还会把忙碌态提前复位成「翻译成功」——
       面板已经切到 OCR 屏了，旧结果谁都不要了，跟 hidePanel 同一个理由。 */
    if (port) {
      try {
        port.postMessage({ type: 'abort' });
      } catch {
        /* 端口已断开 */
      }
    }

    return ensurePort();
  }

  /** 端口连不上（扩展更新过、页面还是旧脚本）时的统一收场 */
  function portGone() {
    leaveBusy();
    setStatus('扩展已更新，请刷新页面后重试', 'err');
    setDot('err');
  }

  /** 剪切板那条路的入口：图从剪切板来，background 负责读 */
  function startOcr(anchor) {
    const p = beginOcrPanel(anchor, '正在读取剪切板…');
    postOrFail(p, { type: 'ocr' });
  }

  /**
   * 重试「截图那一步就失败」的那一屏（含直传）：要的是**重发刚才那张图**。
   * 图在哪：直传那张 content 自己存着（lastOcr.image，见 translate），本地重发；
   * OCR 那两条路（剪切板 / 框选）图在后台手里，发 reuse 让它接着用上一次那张 ——
   * 那时候再去读剪切板就是错的了（用户可能早复制了别的东西）。
   */
  function retryShot() {
    if (lastOcr && lastOcr.direct && lastOcr.image) {
      translate('', '', { direct: true, image: lastOcr.image, bytes: lastOcr.bytes });
      return;
    }
    const p = beginOcrPanel(lastOcrAnchor, '正在重试…');
    postOrFail(p, { type: 'ocr', reuse: true });
  }

  /* ---- 框选截图 ---- */
  /* 右键「框选截图翻译」：background 已经把视口截成一张图发过来（截图必须
     赶在菜单点击那次手势里做），这里盖一层遮罩让用户拖框，框完把选区从图上
     裁下来，走和剪切板截图同一条 OCR 链。
     遮罩里铺的就是那张截图：框里是定格画面、框外压暗，所见即所选。
     Esc / 右键 / 空点（没拖动）都是取消，不发请求。
     缩放与高分屏不用单独换算：截图是「CSS 视口 × 页面缩放 × 设备像素比」
     那么大，按 naturalWidth / 渲染宽度算一个比例一次到位。 */

  let shotHost = null;

  function closeShot() {
    if (shotHost) {
      if (typeof shotHost.__rtFinish === 'function') shotHost.__rtFinish();
      else shotHost.remove();
      shotHost = null;
    }
  }

  function startShot(dataUrl, error) {
    closeShot();

    // 截图那一步就失败了（chrome://、商店页这类页面截不了）。面板照开，把原因写进状态栏
    if (error) {
      mount();
      showPanel(null);
      hideTrigger();
      showFailure('截图失败：' + error);
      return;
    }
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return;

    /* 覆盖层**不铺截图**，只铺一层压暗的挖洞（`.veil` 那条超大 box-shadow）。
       页面就在下面、原样可见 —— 用户看到的是「直接对着页面框」，不是「先截一张再框」。
       位图只在**松手那一刻**才用来裁出框里那块（见 pointerup）。
       好处是框选期间还能滚页面 / 翻页，裁到的永远是**松手时那一屏**的对应区域。
       代价是动态内容（视频 / 轮播）在拖框期间会动 —— 和系统截屏工具一样。 */
    const SHOT_TIP = '拖动框选要翻译的区域（可滚动页面）· Esc 或右键取消';
    const hostEl = document.createElement('div');
    hostEl.setAttribute('data-rt-shot', '');
    hostEl.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML = `
<style>
  * { box-sizing: border-box; }
  /* 这层才是**真正接住鼠标**的东西：铺满整屏、透明、可命中。
     不能用 box-shadow 那层当命中面 —— box-shadow 不参与命中测试，
     而且它自己写的是 pointer-events:none（挖洞要求它不能挡住页面）。
     所以「压暗」和「接指针」必须拆成两层。 */
  .veil {
    position: fixed; inset: 0;
    cursor: crosshair;
    background: rgba(0, 0, 0, .45);
  }
  .sel {
    position: fixed; display: none;
    box-shadow: 0 0 0 100000px rgba(0, 0, 0, .45);
    border: 1px solid #a855f7;
    pointer-events: none;
  }
  .tip {
    position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
    background: rgba(15, 15, 17, .92); color: #e8e8ea;
    border: 1px solid #2b2b33; border-radius: 8px;
    padding: 7px 14px; font: 13px/1.4 system-ui, sans-serif;
    pointer-events: none; white-space: nowrap;
  }
</style>
<div class="veil"></div>
<div class="sel"></div>
<div class="tip">${SHOT_TIP}</div>
`;
    const sel = root.querySelector('.sel');

    const finish = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', onCtx, true);
      hostEl.remove();
      if (shotHost === hostEl) shotHost = null;
    };
    hostEl.__rtFinish = finish;

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish();
      }
    };
    // 遮罩上右键 = 取消；这会儿弹浏览器菜单没有意义
    const onCtx = (e) => {
      e.preventDefault();
      e.stopPropagation();
      finish();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onCtx, true);

    const normRect = (a, b) => ({
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y)
    });
    const moveSel = (cur) => {
      const r = normRect(start, cur);
      // 夹在视口内：拖到窗口外时不至于框住看不见的地方
      sel.style.left = r.left + 'px';
      sel.style.top = r.top + 'px';
      sel.style.width = Math.min(r.width, window.innerWidth - r.left) + 'px';
      sel.style.height = Math.min(r.height, window.innerHeight - r.top) + 'px';
    };

    let start = null;

    /* 事件挂在 **hostEl**（一个真实、可命中的元素）上，不挂 shadow root ——
       shadow root 不是事件目标，绑在上面只有当事件从内部某个**可命中元素**冒泡上来才触发。
       以前内部唯一铺满的那层写的是 pointer-events:none，于是「按住拖框」这条路一直是断的
       （脚本直接派发事件能过，真人点不到）。现在有 .veil 兜底，
       但监听仍挂在 hostEl 上更稳：起点在遮罩内、终点拖到遮罩外的场景也不丢事件。 */
    hostEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      sel.style.display = 'block';
      moveSel({ x: start.x, y: start.y });
      // 把后续 pointermove / pointerup 都锁到 hostEl，拖到窗口外也能收到 up
      try { hostEl.setPointerCapture(e.pointerId); } catch { /* 有些环境不支持，不影响主线 */ }
      e.preventDefault();
      e.stopPropagation();
    });
    hostEl.addEventListener('pointermove', (e) => {
      if (start) moveSel({ x: e.clientX, y: e.clientY });
    });
    hostEl.addEventListener('pointerup', (e) => {
      if (!start || e.button !== 0) return;
      const rect = normRect(start, { x: e.clientX, y: e.clientY });
      start = null;
      try { hostEl.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
      // 没怎么拖就松手：当误触，整个取消
      if (rect.width < 4 || rect.height < 4) {
        finish();
        return;
      }
      // 先把覆盖层拆掉：再把图喂给 OCR 的时候用户可以继续翻页面
      const anchorRect = {
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        width: rect.width,
        height: rect.height
      };
      finish();

      cropShot(dataUrl, rect).then((cropped) => {
        if (!cropped) {
          /* 直接在面板上报失败（beginOcrPanel 已让它进忙碌态，showFailure 负责退出去）。
             曾经这里是给后台发 { type: 'ocr-error' } —— 后台根本没有那个 handler，
             消息被静默丢掉，面板就卡死在忙碌态（「裁图失败」四个字谁都看不见）。 */
          const p = beginOcrPanel(anchorRect, '截图失败');
          // 端口没连上时 showFailure 没人送，busy 已经被 beginOcrPanel 置上 —— 得有兜底
          if (p) showFailure('裁图失败');
          else portGone();
          return;
        }
        postOrFail(beginOcrPanel(anchorRect, '正在识别截图…'), { type: 'ocr', dataUrl: cropped });
      });
    });

    (document.documentElement || document.body).appendChild(hostEl);
    shotHost = hostEl;
  }

  /** 从整块可见区域的位图里裁出 rect（视口 CSS 坐标）那一块。
      captureVisibleTab 的位图 = **整块可见区域 × dpr**，含页面自己那条滚动条；
      而 rect 是在**内容区**坐标系里量的（不含滚动条）。所以先把右边/下边那一条切掉，
      比例再按「位图 − 那一条」算。没有滚动条时 cutX / cutY 都是 0 —— 等于没动。 */
  function cropShot(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const dpr = img.naturalWidth / Math.max(1, window.innerWidth) || 1;
        const cutX = Math.max(0, Math.round((window.innerWidth - document.documentElement.clientWidth) * dpr));
        const cutY = Math.max(0, Math.round((window.innerHeight - document.documentElement.clientHeight) * dpr));
        const srcW = Math.max(1, img.naturalWidth - cutX);
        const srcH = Math.max(1, img.naturalHeight - cutY);
        const viewW = Math.max(1, document.documentElement.clientWidth);
        const viewH = Math.max(1, document.documentElement.clientHeight);
        const kx = srcW / viewW;
        const ky = srcH / viewH;
        const sx = Math.max(0, Math.min(Math.round(rect.left * kx), srcW - 1));
        const sy = Math.max(0, Math.min(Math.round(rect.top * ky), srcH - 1));
        const sw = Math.max(1, Math.min(Math.round(rect.width * kx), srcW - sx));
        const sh = Math.max(1, Math.min(Math.round(rect.height * ky), srcH - sy));
        const cvs = document.createElement('canvas');
        cvs.width = sw;
        cvs.height = sh;
        try {
          cvs.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
          resolve(cvs.toDataURL('image/png'));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  /* ---- 划词监听 ---- */

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

  /**
   * 「活动那一端」的光标位置 —— 键盘扩展选区（Shift+方向键 / Shift+Home…）时贴它。
   * 键盘改选区的那一刻，手里的 lastMouse 是上一次鼠标动作留下的**旧坐标**，拿它当锚点
   * 会指到页面别处去；选区自己知道光标在哪：focusNode / focusOffset 就是正在动的这一端。
   * 拿不到（Shadow DOM 里几何量全丢那个形态）返回 null，交给调用方兜底。
   */
  function caretRect(sel) {
    if (!sel || !sel.rangeCount || !sel.focusNode) return null;
    try {
      const r = document.createRange();
      r.setStart(sel.focusNode, sel.focusOffset);
      r.collapse(true);
      const b = r.getBoundingClientRect();
      // 全 0 = 量不到，别把它当成「左上角有个光标」
      if (!b || (b.width === 0 && b.height === 0)) return null;
      return b;
    } catch {
      return null;
    }
  }

  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    // 判据是「选中了文字没有」，不是 isCollapsed。Shadow DOM（Web Component，
    // 比如 B 站评论区的 <bili-comments>）里划词时，选区被重定目标到 document 层：
    // isCollapsed 会是 true，但 toString() 照样能拿到文字 —— 拿 isCollapsed 挡会误杀。
    const text = sel.toString().trim();
    if (!text || text.length < 1) return null;
    // 注意：同一套重定目标也发生在 anchorNode 上（拿到的是 Shadow 外面的节点），
    // 所以 Shadow DOM 内部的输入框认不出来 —— 认不出就放行，宁可多弹一次。
    if (isEditable(sel.anchorNode)) return null;

    // 鼠标划词：按钮直接贴鼠标，一个字节的选区几何量都不看。
    // 以前是从选区里挑「第一行 / 最后一行」再挑离鼠标近的那一头 —— 一拖一大段、或者
    // 那一行特别长的时候（双击选段、页面元素多、在空旷处上下划），挑出来的角离鼠标
    // 还是很远，得再把鼠标挪过去点。鼠标位置既不怕整段框对到最长那行，也不怕重定目标。
    if (lastMouse) {
      return { text, atMouse: true, anchor: { rect: pointRect(lastMouse.x, lastMouse.y) } };
    }

    let rect;
    let segments;
    try {
      const range = sel.getRangeAt(0);
      rect = range.getBoundingClientRect();
      segments = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
    } catch {
      return null;
    }

    // 几何量全丢（Shadow DOM 里划词：rect 全 0、clientRects 空）—— 上面又没有鼠标位置
    // 可用，贴哪儿都不知道，只能放弃。
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    // 键盘扩展选区：贴「光标那一行」的角
    const care = caretRect(sel);
    if (care) return { text, anchor: { rect: care } };

    // 兜底：贴最后一行末尾
    const tail = segments.length ? segments[segments.length - 1] : rect;
    return { text, anchor: { rect: tail } };
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
    if (found.atMouse) {
      // 贴在指针的右下方，右下角放不下就整块翻到左上（翻过去同样离指针 MOUSE_GAP，
      // 指针始终不在按钮里）
      const off = MOUSE_GAP * k;
      x = seg.left + off;
      y = seg.bottom + off;
      if (x + size > vw - gap) x = seg.left - size - off;
      if (y + size > vh - gap) y = seg.bottom - size - off;
    } else {
      // 贴着光标（或最后一行）的右下角，放不下就翻到左上
      x = seg.right + gap;
      y = seg.bottom + gap;
      if (x + size > vw - gap) x = seg.left - size - gap;
      if (y + size > vh - gap) y = seg.top - size - gap;
    }
    x = Math.max(gap, Math.min(x, vw - size - gap));
    y = Math.max(gap, Math.min(y, vh - size - gap));

    trigger.style.left = x + 'px';
    trigger.style.top = y + 'px';
    trigger.classList.add('show');
    trigShownAt = Date.now();
    armTriggerIdle();
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

  // 鼠标位置只能从事件里自己记（浏览器没有「查当前鼠标在哪」的接口）。
  // 光靠 mouseup 不够用：双击选段、Shift+点击、以及键盘改选区之后，手里那个坐标都是旧的。
  // 按钮那两个计时也挂在这儿 —— 别拆成 mouseenter / mouseleave：指针从按钮上移开时浏览器
  // 是 `mouseleave` 之后紧跟一个 `mousemove`，那个 mousemove 会顺手把「移开短计时」清掉
  // （于是「移开才消失」永远不生效）。一个事件源自己判断在不在按钮上，就没这个次序问题。
  document.addEventListener('mousemove', (e) => {
    lastMouse = { x: e.clientX, y: e.clientY };
    if (!trigger.classList.contains('show')) return;

    if (e.composedPath && e.composedPath().includes(trigger)) {
      // 停在按钮上 = 人明显在看它，不计时。刚显示的那一下不算（按钮理论上不会压在指针
      // 底下，贴鼠标留了 MOUSE_GAP、翻边也留了；只有视口小到夹取兜不住时才可能）
      if (Date.now() - trigShownAt < 250) return;
      trigHovered = true;
      clearTriggerTimers();
      return;
    }
    // 从按钮上移开（刚才还停在上面）→ 走那个「很短的时间」；否则就是鼠标在动 → 重新起算
    if (trigHovered) { trigHovered = false; armTriggerLeave(); return; }
    // 已经在「移开」的倒计时里了：指针继续往别处走，别拿主计时把它盖掉。
    // 指针离开按钮是一**串** mousemove，不是一下 —— 盖掉的话「移开就消失」就变成
    // 按主计时消失了（kniph 实测：「移开后用的还是按钮自动消失时间」）。
    if (trigLeaveTimer) return;
    armTriggerIdle();
  }, { capture: true, passive: true });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.key === 'Escape' || e.shiftKey) {
      // 键盘改的选区：鼠标坐标是上一次动作留下的旧值，清掉它，让按钮去贴光标那一行
      if (e.key !== 'Escape') lastMouse = null;
      onSelectionMaybeChanged();
    }
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

  /* ---- 面板交互 ---- */

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
    // 截图那一步就失败（含直传）时 currentText 还是空的，重试得拿刚才那张图重来一遍
    if (!currentText) {
      retryShot();
      return;
    }
    translate(currentText, shownConfigId());
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

  cfgSelect.addEventListener('change', async () => {
    const v = cfgSelect.value;
    /* 图片那一屏：这个下拉就是设置页 OCR 栏「图片配置」列表的另一个入口，
       拨一下等于在设置页里改选中项 —— **先写回存档再发请求**，后台只认
       state.ocr.imageConfigId（见 lib/store.js 的 pickRequestConfig）。
       不写回的话就会出现「拨了没反应，翻出来还是设置里那条」。 */
    if (cfgMode === 'image' && imageConfigs.length > 0) {
      imageConfigId = v;
      renderConfigOptions();   // 标题 / 选中项跟着换
      await saveImageConfigId(v);
    } else {
      currentConfigId = v;
    }
    // 翻过的 → 放回上次的结果，一个请求都不发；
    // 没翻过的 → 当场用这个配置翻一次（重发同一条请求是 ↻ 的活儿，不是这儿）
    const hit = resultCache.get(shownConfigId());
    if (hit) {
      renderResult(hit.r, hit.ocr, hit.action, hit.fatal);
      return;
    }
    // 截图直传那一路没有文字原文，判据得看图片；OCR 认出来的文字在 currentText 里
    if (currentText || (lastOcr && lastOcr.image)) {
      translate(currentText, shownConfigId(), lastOcr || undefined);
      return;
    }
    showNoCachedResult(shownConfigId());
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
      translate(currentText, shownConfigId(), lastOcr || undefined);
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

  /* ---- 来自右键菜单的指令 ---- */

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
      // 右键菜单里那条「框选截图翻译」：图已经截好了，这里负责框选
      if (msg.type === 'rt-shot-translate') {
        startShot(msg.dataUrl, msg.error);
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

  /* ---- 读取设置 ---- */

  function applyState(state) {
    if (!state) return;
    if (Array.isArray(state.configs)) {
      // img 得在这儿现算：设置页里刚填/刚清掉「图片请求模板」时，面板要跟着变
      // （ready 只在连端口那一刻发一次，靠它就会停在旧的一版）
      applyConfigList(state.configs.map((c) => ({ ...c, img: imageCapable(c) })));
    }
    if (state.ocr) imageConfigId = String(state.ocr.imageConfigId || '');
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
