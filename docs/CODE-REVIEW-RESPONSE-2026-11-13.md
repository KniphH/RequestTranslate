# 代码通读：核实与处置（第十版回应，2026-11-14）

> 第六版提了三个 P0 和一批 P1。**三个 P0 全部成立**，本轮已修；P1 见 §4 的处置。
>
> 基线：`manifest.json` 1.3.2，HEAD `08866a3`。
> **`npm test` 全量通过**：1043→**1065** + 89 + 19 + **557**。
> 打包：118,581 字节（115.8 KB），`verify-pack` 全部通过（含新增的同源校验）。

## 一、P0-1 产物与源码漂移 —— 成立，已修

第六版这条抓得最准。实测：

```
包生成于 16:06，之后 16:18 / 16:21 又两个 commit
包内 lib/panel-core.js：无 orderedLangCodes
包内 content.js：无 RTPanelCore.orderedLangCodes、无 Math.round
```

而 `verify-pack` 只比 zip↔xpi —— 它证明的是**「两个都过期的包彼此一致」**。
这跟「P0 注入链收口」那次是同一类错误：**验证工具本身没被验**。

修：给 `verify-pack` 加第 7 道检查「包与源码同源」。包内文件被剥注释/压缩过，不能比字节，
改为查**关键语义标记**（含一条正则 —— esbuild 会把 `prefs` 压成 `f`、表达式会变形）：

```
panel-core.js  orderedLangCodes
content.js     orderedLangCodes / Math\.round\(Number\(\w+\.panelSlots\)\)
background.js  normalizeHistoryMax
options.js     orderedLangCodes
```

**实测有效**：旧包被当场抓出 5 条红；重打后「5 个关键标记都在包内」。

## 二、P0-2 e2e 无浏览器时 exit(0) —— 成立，已修

`e2e-ui.mjs:74-82` 两处 `process.exit(0)`：新机器 / CI 上会显示「1710 全绿」，
实际 UI 层一条都没跑。**那种绿比红更危险** —— 它把「没测」伪装成「测过了」。

改成 `exit(1)` + 醒目的错误提示（告诉用户装 Edge 或 playwright-core）。

## 三、P0-3 `probed = true` 写错函数 —— 成立，是我上一轮插错了位置

```
L3630  let probed = false     ← bindUiLang 的局部变量
L3166  probed = true          ← 被错插在 onHistoryAction 的 finally 里
```

后果两条：

1. `bindUiLang` 的 `probed` 永远 false → 每次 focus/mousedown/click 都重跑
   `fetchIndex + 2×N 个 HEAD`，和 PRIVACY 里「不换语言就永远不联网」直接冲突
2. L3166 隐式创建**全局** `probed`，污染 `onHistoryAction` 的收尾路径

**第六版对「不会抛错」的判断是对的**：`options.js` 非严格模式，隐式全局不报错。
我上一版回应里「按钮卡死」的说法是错的，这点也认。

修：删掉误插，放回 `probeOnce` 的 `finally`。

## 四、P1 的处置

| 项 | 处置 |
| --- | --- |
| 占位文案不显示（`remove(empty)` 在 `dataset.placeholder` 之前） | **认同，下批修**。CSS 是 `.rt-out.empty::before`，顺序反了就是空白 |
| `runTest` 重入窗口仍在 | **认同**。`disabled` 在 `await persist` 之后 —— 我上一版说「已修」是错的，实际只修了 `runOcrTest` |
| `frame-bridge.js:83` 空引用崩溃 | **认同**。`fr` 为 null 时 `fr.left` 抛 TypeError |
| 样式变量名错（`--rt-fg-dim` vs `--rt-text-dim`） | **认同，下批修** |
| ②⑤ 状态回滚 / busy 收口 | **认同**，作废分支只 `return` 不回滚，可复现 |
| ⑥ `cacheKey` 不是真指纹 | **认同**（长度 + 末 64 字符） |
| ⑦ TRIGGER_CSS 死代码 / 孤儿注释 | **认同**，P2 清 |
| 数字对账（1063 vs 文档 1043、18 vs 19、20 vs 25、265 vs 157） | **全部认同**，见 §5 |

## 五、数字与口径：全部按第六版对账

| 项 | 我上版写的 | 实际 | 结论 |
| --- | --- | --- | --- |
| test-lib 项数 | 1043 | **1065** | 文档又漂了（每加断言没回头改） |
| 「265 key」 | 265 | **157**（代码里实际用到） | 我把 zh 包的总键数当成「用到的」 |
| 「265 × zh/en 双向」 | 声称做了 | **没做** | `validatePack(en)` / `validatePack(zh)` 是分别校验，没有键集对照 |
| 契约字段 | 19 | **18** | 我数错了 |
| 设置项 | 20 | `DEFAULT_SETTINGS` **25** 键 | `SETTING_MAP` 20 行是「有独立输入框的」，其余走别的 UI |
| setTimeout 清理 | 「全通过」 | **4 处只有 3 处 clearTimeout** | 有一处 10ms 去抖没取消 |

**第六版建议的「数字由脚本打印并对账」我认同**，下一步就把这些数做成 `test-lib` 的自检输出。

## 六、第六版的结清判据：全盘接受

它补的三条我认为是这一轮最有价值的产出：

1. **产物必须与 HEAD 同源** —— 已落地（verify-pack 第 7 道检查）
2. **e2e 无浏览器必须红** —— 已落地（exit(1)）
3. **数字与口径取脚本输出** —— 认同，下一步做

**可 closed**（第六版列的）：①④、`langFiles` 声明、popup `#lang`、popup runSeq 主体、
`toggleSlot` 合并、i18n 两侧编码统一、`runOcrTest` 闸门、`verify-pack` 恒真修复、18 条真跑断言。

**本轮新增可 closed**：P0-1 / P0-2 / P0-3。

**不可 closed**：②③⑤⑥⑦、P1 全部（占位文案时序、`runTest` 重入、`frame-bridge` null、
样式变量名、设备回滚、cacheKey 指纹）、数字对账。

## 七、下一批顺序（按第六版建议）

1. 占位文案时序（`remove(empty)` 挪到写 placeholder 之后）
2. `runTest` 重入 + `frame-bridge` null
3. ②⑤ 状态回滚 / busy 收口
4. 样式变量名、设备回滚、`cacheKey` 指纹
5. 数字与口径做成自检输出
6. P2 死代码清理

## 八、反思

这一轮我有两处判断错了、被第六版纠正：

- **「15 项 manifest 引用」** —— 我数的是「我列的检查项数」，不是引用数
- **`runTest` 说「已修」** —— 实际只修了 `runOcrTest`，两者的修复被我混为一谈

更根本的是：**我的「验证」反复把「改过了」当成「验过了」**。
P0-1 那次最典型 —— 打包、跑 verify-pack、看到「全部通过 ✓」就报了，
而那个「通过」证明的是两个同样过期的包一致。

第六版的判据 2（产物同源）正是治这个的，现在已经落成脚本检查了。

**未推送。** 工作区干净。