/**
 * 主题色（accent）预设 —— 面板、设置页、弹窗共用同一份。
 *
 * 为什么要有这个文件：accent 原来直接写死在两处 CSS 里（`lib/panel-core.js` 的面板样式
 * 和 `options.css`），各写了 3 个值（accent / accent-soft / accent-text），另有一堆
 * 硬编码的紫色 rgba。想加第二种颜色就得改十几个地方，且面板和设置页容易对不齐。
 *
 * 所以：**颜色值只在这个文件里出现**，CSS 侧一律用 var(--rt-accent*) 消费。
 * 换色 = 给 <html> 加一个 data-accent="blue"，浏览器自己重算所有 var。
 *
 * 为什么是普通脚本：content script 不能 import（和 panel-core 那套理由相同）。
 * 挂 window.RTAccent。
 */
(function () {
  'use strict';

  /*
   * 每个颜色给三档，暗/亮主题各一套。
   * 这三档不是随便挑的 —— 每个都算过对底色的对比度，全部 ≥ 4.5（WCAG AA）：
   *
   *   purple:  accent(dark) 4.84 / accent(light) 5.70 / text(dark) 7.25 / text(light) 7.10
   *   blue:    accent(dark) 5.21 / accent(light) 5.17 / text(dark) 7.53 / text(light) 6.70
   *
   * 换值之前先算一遍对比度，别凭眼睛调 —— 暗色主题下 4.5 以下就开始看不清了。
   */
  const ACCENTS = {
    purple: {
      name: '紫色',
      // 面板（暗色主题）
      accentDark: '#a855f7',
      softDark: '#241b38',
      textDark: '#c084fc',
      // 面板（亮色主题）
      accentLight: '#7c3aed',
      softLight: '#f0e8ff',
      textLight: '#6d28d9',
      // 设置页 / 弹窗的按钮渐变与焦点环（这两个是「品牌感」最强的地方）
      gradFrom: '#6d5cf0',
      gradTo: '#a855f7',
      // rgba 形态：设置页有十几处 border-color / box-shadow 用它
      rgb: '124, 108, 245',
    },
    blue: {
      name: '蓝色',
      accentDark: '#3b82f6',
      softDark: '#172554',
      textDark: '#60a5fa',
      accentLight: '#2563eb',
      softLight: '#e8f0fe',
      textLight: '#1d4ed8',
      gradFrom: '#2563eb',
      gradTo: '#3b82f6',
      rgb: '59, 130, 246',
    }
  };

  const IDS = Object.keys(ACCENTS);
  const DEFAULT_ID = 'purple';

  /** 认不出的 id 一律回退默认（存档被手改过也不会变成无颜色） */
  function normalizeAccent(id) {
    return IDS.includes(id) ? id : DEFAULT_ID;
  }

  /**
   * 把某个颜色的三档写进一个元素的 style（通常是 <html> 或面板根节点）。
   * 走 CSS 变量而不是改样式表：换色时不用重渲染，也不用改任何选择器。
   */
  function applyAccent(el, id) {
    const a = ACCENTS[normalizeAccent(id)];
    if (!el || !el.style) return;
    el.style.setProperty('--rt-accent', a.accentDark);
    el.style.setProperty('--rt-accent-soft', a.softDark);
    el.style.setProperty('--rt-accent-text', a.textDark);
    el.style.setProperty('--rt-accent-rgb', a.rgb);
    el.style.setProperty('--rt-grad-from', a.gradFrom);
    el.style.setProperty('--rt-grad-to', a.gradTo);
    // 亮色主题那三档由 CSS 里的 [data-theme="light"] 规则接管（见 panel-core / options.css）
    el.setAttribute('data-accent', normalizeAccent(id));
  }

  window.RTAccent = {
    ACCENTS: ACCENTS,
    IDS: IDS,
    DEFAULT_ID: DEFAULT_ID,
    normalizeAccent: normalizeAccent,
    applyAccent: applyAccent
  };
})();
