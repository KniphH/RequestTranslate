# 全项目代码通读分析 · 第九版（2026-11-15 凌晨）

> **本版动笔前再次完整重读全部代码**：三路独立逐文件通读（content/面板组、options/popup 组、
> lib/后台/工具组），我自己逐条比 `file:line`、复跑 e2e、**实跑同源检查的旧包夹具**。不用上一版结论代替重读。
>
> 基线：`manifest.json` **1.3.2**，**HEAD `0ff4833`、工作区干净**。
> 实测 `test-lib` **1088/0**；**e2e 我复跑 = 557/0**；`test-engine` 89、`test-strip` 19（前轮确认）。
> 对应回应：`CODE-REVIEW-RESPONSE-2026-11-13.md` **第十四版**（第八版两个 P0 全认 + 数字时间戳机制）。

## 1. 第十四版声称验收

| 项 | 声称 | 验收 | 证据 |
| --- | --- | --- | --- |
| P0-1 OCR 自建供应商重复 | 已修，断言改成「只出现一次 + 保持顺序」 | ⚠️ **代码已修、断言只覆盖一半** | `lib/ocr.js:286-287` 只保留 `pushOne` 两轮（第三段已删）；`test-lib:1041-1044` 断言「只出现 1 次 + 顺序」方向正确，但只测 2 条 saved、**没测「连续两次 normalize」**（原 bug 就是每次读档累积）、没测 saved 内重复 id、没测新内置是否真追加尾部；另 `:4525-4534` 仍是**源码正则**（检查两个 for 的先后）——重构即红、行为错却绿 |
| P0-2 同源双向 | 加了反向判 + 导出锚点扩到 const/let/class，1.3.1 夹具 8 条红 | ⚠️ **判据本身几乎恒绿** | `verify-pack.py:211-226` 确有 `elif sf > pf * 1.25`；但 esbuild **不改 `function`/`=>` 计数**——实测 1.3.2 包 21 个 .js 的 `pf/sf` 全为 **1.000**，20%/25% 的余量大一个数量级；拿 1.3.1 旧包实跑：`content 187→181(−3%)`、`store 51→50` 仍判绿，**12 条红全靠导出名**（不是函数数）。夹具无脚本/无 CI 入口，只能手跑 |
| P1 popup 语言列表 | 改用 orderedLangCodes | ✅ **已解决** | `popup.js:6 import`、`:116` 调用；但 `test-lib` 无 popup 断言（`:2315` 只查 options/content），回归未钉 |
| P1 预览 activeConfigId | 改读 state 顶层 | ✅ **已解决** | `options.js:2936 state.activeConfigId` |
| P1-2 图片多槽兜底 | 多槽绝不退回 imageConfigId | ✅ 实现，⚠️ 残余 | `store.js:407-417`；但 cid 不存在时 `getConfig` 仍回落 `configs[0]`，多槽仍可能同 id |
| P1-3 done 判废 | appendHistory 后加 alive + ctrl 归属 | ✅ **已解决** | `background.js:618` alive、`:622 runCtrls.get(cid) === ctrl`；但 `test-lib:3345` 只是数 `delete(cid)` 出现次数，**没行为化** |
| `$1$` 正则 | 改 `/\$(\d+)\$?/g` | ✅ 本体已解决 | `i18n.js:59`，实测 `$1$`→`3`、`$1`→`3`、缺参保留 `$1$`、无 `3$` 残留。但 content 的 `T()` 只收 2 参（`:141-147`），`:1533/1537/1540/1544` 仍手工 `.replace('$1$',…)`，`i18n-msg.js` 不替换——**四套口径**，无 substitute 单测 |
| manifest 双向裁剪 | xpi 去 DNR/offscreen 权限、zip 去 gecko | ✅ **权限层已解决** | 实测 zip 无 `bss`、xpi 无 `min_chrome`/`DNR`/`offscreen` 权限；但 **xpi 仍打进 `ua-rules.json` + `offscreen.html/js`**（两包都 32 文件 → 火狐包带 3 个死文件）；`store.js:56/60`、`PRIVACY.md:15`、`firefox/AMO-审核说明.md` 仍宣称靠 DNR 补头，**火狐上 bilibili 必被风控拦** |
| 行号文档 | 已改 | ✅ | `verify-pack.py` 头注与 `ROADMAP.md` |
| 死代码 / 缩进 / persist / 合并导入 | 已清 / 已补 | ⚠️ 部分 | `showNoCachedResult` 缩进 ✅、双 JSDoc 已清 ✅；`options.js:271` 孤儿 JSDoc 仍在、`panel-core:125-137` 注释仍挂错；`persist` try 不覆盖 `collectEditor`、import 分支无 `finally`（`panelTouched` 失败即残留）；合并导入补了 `normalizeSlots`，但该函数**不会把新配置加进 `imageSlotConfigs`**，注释承诺的能力不存在 |
| 数字时间戳机制 | `.test-counts.json` + 汇总打印 | ⚠️ 半成品 | 机制真实存在（`test-lib:4587` 等写入、`test-summary` 读后删）；但 `order` 里 `'静态'` 桶**无人写**、汇总恒 4 项；我 cat 时只剩 `{"test-lib":1088}` |

