# 全项目代码通读分析 · 第六版（2026-11-14 下午）

> **本版动笔前再次完整重读全部代码**：三路独立逐文件通读（content/面板组、options/popup 组、
> lib/后台/工具组），我自己逐条比 `file:line`、复跑 e2e、核包与源码是否同源。不用上一版结论代替重读。
>
> 基线：`manifest.json` **1.3.2**，**HEAD `ba23ae3`、工作区干净**（已提交 9 个 commit）。
> 实测 `test-lib` **1063/0**（文档仍写 1043）、`test-engine` 89/0、`test-strip` 19/0、
> `check-globals` 22 文件、`check-dom` 通过；**e2e 我复跑 = 557/0**（第九版声称属实）。
> 对应回应：`CODE-REVIEW-RESPONSE-2026-11-13.md` **第九版**（七类交叉验证 + npm test 全量 + 打包验证）。

## 1. 第九版「七类交叉验证」逐条验收

| 声称 | 验收 | 证据 |
| --- | --- | --- |
| 157 文件 / 52,857 行清点 | ✅ 口径成立 | 与仓库实际规模一致（剔除非运行时目录） |
| manifest 15 项引用全存在 | ✅ 文件都存在，**但「15」数不出来** | 字面 16 处、去重 13~14 个（icon 重复计 18）。**无测试钉这个数** |
| 265 key × zh/en 双向对照全通过 | ❌ **双向对照没做** | `en.json` 365 / `zh_CN` 367（只差 extName/extDesc）；代码实际用到 **157** 个；`test-lib:4205-4206` 只是分别 `validatePack(en)`、`validatePack(zh)`，**没有键集对照**，英文缺键会静默回落中文 |
| 20 设置项都有 UI 入口 | ⚠️ 口径不一 | `SETTING_MAP` 恰 20 行，但 `DEFAULT_SETTINGS` 有 **25 键**（triggerStyle/targetLang/targetNames/slotConfigs/hiddenHints 走别的 UI）；测试只断言 `>=14`(`:2823`) |
| engine/adapters 契约 19 字段一致 | ⚠️ **实测 18，且无断言** | `runRequest` 与 `emptyResult` 都是 18 个字段（ok…bytes），确实一致；但没有任何字段一致性断言，也没人钉 19 |
| 27 addEventListener / 4 setTimeout 清理配对全通过 | ⚠️ 部分 | `setTimeout` 4 处、`clearTimeout` **3 处**——`content.js:2141` 的 10ms 去抖无取消；27/4 这个数字无断言 |
| 运行时真跑 5 条主链路全通过 | ✅ 我复跑 e2e 557/0（单/多槽、划词、popup、设置页） | **但见 §3 P0-2：e2e 无 Edge 时会 `process.exit(0)` 静默跳过** |
| 打包：双包逐字节一致、118,296 B | ⚠️ **产物成立，但包是旧的** | 见 §3 P0-1：`dist/request-translate-1.3.2.zip` 生成于 **16:06**，仓库在 **16:18/16:21** 还提交了两次；包内 `lib/panel-core.js` **没有 `orderedLangCodes`**（仓库有 3 处引用、24,115 B vs 包内 23,589 B）。「双包一致」只证明两个同样过期的包一致 |
| 工具目录清理、文档数字同步 | ⚠️ 数字又漂了 | 删了 3 个临时文件 ✅；但 `DEVELOPMENT.md:353/404` 仍写 1043/1710，实测 **1063**、按 1063 重算应为 **1730**；后两个 commit 又加了断言没回头改文档 |

## 2. 第五版列的面板/状态项当前状态

| # | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| ① | 隐藏面板后消息重绘 | ✅ **已解决**（有范围缺口） | `content.js:1048-1063` `panelClosedByUser` 门禁拦 start/delta/done/fatal；缺口是 `ocr-*`(1066-1142) 不受它管，靠后台 abort 兜住（两层只剩一层） |
| ② | cfgSeq / langSeq 作废回滚 | ❌ **未解决** | 作废分支 `2628`/`2660` 只 `return`，而 `currentConfigId`/`slots`/`prefs.targetLang`/`resultCache.clear()` 在 await 前已改。可复现：上限 2、槽 [A,B]，快速拨 X 再拨 Y → A 被顶掉且回不来 |
| ③ | renderResult/showFailure/showNoCachedResult | ⚠️ 部分 | `renderResult:983`、`showFailure:686` 已加单槽守卫；`showFailure` 多槽分支**不落槽、只重画**（结果区仍显示旧译文）；`showNoCachedResult:1027` `outBox.textContent=''` **仍清空所有槽 DOM** 且不动 `slots` → DOM 与状态脱钩 |
| ④ | renderSlotResult 多槽 leaveBusy | ✅ **已解决** | `:1433` `if (slotBy(configId) && allSettled()) { leaveBusy(); ... }` |
| ⑤ | done/fatal `if (!sl)` 无条件 leaveBusy | ❌ **未解决** | `:1149-1152`、`:1179-1181` 仍是 `if (!sl) { leaveBusy(); setDot(...); return; }`——一条流被删槽/挤出时，其它在飞槽一起失去 busy 保护（`portGone` 不触发、防连点失效） |
| ⑥ | 同图重试 / lastFrameSel / 多槽守卫 | ⚠️ 部分 | 多槽守卫 ✅；`cacheKey` 仍是「长度+末 64 字符」不是真指纹；`lastFrameSel` 顶层 `mousedown`(2186) 只 hideTrigger 不清，过期 iframe 选区会被重新弹出 |
| ⑦ | TRIGGER_CSS 死代码 / 孤儿注释 | ❌ **未解决** | `content.js:115` 仍无引用；孤儿 JSDoc/空块仍在 249、605-606、1362-1368、1412-1413、1440-1446 |

## 3. 本轮最严重（按优先级）

### P0-1 产物与源码漂移，「双包一致」是过期自证

```
dist/request-translate-1.3.2.zip   16:06   118,296 B
仓库 HEAD                          16:21   ba23ae3（16:18/16:21 两个 commit 在打包之后）
包内 lib/panel-core.js：无 orderedLangCodes
仓库 lib/panel-core.js：3 处引用（含语言顺序统一）
```
`verify-pack` **不比对仓库内容**，所以「双包逐字节一致」「32 文件」「幂等」全过——但它证明的是
「两个 16:06 的旧包一致」。拿这个 zip 发布，等于发一份不含最新语言顺序修复的代码。

### P0-2 e2e 可以在「一条链路都没跑」的情况下全绿

`tools/e2e-ui.mjs:74-81`：找不到 Edge 或 `playwright-core` → `process.exit(0)`。
`npm test` 在 CI/新机器上会显示 1710 全绿，实际 UI 层零覆盖。至少要 `exit(1)` 或明确 stamp
「SKIPPED」并让 `npm test` 区分。

### P0-3 `probed = true` 写错函数（复制粘贴错位）

- 声明：`options.js:3627 let probed = false`（在 `bindUiLang` 内）
- 赋值：`options.js:3160 probed = true`（在**历史重翻**的 `finally` 里）
- `options.js` **非严格模式**（无 `'use strict'`），所以不会抛错——**上一版子代理「按钮卡死」的判断是错的**。
  真实后果有两条：① `bindUiLang` 的局部 `probed` 永远 false → 每次 focus/mousedown/click 都重跑
  `fetchIndex + 2×N 个 HEAD`，与 PRIVACY「不换语言就永远不联网」冲突；② 3160 隐式创建**全局** `probed`，
  污染 `onHistoryAction` 的收尾路径。

### P1（功能可见 / 会说谎的测试）

- **占位文案大面积不显示**：`content.js:638` 先 `classList.remove('empty')`，`:644-645` 才写
  `dataset.placeholder`，而 CSS 规则是 `.rt-out.empty::before`（`panel-core.js:560`）→
  「等待结果…」(`enterBusy`)、「点 ↻ 翻译」(`showNoCachedResult:1026`)、失败提示全是**空白**；
  只有 `start`(`:1080`) 的顺序是对的。OCR 开场「等待识别…」也会被覆盖。
- **`runTest` 重入窗口仍在，且与「已修」的说法相反**：`options.js:1497` 检查 disabled →
  `:1499 await persist` → `:1507` 才禁用；该窗口内按 Enter 能起第二条链，且整段无 try/finally。
- **`frame-bridge.js:83` 空引用崩溃**：`fr` 在找不到 iframe 时为 `null`（iframe 被移除、srcdoc 中转），
  `fr.left` 直接抛 TypeError，整个 frame 的桥接失效。
- **数字与口径**：`test-lib` 1063 vs 文档 1043；「265 key 双向」没做；契约实测 18 不是 19；
  20 vs 25 个设置键；`setTimeout` 4 处只有 3 处清理。
