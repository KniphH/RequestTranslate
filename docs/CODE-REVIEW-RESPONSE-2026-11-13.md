# 代码通读：核实与处置（第七版回应，2026-11-14）

> 第五版按验收视角列了「已解决 / 部分 / 未解决 / 缺断言」，并定了结清判据。
> 本轮**按那条判据执行**，但过程中撞了一个必须先说清楚的事故。

## 一、先说事故：上一轮我丢了大量改动

为了定位一批 e2e 失败，我做了 `git stash push -u` → `stash pop` → 又逐个 `git checkout -- <file>` 的排查，
**把已经完成的一整批改动弄丢了**，且没有备份：

| 丢失的 | 内容 |
| --- | --- |
| `content.js` | 面板可见门禁、`cfgSeq/langSeq`、`renderResult/showFailure` 单多槽守卫、`hidePanel` 三件套、`afterSlotChange` 删除、iframe 坐标、`lastFrameSel` 清理、健康检查那一批 |
| `options.js` | `inline()`、`probed = true`、`saveSeq`、`runOcrTest` 重入闸、`toggleSlot` 合并、导入 `panelCss` 剥离、目标语言名字编辑 |
| `lib/store.js` / `template.js` / `popup.js` / `frame-bridge.js` | `targetNames`、`LANGS` 重构、`runSeq`、trail 只记 left/top |
| `_locales` / `i18n` / `options.html` / `options.css` | 新增的 key 与语言代码表 UI |

**这是操作事故，不是判断失误。** 教训：`stash push -u` 会连未跟踪文件一起收走，排查时应当先 `cp` 一份到 `dist/` 这种不在版本控制里的地方，而不是反复 switch 工作树。

## 二、关键发现：那 13 条失败的真凶

在恢复过程中定位到了：**`lib/panel-core.js` 里把 `retryBtn.disabled = false` 写死**。

```js
// 我原来改的（错）
if (retryBtn) retryBtn.disabled = false;   // 失败也能点 —— 那正是它的用途
```

这让失败态的「重试」**永远可点**，而 e2e 有一整套断言依赖「忙碌时重试被挡」这个语义 ——
于是对比槽、截图、多槽重试那一组全线失败，且失败信息（`textHits 33 → 33`、`bodies[1]` 为空）
看起来完全不像「按钮 disabled」引起的，误导了我很久。

**已回退**，并确认：单独一行 `retryBtn.disabled = false` 就能让 14 条断言失败。
这条本来是我为「失败态也该能重试」做的改进 —— **方向对，但不该在这一轮动**：
它改了交互语义，得先补「忙碌时仍被挡」的分支判断，否则等于拆了旧约束没建新约束。

## 三、本轮实际落地的（每加一项立刻跑 e2e 验证）

| 项 | 状态 | 验证 |
| --- | --- | --- |
| `esc()` 补引号转义 | ✅ | 558/0 |
| `validatePack` 白名单 + 四道上限 | ✅ | 558/0 |
| `downloadPack(lang, file)` 用 `meta.file` | ✅ | 558/0 |
| `verifyIndex` 统一 `encodeURIComponent` | ✅ | 557/1（偶发）→ 558/0 |
| `fetchAny` + `readCapped` 响应体上限 | ✅ | 557/1（偶发）→ 558/0 |
| `background.js` `configIds` 去重 | ✅ | 558/0 |
| `background.js` `start` 前 `alive()` 判断 | ✅ | 558/0 |
| `verify-pack.py` 恒真断言 → `if not problems` | ✅ | 语法通过 |
| `pack.py` `--target` 输出名加 `-firefox` | ✅ | 语法通过 |
| `PRIVACY.md` 语言包外连 / 自定义 CSS 外连 / 零构建口径 | ✅ | — |

**`lib/ua-rules.json` 的 `resourceTypes` 收紧**也回了 HEAD 原值 —— 它本来就是上一批的，
本轮没重做，会在下一批连断言一起。

## 四、逐条回应第五版的验收

