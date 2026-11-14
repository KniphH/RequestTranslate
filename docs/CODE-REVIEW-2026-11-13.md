# 全项目代码通读分析 · 第八版（2026-11-14 深夜）

> **本版动笔前再次完整重读全部代码**：三路独立逐文件通读（content/面板组、options/popup 组、
> lib/后台/工具组），我自己逐条比 `file:line`、复跑 e2e、**实跑同源检查抓旧包**。不用上一版结论代替重读。
>
> 基线：`manifest.json` **1.3.2**，**HEAD `bc15199`、工作区干净**。
> 实测 `test-lib` **1087/0**、`test-engine` 89/0、`test-strip` 19/0、`check-globals` 22 文件、
> `check-dom` 通过；**e2e 我复跑 = 557/0**（回应声称属实；其日志里 21:16 那次 556/1 是修 OCR 顺序前的中间态）。
> 对应回应：`CODE-REVIEW-RESPONSE-2026-11-13.md` **第十三版**（第七版 P1 7 项 + P2 9 项 + 一条自省）。

## 1. 第十三版声称验收

| 项 | 声称 | 验收 | 证据 |
| --- | --- | --- | --- |
| P1-1 导入被旧存档顶回 | 闭 | ✅ **已解决** | `options.js:3872-3875` 导入时把 `PANEL_OWNED_SETTING_KEYS` 全标 `panelTouched`；`store.js:845-859` 按 `skip` 跳过（含 `imageConfigId` 分支） |
| P1-2 图片多槽 N-1 busy | 闭 | ✅ 实现，⚠️ **兜底仍会撞** | `store.js:399-419` multiSlot 落地；但 `getConfig` 找不到退 `configs[0]`、图片单条退 `imageConfigId` → 两个请求同 `cid`；`runCtrls` 以 `cid` 为键（`background.js:500`），后写覆盖、`delete` 不校验归属 |
| P1-3 done 判废窗口 | 闭（「前后都有 alive」） | ❌ **未闭环** | `background.js:594` 只有一道 `alive()`；`:605 await appendHistory` 之后到 `:616 safePost(done)` **无再判**。并发 4 槽时窗口被 storage 排队放大 |
| P1-4 pendingConfigId | 闭 | ✅ 已赋值 | `content.js:1687 pendingConfigId = picked`；但后台恒带 configId，兜底分支实际不可达（属死兜底，无害） |
| P1-5 失败/无缓存无提示 | 闭 | ✅ **已解决** | `showFailure:714-717`、`showNoCachedResult:1062-1065`、`enterBusy:665-668` 三处都改成「先写 dataset 再加 empty」 |
| P1-6 popup 接 i18n | 部分：语言列表已改 orderedLangCodes | ❌ **语言列表未改** | `popup.js:113` 仍是 `TARGET_PRESETS.slice()`，`popup.js` 全文无 `orderedLangCodes`；文案 i18n 也确实没做（回应自认部分） |
| P1-7 菜单标题死键 | 闭 | ✅ **已解决** | `background.js:65/69` 接 `msg()` |
| P2 同源检查 | 改「函数规模 + 导出名」，并「亲手造旧包验证能抓」 | ❌ **方向反了，旧包永远通过** | 见 §2 P0-2 |
| P2 口径自检 | 每数带口径 + 「代码 key ⊂ zh 包」断言 | ✅ 已落地 | `test-lib.mjs:4567-4574`，实测打印「代码 key ⊂ zh 包 是」 |
| P2 esbuild 行号文档 | 改成实事求是 | ⚠️ 部分 | `pack.py:13-17`、`DEVELOPMENT.md:439` 改了；`verify-pack.py:6` 仍写「行数必须一模一样」、`ROADMAP.md:90` 仍承诺行号对齐 |
| P2 Firefox 字段剥离 | 剥 minimum_chrome_version / DNR / offscreen | ⚠️ **双向都不干净** | xpi：字段剥了，但 **`declarativeNetRequest` 权限仍在**、`ua-rules.json` 仍打进包、内置 bilibili 配置与 `PRIVACY.md:15` 仍宣称靠 DNR 补头（火狐上必被风控拦）；zip：反而带 `browser_specific_settings`（gecko，Chromium 未知键） |
| P2 use strict 位置 | 移到 IIFE 首语句 | ✅ 已解决 | `panel-core.js:24`、`i18n.js:16` |
| P2 死代码清理 | 6 个 `</p>`、3 个死 CSS、`var st`、start 清 DOM | ⚠️ 部分 | `options.js:2802-2806` 旧 `shellHtml` 拼接（含 `</button>'`）仍在；`applyDelta` 多余空块(960-962)；`renderSlots` 双 JSDoc(1407-1428) 仍在；`slotHtml` 注释仍挂在 `slotStatus` 上 |
| P2 isComposing / moveConfig | 已加 / 两份名单都重排 | ✅ 基本 | `options.js:1335`；`:687-688`、`:2130-2131` 两份都排；⚠️ 删除配置(`1323-1325`)只摘文字名单 |
| P2 PRIVACY 中英 11 条 | 对齐 | ⚠️ 部分 | 英文 `:51-54` 少了「整张图也会发」「默认 Bing」两句，与中文 `:13` 不等价；「最后更新」仍写 11-08 |

## 2. 本轮最该先看的三条

### P0-1 OCR 自建供应商会被复制、越滚越多（本轮引入、**已进 1.3.2 包**）

