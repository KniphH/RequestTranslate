# 全项目代码通读分析 · 第七版（2026-11-14 傍晚）

> **本版动笔前再次完整重读全部代码**：三路独立逐文件通读（content/面板组、options/popup 组、
> lib/后台/工具组），我自己逐条比 `file:line`、复跑 e2e、重算数字口径。不用上一版结论代替重读。
>
> 基线：`manifest.json` **1.3.2**，**HEAD `51a94db`、工作区干净**（回应里写的 `61c034d` 是上一提交）。
> 实测 `test-lib` **1075/0**、`test-engine` 89/0、`test-strip` 19/0、`check-globals` 22 文件、
> `check-dom` 通过；**e2e 我复跑 = 557/0**；`dist/request-translate-1.3.2.zip` 18:32 生成、
> 内含 `normalizeSlots`（代码层与 HEAD 同源）。
> 对应回应：`CODE-REVIEW-RESPONSE-2026-11-13.md` **第十二版**（第十、十一版修了第六版的 3 P0 + 5 P1）。

## 1. 第十二版声称验收

| 声称 | 验收 | 证据 |
| --- | --- | --- |
| 导入后槽位悬空已修 | ✅ **已解决** | `lib/store.js:281 export function normalizeSlots`；`options.js:20` import、`:3843` 在整份替换分支调用 |
| 孤儿注释「核查为 0 处」 | ⚠️ **旧行号确实被覆盖，但新孤儿仍在** | `content.js:271-272`（讲「单条模式尾部操作条」却接 `mount()`）、`:113-122` 的钉住说明被插进了 `panelClosedByUser`、`:1396-1402` 与 `:1403-1417` **两块 JSDoc 叠在同一个 `renderSlots`**、`:1446`/`:1474-1479` 连续空行；`panel-core.js:123-129` 的 `slotHtml` 注释被 `slotStatus` 隔断 |
| 口径自检（脚本打印，照抄进文档） | ✅ 脚本能打印，**但口径不透明** | `test-lib.mjs:4496-4501` 打印 1075/365/365/265/25；同一件事三种数：回应 **265**、我本版实测 **288**（含双引号/全部文件）、上一版报告 **157**——差别全在统计正则与扫描范围；「25 键」不含 `langOrder`/`imageSlotConfigs`（`store.js:207-250` 缺、`options.js:4112` 写、`store.js:292` 归一化） |
| `verify-pack` 与源码同源（5 个标记） | ⚠️ **是 5 个字符串标记，不是逐文件哈希** | `verify-pack.py:178-199` 自注释「改为关键标记存在性」；只查 `orderedLangCodes`×3、`Math.round(...panelSlots)`、`normalizeHistoryMax`。**store/engine/ocr/popup/options.css 无任何标记**；包内 `content.js` 的函数名已被 esbuild 压掉（`imageFingerprint` 不存在），这类改动根本当不了标记 |
| e2e 环境缺失 `exit(1)` | ✅ **已解决**（提示无效） | `e2e-ui.mjs:76-85` 两处 `exit(1)`；但 `:78` 提示「设置 E2E_BROWSER」，全仓只此一处出现、代码从不读它 |
| `TRIGGER_CSS` 删除 / `cacheKey` 多段采样 | ✅ 已落地 | `content.js` 已无该声明；`05081c5` 的多段采样在包内（`\x01img|` 标记在） |
| 两处下拉作废回滚 | ⚠️ **语言那处等于没修** | 见 §2 ⑤ |
| `loadPack` 不过 `validatePack`（保留分歧） | ⚠️ 理由基本成立，**漏了第二读取口** | 唯一写入口确是 `downloadPack`；但 `i18n-msg.js:18-28 getDownloaded()` 供右键菜单标题用，同样不校验、四道上限全失效。回应没覆盖这条 |

## 2. 第六版列项的现状（①~⑧）

| # | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| ① | `TRIGGER_CSS` 死代码 | ✅ **已解决** | 只在注释里出现（137/212/781），样式唯一来源 `panel-core.js:267-327` |
| ② | 占位文案时序 | ⚠️ **部分**：`enterBusy`(667-668)、`showNoCachedResult`(1053-1055) 已改成「先写 placeholder 再加 empty」✅；**`showFailure` 仍是死代码**——`701` 写 `dataset.placeholder` → `702` `classList.remove('empty')`，`.rt-out.empty::before`(panel-core:560) 永不生效，失败时结果区一片空白 | `content.js:697-725` |
| ③ | `frame-bridge` `fr` 空引用 | ✅ **已解决** | `frame-bridge.js:85 if (!fr) return;`（消息整条丢弃，桥接链会断但不崩） |
| ④ | CSS 变量 `--rt-fg` / `--rt-fg-dim` | ✅ **已解决** | 全仓已无该引用；定义的是 `--rt-text`(353/401)、`--rt-text-dim`(354/402) |
| ⑤ | 下拉作废回滚 | ⚠️ **配置半解决、语言未解决** | 配置：`:2633` 快照 → `:2661-2667` 回滚三件事，但（a）时序逆向——A 挂起时 B 以 A 改过的状态为基线执行完，A 恢复时用旧快照把 **B 的改动整份抹掉**；（b）`slots.slice()` 浅拷贝，槽对象已被就地改写回不去；（c）不还原下拉显示。语言：`:2691` 先 `prefs.targetLang = v`，`:2694` 才拍快照 → `:2703` 回滚成空操作 |
| ⑥ | `done`/`fatal` 的 `if (!sl)` | ✅ **已解决**（另有残留） | `:1180-1186`、`:1212-1216` 改为 `if (allSettled()) leaveBusy();`；但 `:2673-2674` cfgSelect 命中缓存、`:1048` `showNoCachedResult` 仍无条件 `leaveBusy()` |
| ⑦ | `showFailure` 多槽 / `showNoCachedResult` 清空 | ⚠️ **部分** | `showFailure:719-721` 多槽仍只 `renderSlots()` 重画旧内容、不落槽；`showNoCachedResult:1056-1058` 改为 `renderSlots()` 但**不重置槽状态/文本**——旧译文还在屏上，状态栏却写「点 ↻ 翻译」；单槽路径清 DOM 但不清 `slots[0].text`，下次 `renderSlots()` 会把旧译文搬回 |
| ⑧ | 注释与代码不符 | ⚠️ **部分** | `renderResult`(986-1006) 已改对 ✅；**`renderSlotResult` JSDoc(1448-1453) 仍说「这里没有分支」**而代码 `:1462-1472` 恰有 if/else；`trigger-styles.js:5/12` 仍宣称导出 `TRIGGER_CSS`、content.js 抄了一份 CSS |

## 3. 本轮新发现（按严重度）

### P1 · 用户可感知

1. **导入的设置在落盘时被旧存档顶回**（新，本轮最实的一条）。导入后 `options.js:3855 await persist()` →
   `persist` 里 `:3895 adoptPanelOwned(state, saved, panelTouched)`；该函数（`store.js:834-847`）对
   「没动过的键」**一律取 `saved`**（= 导入前的存档）→ 导入包里的 `targetLang` / `showOriginal` /
   `ocr.imageConfigId` 被静默改回旧值。`panelTouched` 为空时百分百发生。
2. **图片模式多槽会 N-1 个槽永久 busy**：content 把一屏所有槽 id 发出去（`:1705-1709`），
   而 `pickRequestConfig` 在 `hasImage` 时**无视 configId、一律回 `imageConfigId`**（`store.js:401`）→
   同 cid 撞 Map（`background.js:494-496`），只有一条流能回包，其余槽永远「翻译中…」。
3. **`done` 判废窗口仍在**：`background.js:595 alive()` → `:601 await appendHistory` → `:612 done`
   无二次判废；`:611 runCtrls.delete(cid)` 还会摘掉新批次刚建的同 cid controller。
4. **`pendingConfigId` 从未赋值**：`:77` 声明后，`05081c5` 删掉赋值，`:1179/1211` 的兜底归档是死分支。
5. **失败/无缓存时没有提示**：`showFailure` 的占位是死代码（§2 ②）；`refreshShellText`(265-267)
   只要 `empty` 就改写成「等待结果…」，会把「点 ↻ 翻译」冲掉。
6. **popup 未接 i18n**（0 个 `data-i18n`，文案全硬编码）；语言列表取 `TARGET_PRESETS` 而非
   `orderedLangCodes`（自定义顺序/新增语言丢失）；两个 change 整份 `saveState`，无 `adoptPanelOwned`。
7. **右键菜单标题死键**：`background.js:62-67` 未给 `ocrMenuItem`/`shotMenuItem` 传 title，
   `i18n/en.json:11-12` 的 key 全仓无人引用 → 英文界面菜单仍中文（疑似上一轮修完又被重构冲掉）。

### P2 · 工具、口径与卫生

- **同源检查强度不足**（§1）：5 个标记 ≠ 逐文件同源；`verify-pack` 也不校验 manifest 引用的
  资源是否存在（`ua-rules.json`/icons/`offscreen.html`/css 写错照样全绿），不验任何 `.json`。
- **口径不自证**（§1）：265/288/157 三个数并存；「25 键」与 `DEFAULT_SETTINGS` 的真实覆盖面不符。
- **esbuild 后行号不守恒**：包内 `background.js` 1 行、`content.js` 34 行；`pack.py:10-14` 与
  `DEVELOPMENT.md:439` 仍承诺「报错栈行号对得上源码」。