## 2. 本轮最重要的三条（新发现）

### P0-1 「e2e 不许空跑」的连锁：干净机器上 `npm run pack` 必失败

`tools/pack.py:364-370 run_tests()` 打包前跑 `npm test`；而 `npm test` 含 e2e，`e2e-ui.mjs:79-85`
在缺 playwright-core 时 `exit(1)`。`package.json` 的 devDependencies **只有 esbuild**，没声明
playwright-core。于是：新机器/CI 上打包 → e2e 失败 → 打包中止。方向（不许把没测伪装成测过）是第六版
建议的，但**没区分「环境不全」与「测试失败」**——前者应 SKIP + 明确警告，后者才该红。

### P0-2 同源判据第三次选错「代理指标」

三次迭代：字符串字面量全包含（误报 781 段）→ 字面量总长（方向反）→ **函数计数**（esbuild 不改它，
恒等）。共同点：都在找「不真比对也能判断」的廉价代理。而且 `verify-pack.py:207-208` 的
`compared += 1` 写了两遍 → 打印「**42 个 .js**」（实际 21 个），回应里的「42 个 .js 同源」就是
这个 bug 的产物——数字又被自己骗了一次。

### P1 面板侧的新/旧未闭环

- `cfgSelect` 命中缓存后 `renderSlotResult(...)` 紧跟**无条件 `leaveBusy()`**（`content.js:2686-2690`）：
  多槽其余条还在飞时清掉全局 busy，与 `renderSlotResult:1472-1477`「settled 才 leaveBusy」自相矛盾。
- `start` 多槽分支丢弃 `msg.statusText`（`:1127`），多模型轮询提示看不到。
- **「点 ↻ 翻译」指向不存在的按钮**：`shellHtml` 里只有 pin/src/close，单槽空态没有 ↻ 可按（`:88-92`）。
- `refreshShellText` 只刷 4 处 title/placeholder，**不刷状态行、不刷图钉 title**，且 `:265` 会把
  `showNoCachedResult` 的「点 ↻ 翻译」、`showFailure` 的「没有返回内容」冲回「等待结果…」。
- `showFailure` 多槽仍只 `renderSlots()`、不落槽（`:718-722`）；`renderSlotResult:1476` 全失败时
  `setStatus(settledSummary())` 不带 `'err'` 语气。

### P2 仍欠（回应自己列的 + 新发现）