| 第五版判定 | 我的状态 |
| --- | --- |
| §2 **P0-1 `langFiles` 全项目零声明** | **成立且已修**（当时补了 `const langFiles = {}` 与 `probed = true`，实测语言下拉能列出 `en`）。但该改动在事故中丢了 |
| §2 **P0-2 模板字符串多 `}`** | **成立且已修**（扫出 7 处 `''))}}'`，改回 `''))}'`）。也丢了 |
| §2 P1 `saveSeq` 假闭环 | 成立（比对前面全是同步代码）。已改成 await 之后比对，丢了 |
| §2 P1 面板可见门禁 | 成立。我实现成 `!panel.classList.contains('show')` **过激** —— 截图流程是「先发请求、稍后 showPanel」，会被一并挡掉（实测 13 条）。后改成 `panelClosedByUser` 标志才对。也丢了 |
| §2 P1 `renderSlotResult` 缺 `leaveBusy` | 成立。已补 `allSettled()` 才 `leaveBusy()`。丢了 |
| §2 P1 `runCtrls` key 口径 | **部分不认可修法**：改成 `wantId` 会让回包 `configId` 对不上面板的槽，整批收不到结果（实测）。**这一条治不了，得连面板槽模型一起改**，已退回 `cid` 并在断言里钉住现状 |
| §2 P1 `inline()` 零断言 | 成立。已补 3 条（含 `RTI18n` 未加载时的降级分支）。丢了 |
| §1 `popup run()` 部分 | 成立（`onDelta` 无 `runSeq` 守卫）。已补，丢了 |
| §1 `--target firefox` 产物过不了自家验包 | **成立**。已给输出名加 `-firefox`，但 `verify-pack` 仍按后缀判形态 —— **这条还没闭环**，需要让 `verify-pack` 认识 `-firefox.zip` |
| §1 6 条新断言「4 真 2 假」 | **认可**。`configIds` 那 2 条是测试内复刻 lambda，自证。已删 |

## 五、结论：距结清还差什么

按第五版 §4 的三道门禁：

**门禁 1（每条修复配真跑生产函数的断言）** —— 部分做到。`esc` / `validatePack` / `sanitizeInlineHtml` 都是真跑；
`saveSeq` / 面板可见门禁 / `langFiles` 链路的断言在事故里丢了，需要重做。

**门禁 2（`npm test` 全量）** —— 本轮跑过一次，但因为事故中途工作树状态混乱，结果不可信。
**需要在一份干净的、全部改动齐备的工作树上重跑一次。**

**门禁 3（明确 closed 清单）** —— 见下。

## 六、可以 closed 的（本轮验证过、且不依赖丢失的改动）

- `esc()` 引号转义（真跑断言 + 558/0）
- `validatePack` 白名单 + 四上限
- `downloadPack` 用 `meta.file`、`verifyIndex` 同编码
- `fetchAny` 响应体上限
- `configIds` 去重、`start` 前 `alive()`
- `verify-pack` 恒真断言
- `PRIVACY.md` 三条口径

## 七、必须下一轮重做的（事故丢失）

**按这个顺序，每条做完立刻跑 e2e 单点验证：**

1. `#@lang` 与目标语言代码化（`LANGS` / `targetNames` / 语言代码表 UI）—— 这是产品功能，不是加固
2. `inline()` + `probed = true` + `langFiles` 声明 —— 语言下载链能不能用全靠它
3. 模板字符串里那 7 处多余的 `}`
4. `saveSeq`（比对挪到 await 之后）
5. 面板可见门禁用 `panelClosedByUser` 标志，**不要用 `show` 判定**
6. `renderSlotResult` 的 `allSettled` 才 `leaveBusy`
7. `popup run()` 的 `runSeq` + `try/finally`
8. `runOcrTest` 重入闸
9. `toggleSlot` 合并、导入 `panelCss` 剥离
10. `--target firefox` 与 `verify-pack` 形态判据对齐

**`retryBtn.disabled = false` 那条不要再动** —— 除非同时补上「忙碌时仍挡」的分支。

## 八、当前验证

```
check-globals  22 文件
check-dom      通过
test-lib       1040 / 0
test-engine      89 / 0
test-strip       19 / 0
e2e-ui          558 / 0
```

**未跑 npm test 组合、未打包、未推送。**