- **Firefox 包仍带 Chromium 字段**：`minimum_chrome_version`、`offscreen` 权限、`declarative_net_request`。
- `panel-core.js:24-32` 的 `'use strict'` 在函数声明之后，不构成指令序言，整个 IIFE 实际非严格模式。
- 死代码/注释残留：`options.js:2789-2793` 被行注释吞掉的旧骨架字符串、`options.html` 6 个多余 `</p>`、
  无引用 CSS 类（`.pv-wrap`/`.pv-host`/`.lang-name-row`）、`panel-core.js:157-160` 的死赋值、
  `content.js:1108-1113` 单槽 start 清空 DOM 却保留 `sl.text`（与 1714-1717 注释矛盾）。
- 其他：测试框 Enter 不判 `isComposing`（中文输入法回车即发送）、`moveConfig` 只重排
  `slotConfigs` 不重排 `imageSlotConfigs`、`PRIVACY.md` 英文版缺 bilibili/DNR 两段。

## 4. 结清判据（第七版）

前六版的三道门禁（真行为断言 / 全量 / closed 清单）＋上一版三锚（同源 / e2e 不许空跑 / 数字取脚本）
方向都对，但本轮证明**锚的强度也要写进判据**。补齐如下，缺一条就不算结清：

1. **同源 = 逐文件哈希**：包内每个 `.js`（至少）与 `git show HEAD:<path>` 的剥注释/压缩等价形式比对；
   不允许「5 个标记在就算同源」。
2. **口径自检必须打印口径**：正则模式、扫描文件清单、以及「代码 key ⊂ 包 key」的断言；
   文档数字只能抄脚本输出。三种数并存说明口径没定义。
3. **回滚用深拷贝 + 单调序号 + 回滚后同步 DOM**：`slots.slice()` 不够（对象就地改写）；
   语言快照必须拍在赋值**之前**；作废后要把 `cfgSelect.value`/标题一起还原。
4. **导入 = 全量替换**：`persist` 前清空 `panelTouched` 或跳过 `adoptPanelOwned`，
   否则导入包里的目标语言/显示原文/图片配置会被旧存档顶回。
5. `showFailure` / `showNoCachedResult` 与 `enterBusy` 用同一个占位写法（先 dataset 再 add empty），
   并补一条「失败态结果区有文案」的行为断言。

**按此判据，可 closed**：①③④⑥、`TRIGGER_CSS`、`cacheKey` 采样、导入槽位归一化、`probed` 归位、
`runTest` 重入、e2e `exit(1)`、口径自检脚本本体、`langFiles` 声明、popup `#lang`。
**不可 closed**：②⑤⑦⑧、§3 全部 P1（尤其导入覆盖、图片多槽、done 窗口）、同源强度、口径定义。

## 5. 已解决 / 别重复做

- P0 注入链两端、`esc()` 引号、`code`/`meta.file`、DNR 收紧、PRIVACY 口径、`frame-bridge` trail、
  同图重试缓存、`toggleSlot` 合并、`runOcrTest` 闸门、菜单标题接 `msg()`（但本轮疑似回归，见 §3.7）、
  预览顶栏 `activeConfigId`、`verify-pack` 恒真断言、`e2e exit(1)`、`probed` 归位。
- 1.3.2 双包形态正确且与 HEAD 代码同源、Firefox 已上架、T1~T6 收尾、CSS 合一——别当待办重新提。

## 6. 通读范围与版本记录

逐文件通读：`content.js`(2841) / `frame-bridge.js`(90) / `lib/panel-core.js`(775) / `panel-styles.js` /
`trigger-styles.js`；`options.js` / `.html` / `.css` / `popup.*` / `offscreen.*`；
`background.js` / `lib/` 全部 .js + `ua-rules.json` / `i18n/*.json` / `manifest.json` / `PRIVACY.md` /
`check-globals.mjs` / `check-dom.mjs` / `pack.py` / `verify-pack.py` / `esbuild-minify.mjs`；
旁证 `test-lib.mjs` / `test-engine.mjs` / 两份回应文档 / 复跑 e2e。

**版本记录**：v1 建清单 → v2 下调严重度 → v3 标 P0 收口 → v4 认错 #8 归因 → v5 验收第六版回应 →
v6 验收第九版「七类交叉验证」、首提「验证工具也要被验」 → **v7（本版）**：完整重读，验收第十二版，
把「锚的强度」写进结清判据（同源改哈希、口径写明、回滚深拷贝、导入跳过 adopt）。
**本轮未修改任何代码或配置**，只重写本分析文件与工作日志。
