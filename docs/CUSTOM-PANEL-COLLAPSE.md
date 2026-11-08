# 整个面板展开 / 收起

> 2026-11-08 · 和 `CUSTOM-PANEL-HOVER.md`（**单个配置块**悬停展开）不是一回事。
> 这一份是 **整个面板** 收成一条顶栏、再展开回来；里面的配置 **没有任何动效**。

---

## 它长什么样

```
收起时                              展开时
┌──────────────────────┐          ┌──────────────────────┐
│ ● 配置 ▾  中文 ▾  ◉ ✕ │    →     │ ● 配置 ▾  中文 ▾  ◉ ✕ │
└──────────────────────┘          ├──────────────────────┤
  （只剩顶栏这一条）                 │ 原文 / 译文 / 按钮    │
                                     │ 底栏 HTTP 200        │
                                     └──────────────────────┘
```

---

## 怎么触发：三条路，选一条

纯 CSS **没法自己记住「展开 / 收起」这个状态**，所以必须有个触发源。
下面三种各有用例。

### 方案 A：整面板悬停展开（最省事，不用改代码）

鼠标移到面板上就展开，移开就收起。

```css
/* ── 关键思路 ────────────────────────────────────────────
   面板是 flex 纵向布局、**没有定高**（高度由内容撑开）。
   要让它「从一条顶栏长出来」，得给除顶栏外的部分一个能收缩的壳。
   不新增 DOM —— 直接拿 .rt-body / .rt-foot / .rt-diag 当壳。
   三者都要收：底栏和诊断区也属于「展开态才看的东西」。
   ───────────────────────────────────────────────────── */

/* 1) 让 height:auto 能参与过渡（必须写在**被动画的元素自己身上**） */
#rt-panel .rt-body,
#rt-panel .rt-foot,
#rt-panel .rt-diag {
  interpolate-size: allow-keywords;
  height: auto;            /* 展开态 = 原来的样子 */
  overflow: hidden;        /* 收起时把内容裁掉，别溢出去 */
  transition: height .30s cubic-bezier(.22, .9, .3, 1),
              opacity .20s ease;
}

/* 2) 收起：高度归零 + 淡出 */
#rt-panel:not(:hover):not(:focus-within) .rt-body,
#rt-panel:not(:hover):not(:focus-within) .rt-foot,
#rt-panel:not(:hover):not(:focus-within) .rt-diag {
  height: 0;
  opacity: 0;
}

/* 3) 收起时别露出顶栏那道分隔线 */
#rt-panel:not(:hover):not(:focus-within) .rt-head {
  border-bottom-color: transparent;
}

/* 4) 配置块一个字都不动 —— 你说了「配置无动效」 */
#rt-panel .rt-slot,
#rt-panel .rt-slot-h,
#rt-panel .rt-slot-b,
#rt-panel .rt-acts,
#rt-panel .rt-src {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  #rt-panel .rt-body, #rt-panel .rt-foot, #rt-panel .rt-diag {
    transition-duration: .12s;    /* 缩短但不取消 */
  }
}
```

**为什么不用新包一层 div**：面板 DOM 由 `lib/panel-core.js` 生成，网页和设置页预览
共用同一份。改 DOM 要动代码，而 `.rt-body` 本来就是「原文 + 结果」那一坨 ——
拿它当壳零改动。

**局限**：鼠标一移开就收。往上滚页面时鼠标离开面板 → 想复制译文得先移回去。

---

### 方案 B：点一下顶栏切换（能记住状态）

用 `:has()` + 一个隐藏 checkbox 记住「展开了没有」。
**这一条要改代码**（面板里得有个 checkbox），下面是「加了之后该长什么样」。

```css
/* 假设面板里有个 <input id="rt-collapse" type="checkbox">，藏着不让看见 */
#rt-panel #rt-collapse { position: absolute; opacity: 0; pointer-events: none; }

#rt-panel .rt-body,
#rt-panel .rt-foot,
#rt-panel .rt-diag {
  interpolate-size: allow-keywords;
  height: 0;               /* 默认收着 */
  overflow: hidden;
  opacity: 0;
  transition: height .30s cubic-bezier(.22,.9,.3,1), opacity .20s ease;
}

/* 勾上 = 展开 */
#rt-panel:has(#rt-collapse:checked) .rt-body,
#rt-panel:has(#rt-collapse:checked) .rt-foot,
#rt-panel:has(#rt-collapse:checked) .rt-diag {
  height: auto;
  opacity: 1;
}

#rt-panel:not(:has(#rt-collapse:checked)) .rt-head { border-bottom-color: transparent; }

#rt-panel .rt-slot, #rt-panel .rt-slot-h, #rt-panel .rt-slot-b,
#rt-panel .rt-acts, #rt-panel .rt-src { transition: none; }
```

