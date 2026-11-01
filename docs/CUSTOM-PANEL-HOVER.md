# 面板样式：悬停展开（手风琴式）

> 默认只显示**配置名 + 状态**一行；鼠标移上去，译文和「复制/朗读/重试」平滑展开；移开收回。

## 怎么用

设置页 →「面板」→「自定义面板样式（CSS）」→ 整段粘进去。

> ⚠️ 面板在 shadow DOM 里，贴 Stylus 无效，只能写进设置页那个框。

## 两个容易做错的地方（我都实际踩过）

### 一、用 `max-height` 做高度动画 = 动画根本看不见

第一版我写的是 `max-height: 0 → 60vh`。代码看着没问题，但逐帧采样是这样的：

```
t=12ms   max-height=88px   内容已全部露出   ← 译文真实只占 34px
t=31ms   max-height=240px
t=195ms  max-height=669px  达到终态，但视觉上 400ms 前就不动了
```

**`max-height` 只是个上限，不是真实高度。** 内容 34px 高时，`max-height` 动画
越过 34px 那一刻内容就全露了 —— 12ms 就结束，剩下 400 多毫秒全在空转。

`grid-template-rows: 0fr → 1fr` 这个"经典替代方案"也试了：**只有 4 个中间高度值**，
30ms 就跳完。同样不行。

### 二、唯一真能平滑的做法：让 `height` 参与动画

```css
#rt-panel { interpolate-size: allow-keywords; }   /* 让 height:auto 可过渡 */
#rt-panel .rt-slot-b { height: 0; }
#rt-panel .rt-slot:hover .rt-slot-b { height: auto; }
```

`interpolate-size` 是 Edge/Chrome **129+** 的特性。实测在真面板上：

```
不同高度值: 37 个，40.3 → 51.9 → 86.9 → 104.2 → 111.3 → 130.7 → 155 → 166.6 …
```

老浏览器不支持时**降级成瞬开**（不会坏，只是没有动画）。

## 一个必须知道的交互设计点

**悬停判定挂在整张卡片 `.rt-slot` 上，不是只挂在配置名上。**

如果只让「配置名」触发展开：

```
鼠标移到配置名 → 展开了
鼠标往按钮移动 → 离开配置名 → 立刻收起
按钮还没点到，它就没了
```

所以作用范围必须包含展开后的内容。副作用是**鼠标停在译文上也不会收起** ——
这正好方便阅读。

## 完整源码