`applyI18n` 仍跑两次（`:188/:219`）→ 直传模式重载后标题被改回「OCR 配置」；
content 状态行几十处硬编码中文（`1018/1061/1070/1118/1127/1147/1400-1406/2349/2395/2732`）；
`PRIVACY.md:51-54` 英文写「Only the text … is sent」，与中文 `:13`「直传时整张图也发给它」「默认 Bing」
**直接矛盾**（事实错误，不是措辞差异）；删除配置只摘 `slotConfigs` 不摘 `imageSlotConfigs`（`:1323-1325`）；
合并导入按 name 覆盖却保留文件里的 id → 可产生**同 id 双配置**；`test-lib:4367-4388` 两个 check 嵌在
另一个 check 的 IIFE 实参里靠副作用执行；`trigger-styles.js:6-13` 头注仍宣称 content.js 手抄 CSS、
`DEFAULT_TRIGGER_SIZE=45` 与默认 28 不一致。

## 3. 结清判据（第九版）

1. **同源改用逐文件哈希**：函数计数在 esbuild 下恒等，不可用。包内每个 `.js` 与
   `git show HEAD:<path>` 的「剥注释 + esbuild 压缩」等价形式比 md5；至少 21 个 .js 全比。
   `compared += 1` 这类计数 bug 一次清掉。
2. **夹具进 `npm test`**：1.3.1 旧包必须让检查变红，且这条要在测试里跑，不是手跑一次就算。
3. **环境不全 ≠ 测试失败**：e2e 缺浏览器 → SKIP + 显式警告（可被 `--require-e2e` 升级为失败），
   否则 `npm run pack` 在新机器上必断；playwright-core 若必需，写进 devDependencies。
4. **断言不许用源码正则**：`multiSlot`、`done 判废`、OCR 顺序的「源码形状」断言都要改成行为断言
   （构造两条同 cid 的请求，看 Map 是否互盖；连续两次 normalize 看数量是否稳定）。
5. 前三版的门禁（真行为断言 / 全量 / closed 清单 / 同源 / 数字同一时点）继续有效。

**按此判据，可 closed**：P1 popup 语言列表、预览 activeConfigId、done 判废代码、multiSlot 代码、
`$1$` 正则本体、manifest 权限双向裁剪、showNoCachedResult 缩进、行号文档。
**不可 closed**：P0-1 断言覆盖、P0-2 同源判据、e2e 打包连锁、面板 leaveBusy/占位/多槽失败、
applyI18n 二次覆盖、状态行 i18n、PRIVACY 英文事实错误、删除配置名单、合并导入同 id、
test-lib 结构、trigger-styles 头注。

## 4. 已解决 / 别重复做

注入链两端、`esc()`、`code`/`meta.file`、DNR 收紧、trail/`fr` 守卫、CSS 变量、`TRIGGER_CSS` 删除、
`cacheKey` 采样、`toggleSlot` 合并、`runOcrTest` 闸门、`probed` 归位、`runTest` 重入、e2e `exit(1)`、
OCR 顺序本体、popup 语言列表、预览 activeConfigId、done 判废、multiSlot、`$1$` 正则、manifest 权限裁剪。

## 5. 通读范围与版本记录

`content.js`(2865) / `frame-bridge.js` / `lib/panel-core.js`(776) / `panel-styles.js` /
`trigger-styles.js`；`options.js` / `.html` / `.css` / `popup.*` / `offscreen.*`；`background.js` /
`lib/` 全部 .js + `ua-rules.json` / `i18n/*.json` / `manifest.json` / `PRIVACY.md` / `pack.py` /
`verify-pack.py` / `esbuild-minify.mjs` / `check-*.mjs`；旁证 `test-lib.mjs` / 复跑 e2e /
**用 1.3.1 旧包实跑同源检查（12 条红）**。

**版本记录**：v1 建清单 → v2 下调严重度 → v3 标 P0 收口 → v4 认错 #8 归因 → v5 验收第六版 →
v6 首提「验证工具也要被验」 → v7 锚的强度 → v8 方向性（同源双向/夹具/非默认数据） →
**v9（本版）**：验收第十四版，指出「函数计数」在 esbuild 下恒等（同源第三次选错代理指标）、
e2e `exit(1)` 导致干净机器打包必断；并按 kniph 要求增补 §6 编辑评价。
**本轮未修改任何代码或配置**，只重写本分析文件与工作日志。