**注意**：`.rt-head` 现在是**拖动条**（`data-drag` + `cursor: move`）。
整条变成点击切换会和拖动打架 —— 拖动时会误判成点击。
真要这么做，代码上得把「切换」绑到右侧某个小按钮，顶栏左侧继续留给拖动。

---

### 方案 C：收成一颗小胶囊（最激进）

不悬停时连顶栏都收窄，只剩一个状态灯；鼠标移上去整个面板回归。

```css
#rt-panel {
  interpolate-size: allow-keywords;
  transition: width .26s cubic-bezier(.22,.9,.3,1),
              border-radius .26s ease, height .30s cubic-bezier(.22,.9,.3,1);
}

#rt-panel .rt-body, #rt-panel .rt-foot, #rt-panel .rt-diag {
  interpolate-size: allow-keywords;
  overflow: hidden;
  transition: height .30s cubic-bezier(.22,.9,.3,1), opacity .18s ease;
}

#rt-panel:not(:hover):not(:focus-within) {
  width: 3.2em !important;    /* 面板宽度是 JS 写的内联 style，必须 !important 压过 */
  border-radius: 999px;
}
#rt-panel:not(:hover):not(:focus-within) .rt-body,
#rt-panel:not(:hover):not(:focus-within) .rt-foot,
#rt-panel:not(:hover):not(:focus-within) .rt-diag { height: 0; opacity: 0; }

/* 顶栏里除了状态灯，其余全隐 */
#rt-panel:not(:hover):not(:focus-within) .rt-cfg,
#rt-panel:not(:hover):not(:focus-within) .rt-lang,
#rt-panel:not(:hover):not(:focus-within) .rt-actions {
  opacity: 0;
  pointer-events: none;
}
```

**坑**：面板宽度是 JS 写成内联 `style.width` 的（跟「面板宽度」那个设置走），
CSS 想改必须 `!important`。`3.2em` 到 `460px` 之间有具体数值，能平滑插值。

---

## 三条方案的取舍

| | 触发方式 | 要改代码吗 | 适合 |
| --- | --- | --- | --- |
| **A** 悬停整面板 | 鼠标移上去 | ❌ 不用 | 想快速瞄一眼、平时不占地方 |
| **B** 点顶栏折叠 | 点击 | ✅ 要加 checkbox | 想固定住展开 / 收起状态 |
| **C** 收成胶囊 | 鼠标移上去 | ❌ 不用 | 极简，面板几乎隐形 |

**先试 A** —— 不用改代码，粘进设置页「面板」那个 CSS 框就能看到。
不满意再看 B / C。

---

## 三个实测的坑（都踩过）

1. **`interpolate-size` 必须写在被动画的元素自己身上**。
   写祖先（比如 `#rt-panel`）**不生效**：它会继承，但 `height:auto` 的插值只对
   「自己声明了这一项的元素」起作用。实测写祖先只有 24 个中间高度值、第一帧就跳
   105px（看着像瞬开）；写自己身上 39 个值、逐帧均匀。

2. **别用 `max-height` 或 `grid-template-rows: 0fr`**。
   - `max-height: 0 → 60vh`：内容比上限短很多时，动画在开头几帧就跑完
     （实测 `t=12ms` 已到 88px）。
   - `grid-template-rows: 0fr → 1fr`：实测只有 **4 个**中间高度值，30ms 结束。
   只有 `height: 0 ↔ auto` + `interpolate-size` 能得到 39 个值。

3. **配置块必须显式 `transition: none`**。
   不然旧样式残留（或以后的改动）会让每个配置块也跟着动 —— 你明确要「配置无动效」。

---

## 怎么验证它真的动了

**别只看终态**。控制台里逐帧采样：

```js
const sh = document.querySelector('#request-translate-host').shadowRoot;
const p = sh.querySelector('#rt-panel');
const samples = [];
const t0 = performance.now();
const tick = () => {
  samples.push(Math.round(p.getBoundingClientRect().height));
  if (performance.now() - t0 < 500) requestAnimationFrame(tick);
  else {
    const uniq = [...new Set(samples)];
    console.log("不同高度值:", uniq.length, uniq.length > 15 ? "平滑 ✓" : "跳变 ✗");
  }
};
requestAnimationFrame(tick);
```

看到 **15 个以上**不同高度值才算真有动画。
