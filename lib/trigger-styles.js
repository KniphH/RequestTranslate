/**
 * 划词按钮的样式预设 + 样式表
 * ------------------------------------------------------------------
 * 这里放四样东西：
 *   1. TRIGGER_STYLES      —— 预设清单（图标 + 名字），设置页拿它渲染选择卡
 *   2. TRIGGER_CSS         —— 按钮的样式表。content.js 会把它塞进 shadow DOM，
 *                             设置页会把它塞进预览的 shadow root，两边共用同一份
 *   3. SVG_GUARDS          —— 用户自填图标（一段 <svg>）的安全检查，见下方注释
 *   4. TRIGGER_SVG_SAMPLE  —— 示例图标，「自定义」预设没填图标时也拿它顶着
 *
 * ⚠️ content.js 是普通脚本（MV3 的 content script 不能 import），
 *    所以它内部复制了一份同样的 TRIGGER_CSS、两个预设 SVG 和 SVG_GUARDS。
 *    tools/test-lib.mjs 会逐字比对（忽略空白），改这里必须同步改那边。
 *
 * ## 两个设计决定
 *
 * - **尺寸走 CSS 变量**（`--rt-tr-size` / `--rt-tr-radius` / `--rt-tr-font`，
 *   由 JS 按 1/zoom 写入），不写内联 `width/height`。内联样式的优先级最高，
 *   会把「尺寸可配置」这条路堵死，也让以后想微调形状变得很难。
 * - **预设规则写成 `.rt-trigger:where(.s-badge)`**。`:where()` 的优先级贡献是 0，
 *   整条规则保持 (0,1,0) —— 以后要覆盖某个预设（换配色、调圆角）不用堆 `!important`。
 */

/** 按钮的样式表。content.js 与设置页预览共用 */
export const TRIGGER_CSS = `
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

/** 地球：外圈 + 一条竖经线 + 两条纬线 */
const GLOBE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="8.6"/>' +
  '<ellipse cx="12" cy="12" rx="3.9" ry="8.6"/>' +
  '<path d="M3.6 9.1h16.8M3.6 14.9h16.8"/>' +
  '</svg>';

/**
 * 三行「文字」+ 一个向右的箭头。
 * 两处用它：设置页那个「插入示例图标」按钮，以及**「自定义」预设的占位图标** ——
 * 用户选了自定义却还没粘自己的 SVG 时，得有个看得见的东西顶着（按钮不能是空的）。
 */
export const TRIGGER_SVG_SAMPLE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round">\n' +
  '  <path d="M3.5 7.5h11M3.5 12h7.5M3.5 16.5h9"/>\n' +
  '  <path d="M14.5 9.5 18 13l-3.5 3.5"/>\n' +
  '  <path d="M18 13h-6.5"/>\n' +
  '</svg>';

/**
 * @typedef {object} TriggerStyle
 * @property {string} id        存进 settings.triggerStyle 的值，对应 class `.s-<id>`
 * @property {string} name      设置页上显示的名字
 * @property {string} hint      一句话说明（做 title）
 * @property {boolean} round    true = 圆角方块（配文字），false = 正圆（配线性图标）
 * @property {boolean} [bare]   true = 不给底座（底色 / 描边 / 阴影全无），整块就是图标本身
 * @property {string} [text]    文字内容（和 svg 二选一）
 * @property {string} [svg]     内联 SVG（和 text 二选一）
 */

/** @type {TriggerStyle[]} */
export const TRIGGER_STYLES = [
  {
    id: 'badge',
    name: '译字方块',
    hint: '紫色渐变圆角方块，中间一个「译」字。默认样式',
    round: true,
    text: '译'
  },
  {
    id: 'globe',
    name: '地球',
    hint: '正圆底 + 线描地球（带经纬线）',
    round: false,
    svg: GLOBE_SVG
  },
  {
    // 原来是「笔尖」。笔尖只是个装饰性预设，而且和地球一样自带圆盘 —— 想要
    // 「没底座的裸图标」根本没得选。改成自定义，预设这一排才算把三种情况凑齐：
    // 有底座+文字 / 有底座+图标 / 无底座+自己的图标。
    id: 'custom',
    name: '自定义',
    hint: '没有底座，你粘进来的 SVG 就是按钮本身；还没填图标时先用示例图标顶着',
    round: false,
    bare: true,
    svg: TRIGGER_SVG_SAMPLE
  }
];

export const TRIGGER_STYLE_IDS = TRIGGER_STYLES.map((s) => s.id);

export const DEFAULT_TRIGGER_STYLE = TRIGGER_STYLES[0].id;

/** 大小限位（px，网页 100% 缩放下的像素） */
export const TRIGGER_SIZE_MIN = 20;
export const TRIGGER_SIZE_MAX = 96;
export const DEFAULT_TRIGGER_SIZE = 45;

export function getTriggerStyle(id) {
  return TRIGGER_STYLES.find((s) => s.id === id) || TRIGGER_STYLES[0];
}

export function clampTriggerSize(n) {
  const v = Math.round(Number(n) || DEFAULT_TRIGGER_SIZE);
  return Math.min(TRIGGER_SIZE_MAX, Math.max(TRIGGER_SIZE_MIN, v));
}

/* ------------------------------------------------------------------ */
/* 自定义 SVG 图标                                                      */
/* ------------------------------------------------------------------ */

/**
 * 用户粘进来的 SVG 要过的几道关。
 *
 * 为什么不是「白名单改写」而是「不通过就整体拒绝」：
 * 这段代码会被 `innerHTML` 插进 shadow DOM，而 content script 所在的世界
 * 是能碰到 `chrome.*` 的 —— 粘贴一段带 `<script>` 或 `onload=` 的东西进来，
 * 它就会在扩展的上下文里跑。改写（剔除危险标签）容易漏（大小写、命名空间、
 * `<use>` 拉外部、`<foreignObject>` 套 HTML…），不如直接拒绝，用户也看得懂原因。
 *
 * ⚠️ content.js 里复制了一份同样的数组，tools/test-lib.mjs 会逐个正则比对。
 *
 * 每条规则两种语义，用 `negate` 区分 —— 别混：
 *   默认      `re` **匹配到**就拒绝（命中了危险写法）
 *   negate    `re` **没匹配到**才拒绝（这条是「必须长这样」的形状要求）
 */
export const SVG_GUARDS = [
  { re: /^<svg[\s>]/i, negate: true, reason: '要以 <svg 开头' },
  { re: /<\/svg>\s*$/i, negate: true, reason: '要以 </svg> 结尾' },
  {
    re: /<\s*(?:script|foreignObject|iframe|image|use|a|style|animate|set)\b/i,
    reason: '不能有 <script> / <foreignObject> / <use> / <image> / <a> / <style> 这类标签'
  },
  { re: /\son[a-z]+\s*=/i, reason: '不能带 onload / onclick 这类事件属性' },
  { re: /\b(?:xlink:)?href\s*=/i, reason: '不能带 href 外链' }
];

/**
 * 检查用户填的 SVG。
 * @returns {{svg: string, reason: string}} 通过时 svg 是原文（trim 过），没填时两者都是空串
 */
export function parseTriggerSvg(input) {
  const raw = String(input || '').trim();
  if (!raw) return { svg: '', reason: '' };
  for (const g of SVG_GUARDS) {
    const hit = g.re.test(raw);
    if (g.negate ? !hit : hit) return { svg: '', reason: g.reason };
  }
  return { svg: raw, reason: '' };
}

/** 只要结果，不关心原因 */
export function sanitizeTriggerSvg(input) {
  return parseTriggerSvg(input).svg;
}