## 6. 编辑评价（2026-11-15 凌晨，kniph 要求把评分写进文件）

> 本节不是工单，是判断。前五节是可执行条目，这里回答「这个作品现在处于什么位置」。
>
> **评分口径**（先写清，避免把不同性质的东西混进一个分数——这也是前几版吃过亏的地方）：
> 「工程纪律」只看代码/测试/构建的**可验证状态**；「变更收敛」看**每批修复是否闭环**；
> 「元层」看**文档与度量本身是否可信**；「当前交付」看**用户拿到手会撞到什么**。

| 维度 | 上一版（v8） | 本版 | 依据 |
| --- | --- | --- | --- |
| 核心抽象（配置=请求文本 / 同形契约 / 一处真相源） | A+ | **A+** | 十四版下来没人需要动它，反而越证明它稳 |
| 代码层工程纪律 | A- | **A-** | `1088+89+19+557` 全绿、面板 CSS/DOM 已合一、19 条起真跑行为断言、双包形态正确 |
| 变更收敛 | B | **B** | 自省质量最高（主动承认两个 P0 都是自己引入），但同轮又用「函数计数」换掉同源判据——闭环能力被新债抵消 |
| 元层 / 文档 | B- | **B-** | 口径自检 + 时间戳汇总已落地（实质进步），但同源检查三次选错代理指标、`compared += 1` 写两遍仍打印「42 个 .js」 |
| 当前交付 | B | **B** | 装上能用、双商店在架；但火狐包带 3 个死文件、bilibili 在火狐必被拦而文档仍说靠 DNR、OCR 自建供应商重复刚修（1.3.2 包里曾带） |

**为什么本版不升**：第十四版的自省是十四轮里质量最高的一次（「断言从实现反推 = 把 bug 固化」这句值得留），
但同一轮里同源判据第三次选错度量、e2e `exit(1)` 又制造了「干净机器打包必失败」的新连锁。
一进一出，分数持平是诚实的。

**三条「不买账」的逐版状态**（从 v5 提出，每版更新证据）：

1. **速度稀释纪律** —— 未改好。P0 注入链早收口，但这轮又出现「修 OCR 顺序 → 引入自建供应商重复」，
   且已进 1.3.2 包。模式没变：高密度改动仍在制造下一轮要修的东西。
2. **理念有代价** —— **部分改善**。esbuild 的行号承诺已在 `pack.py` / `DEVELOPMENT.md` 改成实事求是的说法，
   这是第一次正面承认代价；但手抄镜像仍在（`applyTheme` 三份、`langDisplayName` 两份），
   「零构建」的边界靠文档解释而不是靠机制收口。
3. **文档熵** —— 未改善（`docs/*.md` 12 份、review 9 版、回应 14 版），但**出现结构性苗头**：
   review 有了结清判据（可 closed / 不可 closed）、回应开始逐条认账并写自省。熵还在涨，只是开始有秩序了。

**瓶颈判断（本版更新）**：不是修复能力——十四版下来每个指出的点都能改，而且越改越准；
是**「选择度量的能力」**。三次同源检查（字面量 → 总长 → 函数计数）共同点是找「不用真比对也能判断」的
廉价代理，而真实事故恰恰出在代理失效的地方。这比单个 bug 更值得警惕：度量一旦假绿，
后面所有「已验证」都会跟着不可信。

**一句话**：**它已经把「承认错误」练成了能力，还没把「选择正确的尺子」练成能力。**
下一步只有三件事值得做——同源改逐文件哈希、1.3.1 旧包夹具进 `npm test`、e2e 分「环境不全 / 测试失败」；
这三件做完，「与源码同源」才第一次成为真话，其余死代码和注释都只是打扫卫生。