```css
/* ══════════════════════════════════════════════════════════════════
   面板样式：悬停展开（手风琴式）
   ──────────────────────────────────────────────────────────────────
   默认只显示「配置名 + 状态」一行；鼠标移上去，译文和三个按钮
   用非线性缓动展开；移开收回。

   ★ 关键设计：**悬停判定挂在整张卡片 .rt-slot 上，不是只挂在名字上**。
     如果只让名字触发展开，鼠标一想点按钮就会离开名字 → 立刻收起 →
     按钮永远点不到。所以「展开」的作用范围必须包含展开后的内容。
   ★ 收起时用 height: 0 + overflow: hidden，不用 display:none ——
     后者没法过渡，会硬跳。
   ══════════════════════════════════════════════════════════════════ */


/* ★ 0. 让 height:auto 参与过渡（Edge 129+ / Chrome 129+）
     没有它的话 height:0 -> auto 会直接跳变（老浏览器降级成瞬开，不会坏） */
#rt-panel { interpolate-size: allow-keywords; }

/* ★ 1. 卡片本体：收起时只有一行高 */
#rt-panel .rt-slot {
  padding: 0 !important;
  margin: 6px 0 !important;
  border: 1px solid rgba(255, 255, 255, .08) !important;
  border-radius: 10px !important;
  background: rgba(255, 255, 255, .035) !important;
  cursor: default;
  /* 过渡曲线用 "回弹感" 的非线性贝塞尔（overshoot） */
  transition:
    border-color .35s cubic-bezier(.34, 1.56, .64, 1),
    background-color .35s ease,
    box-shadow .35s ease;
}

/* 原来的「槽位间分隔线」不要了 —— 每张卡片自己是一个块 */
#rt-panel .rt-slot + .rt-slot {
  border-top: 1px solid rgba(255, 255, 255, .08) !important;
  margin-top: 6px !important;
  padding-top: 0 !important;
}


/* ★ 2. 块头：收起时是可悬停的「标题条」 */
#rt-panel .rt-slot-h {
  margin: 0 !important;
  padding: 7px 13px !important;
  border-radius: 10px;
  cursor: pointer;
  transition: background-color .25s ease, color .25s ease;
}
#rt-panel .rt-slot-h:hover {
  background: rgba(255, 255, 255, .07) !important;
}
#rt-panel .rt-slot-name {
  color: #cfc8e6 !important;
  font-weight: 600;
  transition: color .25s ease;
}
#rt-panel .rt-slot-h:hover .rt-slot-name {
  color: #ffffff !important;
}
/* 状态文字平时只在右边淡淡亮着 */
#rt-panel .rt-slot-st {
  color: #756d92 !important;
  font-size: .68em !important;
  letter-spacing: .1em;
  text-transform: uppercase;
  transition: color .25s ease;
}
#rt-panel .rt-slot-h:hover .rt-slot-st { color: #a99fc4 !important; }


/* ★ 3. 译文：收起 = 高度 0；展开 = 内容区高度
     height 参与动画才真平滑（详见 ★0 与 ★3 的注释） */
#rt-panel .rt-slot-b {
  height: 0 !important;
  opacity: 0;
  overflow: hidden;
  padding: 0 13px !important;
  margin: 0 !important;
  color: #f0ecfa !important;
  /* 展开用「先快后慢 + 轻微过冲」，收起用普通 ease 更快收回去 */
  transition:
    height .45s cubic-bezier(.16, 1.2, .3, 1),
    opacity .3s ease .05s,
    padding .45s cubic-bezier(.16, 1.2, .3, 1);
}
/* 展开态：给一个足够大的上限。译文再长也有滚动条兜底（见 .rt-out） */
#rt-panel .rt-slot:hover .rt-slot-b {
  height: auto !important;
  opacity: 1;
  padding: 6px 13px 2px !important;
}


/* ★ 4. 三个按钮：同样收起 / 展开，且展开比译文稍晚一点（错开感） */
#rt-panel .rt-acts {
  height: 0 !important;
  opacity: 0;
  overflow: hidden;
  margin: 0 !important;
  padding: 0 13px !important;
  gap: 6px !important;
  transition:
    height .4s cubic-bezier(.16, 1.2, .3, 1),
    opacity .28s ease,
    padding .4s cubic-bezier(.16, 1.2, .3, 1);
}
#rt-panel .rt-slot:hover .rt-acts {
  height: auto !important;
  opacity: 1;
  padding: 2px 13px 9px !important;
  transition-delay: .06s;
}
#rt-panel .rt-acts { display: flex; }

/* 按钮本身：胶囊 + 悬停高亮 */
#rt-panel .rt-act {
  background: rgba(255, 255, 255, .06) !important;
  border: 1px solid rgba(255, 255, 255, .12) !important;
  border-radius: 999px !important;
  padding: 2px 10px !important;
  color: #b9b0d4 !important;
  transition: background .18s, border-color .18s, color .18s, transform .18s;
}
#rt-panel .rt-act:hover {
  background: rgba(168, 85, 247, .3) !important;
  border-color: rgba(168, 85, 247, .85) !important;
  color: #fff !important;
  transform: translateY(-1px);
}


/* ★ 5. 悬停时整张卡片提亮 + 左侧一道高亮竖条（"被选中"的感觉） */
#rt-panel .rt-slot:hover {
  border-color: rgba(168, 85, 247, .5) !important;
  background: rgba(255, 255, 255, .06) !important;
  box-shadow: 0 8px 24px -12px rgba(168, 85, 247, .8);
}
#rt-panel .rt-slot::before {
  content: "";
  position: absolute;
  left: 0; top: 10px; bottom: 10px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: linear-gradient(180deg, #a855f7, #22d3ee);
  opacity: 0;
  transform: scaleY(.4);
  transform-origin: center;
  transition: opacity .3s ease, transform .4s cubic-bezier(.34, 1.56, .64, 1);
}
#rt-panel .rt-slot:hover::before {
  opacity: 1;
  transform: scaleY(1);
}
/* ::before 要绝对定位，所以卡片得有 relative */
#rt-panel .rt-slot { position: relative; }


/* ★ 6. 结果区加一点内边距，卡片之间留呼吸 */
#rt-panel .rt-out { padding: 8px 10px !important; }


/* ★ 7. 窄面板：收起态把状态文字藏掉，只留配置名（否则一行挤不下） */
#rt-panel { container-type: inline-size; }
@container (max-width: 320px) {
  #rt-panel .rt-slot-st { display: none !important; }
}


/* ★ 8. 无障碍：系统开了「减少动态效果」就瞬时切换，不做缓动 */
@media (prefers-reduced-motion: reduce) {
  #rt-panel .rt-slot,
  #rt-panel .rt-slot-b,
  #rt-panel .rt-acts,
  #rt-panel .rt-slot::before {
    transition-duration: .01ms !important;
    transition-delay: 0ms !important;
  }
}


/* ★ 9. 键盘可达：用 :focus-within 让按 Tab 到卡片里的按钮时也能展开
     （纯 CSS 的 :hover 对键盘无效，这是唯一的补救） */
#rt-panel .rt-slot:focus-within .rt-slot-b {
  height: auto !important;
  opacity: 1;
  padding: 6px 13px 2px !important;
}
#rt-panel .rt-slot:focus-within .rt-acts {
  height: auto !important;
  opacity: 1;
  padding: 2px 13px 9px !important;
}
#rt-panel .rt-slot:focus-within {
  border-color: rgba(168, 85, 247, .5) !important;
}
```

