/**
 * 结果面板的样式表 —— **content.js 和设置页共用这一份**。
 *
 * 设置页的「效果预览」以前是自己画一个示意图，比例和真面板对不上
 * （kniph 2026-10-17：「预览和实际的大小不太对得上」）。做成共享之后，
 * 两边是同一份 CSS + 同一套 DOM + 同样的 shadow DOM，渲染结果必然一致。
 *
 * 里面用了 `:host` 选择器，所以**两边都必须放在 shadow root 里**跑。
 */
import { TRIGGER_CSS } from './trigger-styles.js';

export const PANEL_CSS = `:host, * { box-sizing: border-box; }

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
  padding: .6em calc(.7em - 8px) .6em .7em;
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
.rt-slot { padding: .32em 0; }
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
  margin-bottom: .18em;
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
  margin-top: .25em;
  opacity: .55;
  transition: opacity .13s;
}
.rt-slot:hover .rt-acts,
.rt-acts:hover { opacity: 1; }
.rt-act {
  display: flex; align-items: center; gap: .22em;
  background: none; border: none;
  padding: .1em .3em;
  border-radius: .25em;
  font: inherit;
  font-size: .74em;
  color: var(--rt-text-foot);
  cursor: pointer;
}
.rt-act:hover { background: var(--rt-hover); color: var(--rt-text); }
.rt-act svg { display: block; width: 1.05em; height: 1.05em; }
.rt-act[disabled] { opacity: .4; cursor: default; }
.rt-act[disabled]:hover { background: none; color: var(--rt-text-foot); }
.rt-slot-b.err { color: #ef4444; font-size: .82em; }

.rt-out::-webkit-scrollbar-thumb, .rt-src::-webkit-scrollbar-thumb, .rt-diag::-webkit-scrollbar-thumb {
  background: var(--rt-scroll); border-radius: 4px;
}
`;
