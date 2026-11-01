# 自定义面板样式 · 能力上限演示

> 这份是**样张**，不是给人长期用的配色。用途是让人一眼看到「自定义面板能做到什么程度」。
> 设置页里「填入示例：能力上限演示」按钮注入的是同一份（注释精简过，效果一样）。
> 想逐段挑着用，按 `★` 标题剪。

## 怎么用

1. 设置页 →「面板」→「自定义面板样式（CSS）」→ 点「填入示例：能力上限演示」
2. 上面的效果预览立刻变
3. 想回到原样 → 点「清空」

**注意**：面板在自己的 shadow DOM 里，把这段贴到 Stylus / user.css **一个字都不会生效** ——
只能写进设置页那个框（由我们注入到 shadow root 末尾）。

## 这份样例用到了哪些能力

| 手段 | 演示在哪 |
| --- | --- |
| 改尺寸 / 圆角 / 溢出 | ★1 |
| 多层渐变 + 毛玻璃 + 内/外阴影 | ★2 |
| `::before` 伪元素装饰 | ★2 顶彩带、★4 斜纹、★5 编号 |
| CSS 动画（`@keyframes`） | ★2 流动彩带、★3 呼吸灯 |
| 改原生 `<select>` 外观 | ★3 胶囊下拉 |
| 悬停 / 过渡 | ★3 按钮、★5 卡片、★6 操作条 |
| 重排布局（把分隔线换成卡片） | ★5 |
| `counter()` 自动编号 | ★5 左上角 ①②③ |
| 网格重排 | ★8 诊断面板两列 |
| 定制滚动条 | ★9 |
| **按主题分别写** | ★10（`[data-rt-theme="light"]`）|
| 容器查询（面板变窄自动收起） | ★11 |
| 无障碍降级（`prefers-reduced-motion`） | ★12 |

## 完整源码