- **样式变量名错**：`panel-core.js:646/649` 用 `--rt-fg-dim` / `--rt-fg`，定义的是
  `--rt-text-dim` / `--rt-text` → 槽位头与配置名颜色失效为继承值。
- **后台未闭环**：done 口 `:590 alive()` → `await appendHistory` → `:609 done` 仍无二次判废；
  `runCtrls` 以 `config.id` 为键而图片模式 `pickRequestConfig` 忽略 configId（`store.js:401`）→
  多图槽收敛到同一 id；i18n 镜像**校验失败不试下一个**；`probe` GET 回退仍不消费 body、无上限；
  `loadPack` 仍不过 `validatePack`。
- **导入非 merge 的 `slotConfigs` 仍悬空**（`options.js:3825` 只换了 configs 子集，没重跑
  `normalizeSlots`）；`syncSlotsHint` 只截长度不过滤。
- **死代码残留**：`options.js:2778-2782` 一段被行注释吞掉的旧骨架字符串（语法合法、静默通过）；
  `content.js:115` TRIGGER_CSS；`panel-styles.js` 空壳（刻意保留，注释已说明）。

## 4. 结清判据（本版升级）

前五版的三道门禁（真行为断言 / 全量测试 / closed 清单）方向对，但本轮证明**验证工具本身也要被验**。
补三条，缺一条就不算结清：

1. **产物必须与 HEAD 同源**：打包后自动比对包内每个文件与 `git show HEAD:<path>`（或工作区）的哈希；
   不同源直接失败。现在的 `verify-pack` 只比对 zip↔xpi，比的是两份可能都过期的产物。
2. **e2e 无浏览器必须红**：`exit(0)` 改成 `exit(1)`，或输出显式 `SKIPPED` 且让 `npm test` 汇总里区分；
   否则「全绿」可能是零覆盖。
3. **数字与口径取脚本输出**：`test-lib` 项数、契约字段数、key 覆盖数、设置键数都由脚本打印并对账，
   不许手写（本轮 1043/1710/19/265/20 五处全部对不上）。

**按此判据，本轮可 closed**：①④（面板门禁、renderSlotResult）、`langFiles` 声明、popup `#lang`、
popup runSeq 主体、`toggleSlot` 合并、i18n 两侧编码统一、`runOcrTest` 闸门、`verify-pack` 恒真修复、
18 条真跑断言（i18n/esc 侧）。
**不可 closed**：②③⑤⑥⑦、§3 全部 P0（产物同源 / e2e 空跑 / probed 错位）、P1 全部。

**下一批顺序**：P0-1 产物同源校验 → P0-2 e2e 空跑 → P0-3 probed 错位 → 占位文案时序 →
`runTest` 重入 + `frame-bridge` null → ②⑤ 状态回滚/busy 收口 → 数字与口径对账 → P2 死代码清理。

## 5. 已解决 / 别重复做

- P0 注入链两端（`validatePack` 白名单+四上限 / `inline()` 白名单）、`esc()` 引号、编码统一、
  DNR 收紧并钉住断言、PRIVACY 口径——都已完成。
- `frame-bridge` trail、同图重试缓存、`probed` 声明位置之外的三件事（`langFiles` 声明、
  `toggleSlot` 合并、`runOcrTest` 闸门）、popup 语言下拉恢复——已落地。
- 1.3.2 双包形态正确、Firefox 已上架、T1~T6 收尾、CSS 合一——别当待办重新提。

## 6. 通读范围与版本记录

逐文件通读：`content.js`(2793) / `frame-bridge.js` / `lib/panel-core.js`(751) / `panel-styles.js` /
`trigger-styles.js`；`options.js`(4178) / `.html` / `.css` / `popup.*` / `offscreen.*`；
`background.js` / `lib/` 全部 .js + `ua-rules.json` / `i18n/*.json` / `manifest.json` / `PRIVACY.md` /
`check-globals.mjs` / `check-dom.mjs` / `pack.py` / `verify-pack.py` / `esbuild-minify.mjs`；
旁证 `test-lib.mjs` / `test-engine.mjs` / 两份回应文档 / 复跑 e2e。

**版本记录**：v1 建清单 → v2 下调三条严重度 → v3 标 P0 收口 → v4 认错 #8 归因 →
v5 按验收视角核实第六版回应 → **v6（本版）**：完整重读，验收第九版「七类交叉验证」，
新增「验证工具自身盲区」一类（产物同源、e2e 空跑、数字对账）。旧版细节在 git 与回应文件里。

**本轮未修改任何代码或配置**，只重写本分析文件与工作日志。
