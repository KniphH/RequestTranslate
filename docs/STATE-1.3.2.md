# 1.3.2 发布前的状态（2026-11-09）

> kniph 的决策：「先把本地的用一段时间，等 1.3.2 再一起推」。
> 所以下面这些**都是有意的、不是遗漏** —— 别看到「不一致」就当 bug 去修。

---

## 一、为什么现在不推

1.3.1 的本地包和线上/Release 的包**内容不同**，这是刻意的：

| 位置 | 版本 | 字节 | 内容 |
| --- | --- | --- | --- |
| Edge 商店（已上线） | 1.3.1 | 125,505 | T1 合并 CSS **之前**的代码 |
| GitHub Release v1.3.1 | 1.3.1 | 125,505 / 125,499 | 同上 |
| **本地 dist（要用的）** | 1.3.1 | **119,534 / 119,528** | **T1 之后**（CSS 合并 + 17 条新断言） |

**本地这份是新的**，先自己用一段时间验证；攒够改动后一起发 1.3.2。
AMO 那边同理：1.3.0 还在审，过审后也不用急着提 1.3.1，等 1.3.2 一起。

⚠️ 如果有人（包括未来的我）想把本地包推到线上：**先问 kniph**。
这条决定是他定的，不是「忘了推」。

## 二、1.3.1 本地版改了什么（相对线上那份）

### T1 面板 CSS 双份合一（唯一有实质风险的改动）

原来面板样式有两份：`content.js` 内联一大段 + `lib/panel-styles.js`（ES module），
靠 `test-lib` 的逐字比对断言防漂移。那套做法一直在付成本 —— 改一个样式要同步两处，
`text-align` 就漏过一次。

现在合成一处：`lib/panel-core.js` 里 `const TRIGGER_CSS` / `const PANEL_CSS`，
挂到 `window.RTPanelCore`。content script 和设置页都从全局取，谁都不用 import
（content script 本来也不能 import，这正是当初分成两份的原因）。

```
  content.js        3021 → 2633 行   （-388 行重复 CSS）
  lib/panel-core.js  241 →  657 行   （+416，两份 CSS 收进来）
  lib/panel-styles.js 348 →  18 行   （退役成空壳说明）
  lib/trigger-styles.js              去掉 export TRIGGER_CSS
```

**包体积顺带变小**：125,505 → 119,534 字节（-5.9 KB）。

### 其余三项（无风险）

- **T4**：`DEFAULT_TARGETS` 15 → 20 文件（补 panel-core / panel-styles / crypto /
  clipboard-read / frame-bridge）；`ua-rules.json` 从 0 条断言补到 8 条（隐私守门）；
  `clipboard-read` 补 7 条。test-lib 990 → **1007**。
- **T2**：`docs/DEVELOPMENT.md` 988/1653 → 1007/1672。
- **T5**：`docs/ROADMAP.md` 火狐条目 `[ ]` → `[x]`，并写清「一份 manifest 通吃只在
  浏览器运行时成立、商店校验器不接受」这个坑。

## 三、用本地版时要留意的（真实风险点）

**CSS 合并是这版唯一的实质改动。** 面板的渲染路径全换了数据来源，所以：

1. **面板外观有没有变**：顶栏、原文区、译文、底栏、诊断区、滚动条位置、深浅主题
2. **设置页的「效果预览」**和网页面板**长得一样**（这两处共用同一份 CSS，
   以前是两份各自漂移，现在必须完全一致 —— 这也是合并的目的）
3. **自定义面板 CSS**（设置页那个输入框）还能不能用、覆盖顺序对不对
4. 面板缩放补偿（网页 Ctrl+加减号放大时面板不跟着变大）

自动化已验证：**e2e 555 项全过**（含量顶栏/底栏/缩放的几何断言），所以理论上没问题。
但 e2e 是 headless + 假接口，**真机长时间使用**才可能暴露它测不到的东西。

## 四、攒到 1.3.2 时要做的事

```
1. 改 manifest.json 的 version → 1.3.2
2. python tools/pack.py --xpi        （会先跑全量测试，出来一对新包）
3. python tools/verify-pack.py       （两个包都验；含 background 形态 + 双包一致）
4. Edge 开发者中心 → 提交新版本 → 传 zip
5. GitHub → 建 v1.3.2 Release → 传 zip / xpi / SOURCE.zip
6. AMO（若 1.3.0/1.3.1 已过审）→ 提交新版本 → 传 xpi + SOURCE.zip
```

**别忘**：`python tools/pack-source.py` 生成 SOURCE.zip（AMO 要求同版本附源码）。

## 五、三处「等外部」的待办（不是代码活）

| 事项 | 等什么 |
| --- | --- |
| AMO 1.3.0 | 审核中，未公开上线（API 搜不到） |
| AMO 1.3.1 / 1.3.2 | 过审后再提，用本地新包 |
| README 火狐徽章 | 过审后从静态 `IN REVIEW` 换成 dynamic（URL 在 README 13-18 行注释里，slug 含中文要 percent-encode）。没过审换会 404 |

## 六、Edge 商店现状（已上线，无需动）

```
  版本      1.3.1
  更新时间  2026-11-08
  截图      4 张（新做的那套，逐字节哈希与 docs/store/ 一致）
  logo / 小推广图 / 大推广图   全部是新做的（哈希与本地一致）
  描述      2,602 字符，8 段 + Key Features + How It Works
            已包含 bilibili Index-Translate、图像翻译、回退链、加密导出等
  评分      5.0（1 人）
```

**注意**：描述里那 8 段是完整的，但在商店页上默认只显示前 3 行 + 「显示更多」。
我之前误判成「描述很短、缺新功能」，是因为只看了折叠状态 —— **别重犯**，
要看完整描述请走 API：`getproductdetailsbycrxid` 的 `description` 字段。

## 七、一句话总结

**本地 1.3.1 比线上多一个 CSS 合并，先自己用；攒够改动发 1.3.2 时三端（Edge / GitHub / AMO）
一起推。在此之前不要动 dist 里的包，也不要把它们推到任何地方。**