```css
/* ══════════════════════════════════════════════════════════════
   自定义面板样式 · 能力上限演示
   ──────────────────────────────────────────────────────────────
   这不是给人长期用的配色，是一张「能做到什么程度」的样张。
   下面每一条都是普通 CSS，没有私有 API，全部作用在面板自己的
   shadow root 里。想只用其中一块，按 ★ 标题剪出来单粘就行。
   想回到原样：点「清空」。
   ══════════════════════════════════════════════════════════════ */

/* ★ 1. 尺寸 / 圆角 */
#rt-panel {
  width: 520px !important;
  border-radius: 20px !important;
  overflow: visible !important;
}

/* ★ 2. 渐变底 + 毛玻璃 + 双层描边 + 外发光 */
#rt-panel {
  background-color: rgba(16, 12, 28, .72) !important;
  background-image:
    radial-gradient(1200px 300px at -10% -20%, rgba(168, 85, 247, .55), transparent 60%),
    radial-gradient(900px 260px at 110% 10%, rgba(34, 211, 238, .45), transparent 55%),
    linear-gradient(160deg, #1b1030 0%, #120e1f 45%, #0b0a14 100%) !important;
  backdrop-filter: blur(14px) saturate(1.5);
  -webkit-backdrop-filter: blur(14px) saturate(1.5);
  border: 0 !important;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, .14),
    inset 0 1px 0 rgba(255, 255, 255, .22),
    0 0 0 1px rgba(168, 85, 247, .45),
    0 18px 60px -12px rgba(124, 58, 237, .55),
    0 0 90px -20px rgba(34, 211, 238, .35) !important;
}

/* 顶部流动彩带（纯 CSS，不耗 JS） */
#rt-panel::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  border-radius: 20px 20px 0 0;
  background: linear-gradient(90deg, #a855f7, #22d3ee, #f472b6, #fbbf24, #a855f7);
  background-size: 300% 100%;
  animation: rt-demo-flow 6s linear infinite;
  pointer-events: none;
}
@keyframes rt-demo-flow { to { background-position: 300% 0; } }

/* ★ 3. 顶栏 + 胶囊下拉 + 玻璃圆钮 */
#rt-panel .rt-head {
  background: linear-gradient(180deg, rgba(255,255,255,.09), rgba(255,255,255,.015)) !important;
  border-bottom: 1px solid rgba(255, 255, 255, .12) !important;
  padding: 6px 8px !important;
}
#rt-panel .rt-cfg,
#rt-panel .rt-lang {
  background: rgba(255, 255, 255, .06) !important;
  border: 1px solid rgba(255, 255, 255, .16) !important;
  border-radius: 999px !important;
  color: #e9e5f5 !important;
  padding: 2px 12px !important;
  transition: box-shadow .2s, border-color .2s;
}
#rt-panel .rt-cfg:hover,
#rt-panel .rt-lang:hover {
  border-color: #22d3ee !important;
  box-shadow: 0 0 0 3px rgba(34, 211, 238, .22), 0 0 18px -4px rgba(34, 211, 238, .7);
}
#rt-panel .rt-btn {
  background: rgba(255, 255, 255, .07) !important;
  border-radius: 999px !important;
  color: #cfc8e6 !important;
  transition: transform .18s, color .18s, background .18s;
}
#rt-panel .rt-btn:hover {
  background: rgba(255, 255, 255, .18) !important;
  color: #fff !important;
  transform: translateY(-1px) scale(1.08);
}
#rt-panel .rt-dot {
  box-shadow: 0 0 10px 2px currentColor;
  animation: rt-demo-pulse 1.6s ease-in-out infinite;
}
@keyframes rt-demo-pulse {
  0%, 100% { opacity: .65; transform: scale(.92); }
  50%      { opacity: 1;   transform: scale(1.12); }
}

/* ★ 4. 原文区：斜纹 + 左侧竖条 */
#rt-panel .rt-src {
  background:
    repeating-linear-gradient(135deg, rgba(255,255,255,.035) 0 6px, transparent 6px 12px) !important;
  border-left: 3px solid #f472b6 !important;
  border-bottom: 0 !important;
  border-radius: 0 10px 10px 0;
  margin: 8px 10px;
  padding: 8px 12px !important;
  color: #b9b0d4 !important;
  font-style: italic;
}

/* ★ 5. 每条译文变成独立卡片 + 左上角自动编号 ①②③ */
#rt-panel .rt-out {
  padding: 10px 12px !important;
  counter-reset: rt-demo-slot;
}
#rt-panel .rt-slot {
  counter-increment: rt-demo-slot;
  position: relative;
  padding: 10px 12px 12px !important;
  margin: 8px 0 !important;
  background: linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.012)) !important;
  border: 1px solid rgba(255, 255, 255, .1) !important;
  border-radius: 14px !important;
  transition: border-color .2s, box-shadow .2s;
}
#rt-panel .rt-slot:hover {
  border-color: rgba(168, 85, 247, .55) !important;
  box-shadow: 0 10px 30px -14px rgba(168, 85, 247, .75);
}
/* 原来那条「槽位间分隔线」删掉 —— 卡片自带边界了 */
#rt-panel .rt-slot + .rt-slot {
  border-top: 0 !important;
  margin-top: 8px !important;
  padding-top: 10px !important;
}
#rt-panel .rt-slot::before {
  content: counter(rt-demo-slot);
  position: absolute;
  top: -7px;
  left: 10px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: linear-gradient(135deg, #a855f7, #22d3ee);
  color: #0b0a14;
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  box-shadow: 0 2px 8px rgba(168, 85, 247, .6);
}
#rt-panel .rt-slot-name {
  color: #22d3ee !important;
  font-weight: 600;
  letter-spacing: .02em;
}
#rt-panel .rt-slot-st {
  color: #8f86ad !important;
  font-size: .64em !important;
  letter-spacing: .12em;
  text-transform: uppercase;
}
/* 译文右边一道渐变竖条当「引号」 */
#rt-panel .rt-slot-b {
  color: #f2eefc !important;
  border-right: 2px solid transparent;
  padding-right: 10px;
  border-image: linear-gradient(180deg, rgba(168,85,247,.7), rgba(34,211,238,0)) 1;
}
#rt-panel .rt-slot-b.err { color: #ffb4b4 !important; }

/* ★ 6. 复制 / 朗读 / 重试 做成胶囊按钮组 */
#rt-panel .rt-acts {
  gap: 6px !important;
  margin-top: 8px;
}
#rt-panel .rt-act {
  background: rgba(255, 255, 255, .05) !important;
  border: 1px solid rgba(255, 255, 255, .12) !important;
  border-radius: 999px !important;
  padding: 2px 10px !important;
  color: #b9b0d4 !important;
  transition: all .18s;
}
#rt-panel .rt-act:hover {
  background: rgba(168, 85, 247, .28) !important;
  border-color: rgba(168, 85, 247, .8) !important;
  color: #fff !important;
  transform: translateY(-1px);
}

/* ★ 7. 底栏：等宽字体 + 「⋯」圆钮 */
#rt-panel .rt-foot {
  background: rgba(255, 255, 255, .03) !important;
  border-top: 1px solid rgba(255, 255, 255, .1) !important;
}
#rt-panel .rt-msg {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace !important;
  color: #8f86ad !important;
  letter-spacing: .02em;
}
#rt-panel .rt-more {
  border-radius: 999px !important;
  background: rgba(255, 255, 255, .07) !important;
  min-width: 26px;
}
#rt-panel .rt-more:hover {
  background: rgba(34, 211, 238, .25) !important;
  border-color: rgba(34, 211, 238, .8) !important;
  color: #22d3ee !important;
}

/* ★ 8. 诊断面板：两列网格 + 标签右对齐 + 值等宽彩色 */
#rt-panel .rt-diag {
  background: rgba(0, 0, 0, .45) !important;
  border-top: 1px solid rgba(255, 255, 255, .1) !important;
  padding: 10px 14px !important;
}
#rt-panel .rt-diag .d-row {
  display: grid !important;
  grid-template-columns: 6.5em 1fr;
  gap: 10px;
  padding: 1px 0;
}
#rt-panel .rt-diag .d-k {
  width: auto !important;
  text-align: right;
  color: #6f6790 !important;
  font-size: .72em;
  letter-spacing: .06em;
}
#rt-panel .rt-diag .d-v {
  color: #22d3ee !important;
  font-weight: 600;
}
#rt-panel .rt-diag .d-v.warn { color: #fbbf24 !important; }
#rt-panel .rt-diag .d-v.err  { color: #ff8080 !important; }

/* ★ 9. 滚动条：细、圆、渐变滑块 */
#rt-panel .rt-out::-webkit-scrollbar { width: 8px; }
#rt-panel .rt-out::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, .04);
  border-radius: 999px;
}
#rt-panel .rt-out::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, #a855f7, #22d3ee);
  border-radius: 999px;
}

/* ★ 10. 亮色主题分开写 —— 这就是 [data-rt-theme] 的用途 */
[data-rt-theme="light"]#rt-panel {
  background-color: rgba(255, 255, 255, .78) !important;
  background-image:
    radial-gradient(1200px 300px at -10% -20%, rgba(168, 85, 247, .22), transparent 60%),
    linear-gradient(160deg, #ffffff 0%, #f6f2ff 100%) !important;
  box-shadow:
    inset 0 0 0 1px rgba(124, 58, 237, .2),
    0 18px 50px -16px rgba(124, 58, 237, .4) !important;
}
[data-rt-theme="light"]#rt-panel .rt-slot {
  background: rgba(255, 255, 255, .75) !important;
  border-color: rgba(124, 58, 237, .16) !important;
}
[data-rt-theme="light"]#rt-panel .rt-slot-b { color: #1e1633 !important; }
[data-rt-theme="light"]#rt-panel .rt-slot-name { color: #6d28d9 !important; }
[data-rt-theme="light"]#rt-panel .rt-src { color: #5b5378 !important; }
[data-rt-theme="light"]#rt-panel .rt-cfg,
[data-rt-theme="light"]#rt-panel .rt-lang {
  background: rgba(255, 255, 255, .8) !important;
  border-color: rgba(124, 58, 237, .25) !important;
  color: #2b2244 !important;
}

/* ★ 11. 容器查询：面板窄了自动收起次要信息 */
#rt-panel { container-type: inline-size; }
@container (max-width: 360px) {
  #rt-panel .rt-slot-st,
  #rt-panel .rt-slot::before { display: none !important; }
}

/* ★ 12. 无障碍：系统开了「减少动态效果」就停掉所有动画 */
@media (prefers-reduced-motion: reduce) {
  #rt-panel *, #rt-panel::before {
    animation: none !important;
    transition: none !important;
  }
}
```