## 实现要点

| 点 | 做法 |
| --- | --- |
| 收起/展开 | `height: 0 ↔ auto` + `overflow: hidden`（靠 `interpolate-size` 才能过渡） |
| 非线性缓动 | 展开 `cubic-bezier(.16, 1.2, .3, 1)`（先快后慢 + 轻微过冲）；边框/竖条用 `cubic-bezier(.34, 1.56, .64, 1)`（回弹） |
| 错开 | 按钮比译文晚 `60ms` 进场（`transition-delay`） |
| 左侧竖条 | `::before` + `scaleY(.4) → scaleY(1)`，悬停时长出来 |
| 键盘可达 | 纯 CSS 的 `:hover` 对键盘无效，用 `:focus-within` 补 —— Tab 到按钮上时也展开 |
| 无障碍 | `prefers-reduced-motion: reduce` 时把过渡压到 `0.01ms` |
| 窄面板 | `@container (max-width: 320px)` 时收起态藏掉状态文字 |

## 已知取舍

- **收起态看不到译文**。多条对比时是优点（面板矮很多）；但想一眼扫完所有译文的话，这式样不合适。
- 想要「移开延迟几秒再收」纯 CSS 做不到（`:hover` 一离开就触发）。近似做法是把**收起**那半边的
  `transition-duration` 拉长（比如 `1.2s`），看起来像"慢慢合上"：

  ```css
  #rt-panel .rt-slot-b { transition: height 1.2s ease, opacity .8s ease; }
  #rt-panel .rt-slot:hover .rt-slot-b {
    transition: height .45s cubic-bezier(.16, 1.2, .3, 1), opacity .3s ease;
  }
  ```

---

其他样例：`CUSTOM-PANEL-DEMO.md`（能力上限）、`DEVELOPMENT.md`（钩子清单）。