`lib/ocr.js:284` 起：`for (const p of saved) pushOne(p)` → `for (const d of OCR_PROVIDERS) pushOne(d)`
→ **`for (const p of saved) { if (builtin) continue; providers.push(normalizeOcrProvider(p)) }`**。
第三段把「用户自建的供应商」**又 push 一遍**（第二段的 `pushOne` 已经加过，第三段没有 `placed` 检查）。
实测 `normalizeOcrState({providers:[my-own]})` → `my-own, 3×内置, my-own`；每次 `loadState` 再
`persist` 就多一份，列表重复、排序/删除随之失真。**包内已含这段代码**（`BUILTIN_OCR_IDS.includes` 在包里）。
测试为何全绿：`test-lib:1039` 只断言「最后一条 id 是 my-own」，重复项照样过；e2e 只覆盖内置供应商。

### P0-2 「与源码同源」的方向是反的 —— 旧包永远通过

`verify-pack.py:206-213` 唯一判断是 `if sf > 3 and pf > sf * 1.20: "包内函数数多于源码 → 包比源码新"`。
也就是说它只抓「包比源码新」，**旧包（函数更少）永远不报**——而「包是旧的」恰恰是这检查存在的理由。
实测拿 `dist/request-translate-1.3.1.zip` 对 HEAD：content 187→181、store 51→50，函数项 **0 条红**；
5 条红全来自导出名。导出锚点又只认 `export function`，**漏 `export const`**（全仓 32 个）。
「亲手造旧包验证」只在回应文字里，仓库无夹具/脚本，且只验了导出名那一侧，没验「函数更少」这一侧。

### P1 两处「声称改了、实际没改」

- `popup.js:113` 仍是 `TARGET_PRESETS.slice()`（P1-6 声称已改 `orderedLangCodes`）。
- `options.js:2935` 预览又读 `s.activeConfigId`（`s = state.settings`，该字段在 state 顶层）→ **恒 undefined**，
  配置下拉永远停在第一条。这个坑第六版修过一次，本轮回归。

其他未闭环：`$1$` 替换正则 `/\$(\d+)/g` 不消费尾部 `$`（装英文包后显示「链上共 3$ 条」）；
`applyI18n` 二次调用冲掉动态标题；`persist` 无 try/catch、导入分支无 finally（`panelTouched` 可能永久残留）；
合并导入不跑 `normalizeSlots` 且不补 `imageSlotConfigs`；`refreshShellText`(265-267) 把「点 ↻ 翻译」冲回
「等待结果…」；`showNoCachedResult` 的 `setDot/setStatus` 误缩进在 for 循环体内；content 状态行仍大面积硬编码中文。

## 3. 结清判据（第八版）

前七版的门禁继续有效，本版只补「**方向性**」——一个检查只朝一个方向看，等于没看：

1. **同源必须双向**：既抓「包比源码新」也抓「包比源码旧」。最省事的做法：包内每个 `.js` 与
   `git show HEAD:<path>` 的等价形式（剥注释/压缩后）**逐文件哈希**；做不到哈希就至少双向比函数数
   （`abs(pf - sf) > 0` 即红），并把 `export const` 纳入锚点。
2. **验证器要有夹具**：用一个**真旧包**（如 1.3.1）进 CI 跑一次，必须变红；否则「它能抓旧包」永远只是声称。
3. **行为断言覆盖非默认数据**：自建供应商、自定义语言行、用户改过的槽位顺序——这些才是排序/归一化
   逻辑最容易翻车的地方，只测内置项等于没测。
4. **数字必须同一时点**：`test-lib` / `e2e` 的数字要一次跑出来一起贴；本轮「557/0 连跑两遍」出自
   19:30 的日志，而 21:16 的日志是 556/1，两者中间又加了断言。

**按此判据，可 closed**：P1-1、P1-5、P1-7、use strict、口径自检、isComposing、moveConfig、
`showFailure` 占位、`pendingConfigId` 赋值、导入 panelTouched。
**不可 closed**：P0-1（OCR 重复）、P0-2（同源方向）、P1-2 兜底、P1-3（done 判废）、P1-6（popup 语言列表）、
esbuild 行号文档、Firefox 权限/文档、死代码、PRIVACY 英文。

## 4. 已解决 / 别重复做

- 注入链两端、`esc()`、`code`/`meta.file`、DNR 收紧、`frame-bridge` trail/`fr` 守卫、CSS 变量、
  `TRIGGER_CSS` 删除、`cacheKey` 采样、`toggleSlot` 合并、`runOcrTest` 闸门、`probed` 归位、
  `runTest` 重入、e2e `exit(1)`、OCR 顺序根因（顺序部分是对的，重复是新增的）。
- 1.3.2 双包形态基本正确、Firefox 已上架、T1~T6 收尾、CSS 合一——别当待办重新提。

## 5. 通读范围与版本记录

逐文件通读：`content.js`(2865) / `frame-bridge.js`(90) / `lib/panel-core.js`(776) / `panel-styles.js` /
`trigger-styles.js`；`options.js` / `.html` / `.css` / `popup.*` / `offscreen.*`；`background.js` /
`lib/` 全部 .js + `ua-rules.json` / `i18n/*.json` / `manifest.json` / `PRIVACY.md` /
`check-globals.mjs` / `check-dom.mjs` / `pack.py` / `verify-pack.py` / `esbuild-minify.mjs`；
旁证 `test-lib.mjs` / 两份回应文档 / 复跑 e2e / 用 1.3.1 旧包实测同源检查。

**版本记录**：v1 建清单 → v2 下调严重度 → v3 标 P0 收口 → v4 认错 #8 归因 → v5 验收第六版 →
v6 首提「验证工具也要被验」 → v7 把锚的强度写进判据 → **v8（本版）**：完整重读，验收第十三版，
新增「方向性」判据（同源双向、验证器要有夹具、断言要覆盖非默认数据）。
**本轮未修改任何代码或配置**，只重写本分析文件与工作日志。