## 边界：哪些能做、哪些做不到

**能做的**（都在这份样例里实测跑过）：

- 改颜色 / 圆角 / 阴影 / 边框 / 背景（渐变、图案、毛玻璃）
- 改尺寸与间距、隐藏任意部件（`display: none`）
- 重排：卡片化、网格化、伪元素装饰与编号
- 动画与过渡
- 改原生 `select` / `button` / `::-webkit-scrollbar` 外观
- 用 `[data-rt-theme]` 给深浅两套主题分别配色
- `@container` / `@media` 响应式与无障碍降级

**做不到的**（别在这上面花时间）：

- **加新部件**：CSS 改不了 DOM 结构，塞不进可点的按钮。想在面板上加按钮 = 改代码
- **改文案**：`content` 只能加伪元素装饰字，改不了真实文本 —— 那是 JS 管的
- **改行为**：点击 / 拖拽 / 朗读这些逻辑都不在 CSS 里
- **让面板跟随页面配色**：面板是自封闭的，也读不到页面的 CSS 变量（这是设计，不是缺陷）
- **稳赢第三方的 `!important`**：有些站点（如 mikanani.me）自己内嵌 Dark Reader，会往我们的 shadow root 里塞 `!important` 规则。`#rt-panel` + `!important` 能赢过它，但你的自定义里漏了 `!important` 就压不过

## 想让自己写的东西活得更久

1. **优先用 `#rt-panel`** —— id 选择器优先级 1-0-0，高于我们的 `.rt-panel` 类，多数情况不用 `!important`
2. 我们的默认样式全部走 `var(--rt-*)`。只改配色的话，覆盖变量比硬写颜色省事：

```css
#rt-panel {
  --rt-accent: #b8863b;
  --rt-border: #332f27;
}
```

3. 可用的全部钩子与变量清单见 `docs/DEVELOPMENT.md` 的「自定义面板样式」一节。
