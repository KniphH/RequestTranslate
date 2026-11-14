# 全项目代码通读分析 · 第十版（2026-11-15 凌晨）

> **本版动笔前再次完整重读全部代码**：三路独立逐文件通读（content/面板组、options/popup 组、
> lib/后台/工具组），我自己逐条比 `file:line`、复跑 e2e、实跑旧包夹具。不用上一版结论代替重读。
>
> 基线：`manifest.json` **1.3.2**，**HEAD `f6fca80`、工作区干净**（回应写的 `a94f22b` 是上一提交）。
> 实测 `test-lib` **1095/0**；**e2e 我复跑 = 557/0**；`test-engine` 89、`test-strip` 19（前轮确认）。
> 对应回应：`CODE-REVIEW-RESPONSE-2026-11-13.md` **第十七版**——这轮是**用户火狐实测驱动**，
> 不是 review 驱动；回应自己也点明了「改 A 时没检查 B 是否依赖 A」。

## 1. 第十七版声称验收

| 项 | 声称 | 验收 | 证据 |
| --- | --- | --- | --- |
| 火狐事件页断开 | 空闲静默重连 / 忙碌重连收 busy / 连不上才 portGone | ⚠️ **意图对，实现引入新竞态** | `content.js:863-890`；`reconnecting` 旗在 `connectPort` 的 `finally` 里立即复位，而 `onDisconnect` 异步派发 → 旗基本失效；`port = null` 无条件清，旧端口延迟回调会清掉刚建的新 port；`connectPort()` 只要 `connect`+hello 不抛就返回真，扩展被禁用时「连上又立刻断」会**无限静默重连**、永不 `portGone`；忙碌重连成功把带半截 delta 的槽标成 `done`（显示「完成」+ 残缺译文）、未 `resetDiag()`、`setDot('')` 的 tooltip 反写成「翻译失败」 |
| bilibili 在火狐被风控拦 | 两个头写进文字/图片模板 | ✅ **已解决** | `lib/store.js:64-65,76-77` 两处自带 UA/Origin，`parseRequest` 能解析三头（`:369-393`），4 条断言钉住（`test-lib:4527-4543`），DNR 保留兜底 |
| PRIVACY 英文事实错误 | 补「整张图」「默认 Bing」 | ❌ **补了新句、没删旧段** | `PRIVACY.md:51` 新句之后，`:52-54` 仍是「Only the text … is sent — nothing else」，`:58-59` 还有半截残片；英文自相矛盾。中文 `:15` 也同时说「不依赖任何浏览器专有 API」和「另外带一条 DNR 规则」 |
| `applyI18n` 二次覆盖 | 加 `opts.onlyMissing` | ⚠️ **目标达成、通道关死** | `lib/i18n.js:76-94` 打标跳过已填节点，`options.js:219` 传 `onlyMissing`；但 `:79 if (!onlyMissing) applyI18nHtml(scope)` 使**新建的 `data-i18n-html` 节点不再被补填**；`options.js:220-223` 注释仍按旧行为描述 |
| 删除配置两份名单 | 都 filter + imageConfigId 退回 | ✅ **已解决** | `options.js:1309-1332` |
| trigger-styles 头注 / 尺寸 | 已改 / 改 28 | ✅ 头注与 `trigger-styles.js:103`、`store.js:216` 已改；⚠️ **兜底仍是 45** | `content.js:19 triggerSize: 45`、`:341 || 45`、`panel-core.js:276-279` CSS 兜底 45px 未同步 |
| 合并导入 usedIds | 防同 id 双配置 | ❌ **功能级回归：合并导入整体失效** | 见 §2 P0-1 |
| 同源检查 | 21/21 个 .js 逐文件 **md5 一致** | ⚠️ **是真 md5，但比错了对象** | 见 §2 P0-2 |
| 1.3.1 旧包夹具 | pack-fixture 2 项进全量 | ✅ **已落地**（有残留） | `package.json` 的 test 链含 `test-pack-fixture.mjs`，实测旧包 `exit 1` + 21 条错误；但夹具 zip **未被 git 跟踪**（`git ls-files dist` 为空）→ 干净 clone 上 SKIP，2 项不计入 |
| e2e 环境分档 | 干净机器不再卡打包 | ✅ **已解决**（有残留） | `e2e-ui.mjs:85-113` 默认 SKIP `exit 0`、`RT_REQUIRE_E2E=1` 才红；但 devDependencies **仍只有 esbuild**、`E2E_BROWSER` 提示变量无人读、`writeCounts()` 裸调未导入函数（SKIP 时上报失败） |
| 1762 项全量 | 1095+89+19+557+2 | ⚠️ **不可复现、不绑 HEAD** | `.test-counts.json` 被忽略且 `test-summary` 收尾删除；静态桶无人写；`DEVELOPMENT.md:353` 仍写「1043…1710」；代码里无 `git rev-parse`，数字无法绑到 commit |
| Firefox 包 | 少 3 个 Chromium 专有文件 | ✅ **已解决** | 实测 zip 32 / xpi 29 文件，少 `offscreen.html`/`offscreen.js`/`ua-rules.json`；DNR 字段与权限剥净 |
| 主动放弃 test-lib 嵌套 | 检测手段不可靠 | ✅ 如实声明 | 没改代码也没假装改了，这点值得肯定 |

## 2. 本轮最要紧的三条

### P0-1 合并导入「导入完成」但配置没变（用户可感知）

`options.js:3838-3868`：`const byName = new Map(state.configs.map(...))`、循环里 `byName.set(...)`，
但**补丁把 `state.configs = [...byName.values()]` 删掉后没有补回**。随后 `:3864 normalizeSlots(state.settings, state.configs)`
拿到的是**未变的**旧 `configs`，把新 id 全滤掉。结果：合并导入既不新增、也不覆盖同名，`usedIds` 空转，
界面却照常弹「导入完成（N 条）」。这是第十七版修「同 id 双配置」时亲手引入的功能回归。

### P0-2 同源检查第四次自证：md5 比的是中间产物

`verify-pack.py:218-235` 逐文件 `md5(packed) == md5(cand.read_bytes())`，而 `cand = stripped_dir / name`
——**`dist/.stripped`**。`pack.py:177-182` 正是从 `.stripped` 原样 `z.write()` 写进包：
同一份字节复制两处，md5 恒等是**同义反复**，抓不到「改了仓库源码却没重新 strip」。
四次迭代（字面量 → 总长 → 函数数 → 中间产物）共同点没变：都在找一个不用真比仓库的代理。
`.stripped` 还在被忽略的 `dist/`，干净 clone 直接报缺。**判据要的「与仓库源码同源」仍然没实现。**

### P0-3 火狐重连修复引入循环重连与状态残留

除 §1 那栏列的：`postOrFail`(`:936-955`) 端口失效调 `portGone()` 却**不置 `port=null`**，
与 `handleDisconnect` 的静默重连分支叠加，会把「扩展已更新，请刷新页面后重试」**留在界面上不再清除**——
恰是这次要修的那句提示。本轮新增 3 条「重连/防重入」断言（`test-lib:4548-4555`）是**源码正则**，
验证不了这些时序。

### 第九版面板侧现状

① 缓存后无条件 `leaveBusy` ✅ 已解决；② `start` 多槽 `statusText` ⚠️ 底栏仍丢（槽状态行已带上）；
③ **「点 ↻ 翻译」仍指向不存在的按钮**（`shellHtml` 只有 pin/src/close，空态没有 ↻）；
④ `refreshShellText` 仍冲掉自定义占位、不刷状态行/图钉 title（`syncPinBtn` 从未被调用）；
⑤ `showFailure` 多槽仍不落槽、全失败 `setStatus` 不带 `'err'`；
⑥ 状态行几十处硬编码中文未做（本轮还新增了一处 `content.js:888`）；
⑦ 头注已改但 45 兜底残留；⑧ `onlyMissing` 已实现但有副作用。

### 其他未闭环 / 新发现

- **bilibili 文案三处矛盾**：`store.js:56` 的 note 仍写「已由 DNR 规则处理，你不用管」；`PRIVACY.md:15/56`
  宣称「不依赖任何浏览器专有 API、两端一致」——但 Chromium 里 UA/Origin 是 fetch 禁用头，
  实际仍靠 DNR；`firefox/AMO-审核说明.md:92/97/113` 与 `AMO-1.3.1-审核备注.txt` 仍大篇幅讲 DNR 权限。
- **1762 之外**：`verify-pack.py:151-152` 会把 `--target firefox` 产出的 `.zip`（`scripts` 形态）
  误判「zip 里不该有 scripts」→ exit 1；`pack.py:201-202` 双 `continue`；新断言仍有源码正则。
- 后台：`ids` 去重按 `wantId`，不同 id 经 `pickRequestConfig` 兜底仍可落同一 `cid`；
  `ensureMenu` try/**finally 无 catch**（`:48-74`）真异常变 unhandled rejection；
  `lib/adapters.js:91-95 getSession()` 无 in-flight 去重，多槽并发走 Bing 会重复抓 token；
  `store.js:634/693` 两处 v12/v13 迁移块无版本门控（当前幂等）。
- i18n：`i18n-msg.js:41-49 msg()` 不替换 `$N`；`i18n.js:173 setBaseUrl(null)` 无法恢复默认镜像；
  自检只断言「代码 key ⊂ zh 包」，**不验 en 覆盖**；设置页 / popup 运行时文案仍遍地硬编码中文
  （`options.js:2154/2752/2064-2067`、`popup.js:38-41/178-185/196`）。

## 3. 结清判据（第十版）

前九版门禁继续有效。本版只补一条，因为四次同源迭代都栽在同一处：

1. **同源必须比仓库源码**：`git show HEAD:<path>` → 剥注释 → esbuild 等价变换 → 与包内比 md5；
   **不许比 `dist/.stripped`**（那是包自己的输入）。若嫌变换不可复现，就把「变换后哈希」写进
   打包产物元数据，并让夹具用仓库源码重新生成一份来比。
2. **夹具与依赖随仓库走**：1.3.1 旧包（或生成器）进 git / 由测试现场生成；`playwright-core`
   写进 devDependencies 或提供可复现安装路径，否则 `RT_REQUIRE_E2E=1` 的 CI 永远无解。
3. **数字绑 commit**：汇总里写 `git rev-parse --short HEAD`，`.test-counts.json` 留档；
   `DEVELOPMENT.md:353` 的 1043/1710 按脚本输出同步。
4. **断言禁源码正则**：重连时序、合并导入、同源夹具都要行为断言；尤其合并导入要断言
   「导入后 `state.configs` 真的变了」。
5. **改动前做依赖面清单**：A 改了，谁依赖 A？——回应自己总结的这条教训，应该变成动作，
   而不是每轮事后复盘。本轮三个 P0（合并导入、同源比错对象、重连竞态）全是「改 A 没查 B」。

**可 closed**：bilibili 模板头、删除配置双名单、trigger-styles 头注、尺寸主值、Firefox 包少 3 文件、
e2e 分档、1.3.1 夹具进 npm test、`onlyMissing` 主体、`cfgSelect` leaveBusy。
**不可 closed**：§2 三个 P0、PRIVACY 中英矛盾与 DNR 文案、面板 ③④⑤⑥、45 兜底、
同源比仓库源码、数字绑 commit、后台并发与 i18n 残留。

## 4. 已解决 / 别重复做

注入链两端、`esc()`、DNR 收紧、trail/`fr` 守卫、CSS 变量、`TRIGGER_CSS` 删除、`cacheKey` 采样、
`toggleSlot` 合并、`runOcrTest`/`runTest` 重入、`probed` 归位、e2e `exit(1)` 与分档、OCR 顺序、
popup 语言列表、预览 activeConfigId、done 判废、multiSlot、`$1$` 正则、manifest 双向裁剪、
bilibili 模板头、火狐包剥 3 个专有文件、`applyI18n` onlyMissing、删除配置双名单。
**别再复述第三版 #8 归因**（已证伪）。

## 5. 通读范围与版本记录

逐文件通读：`content.js`(2898) / `frame-bridge.js` / `lib/panel-core.js`(776) / `panel-styles.js` /
`trigger-styles.js`；`options.js` / `.html` / `.css` / `popup.*` / `offscreen.*`；`background.js` /
`lib/` 全部 .js + `ua-rules.json` / `i18n/*.json` / `manifest.json` / `PRIVACY.md` / `pack.py` /
`verify-pack.py` / `esbuild-minify.mjs` / `check-*.mjs` / `test-pack-fixture.mjs` / `test-summary.mjs`；
旁证 `test-lib.mjs` / 复跑 e2e / **用 1.3.1 旧包实跑夹具（exit 1，21 条）**。

**版本记录**：v1 建清单 → v2 下调严重度 → v3 标 P0 收口 → v4 认错 #8 归因 → v5 验收第六版 →
v6 首提「验证工具也要被验」 → v7 锚的强度 → v8 方向性 → v9 同源第三次选错代理、e2e 打包连锁 →
**v10（本版）**：验收第十七版（首次用户实测驱动），抓到合并导入功能回归、同源第四次自证
（比中间产物）、火狐重连新竞态；§6 评分同步更新。
**本轮未修改任何代码或配置**，只重写本分析文件与工作日志。

## 6. 编辑评价（2026-11-15 凌晨）

> **评分口径**（先写清，避免把不同性质的东西混进一个分数）：
> 「工程纪律」只看代码/测试/构建的**可验证状态**；「变更收敛」看**每批修复是否闭环**；
> 「元层」看**文档与度量本身是否可信**；「当前交付」看**用户拿到手会撞到什么**。

| 维度 | 上一版（v9） | 本版 | 依据 |
| --- | --- | --- | --- |
| 核心抽象（配置=请求文本 / 同形契约 / 一处真相源） | A+ | **A+** | 十七版下来没人需要动它；这次火狐两个 bug 都在适配层，抽象层毫发无伤 |
| 代码层工程纪律 | A- | **A-** | `1095+89+19+557` 全绿、CSS/DOM 合一、真跑断言、双包形态与字段裁剪正确 |
| 变更收敛 | B | **B-** | 这轮两个真 bug **都是上一轮自己引入的**，而修它们又引入合并导入失效、重连竞态——「改 A 没查 B」在同一轮里犯了三次 |
| 元层 / 文档 | B- | **B-** | 夹具进 npm test、e2e 分档、数字时间戳都落地了（实质进步），但同源 md5 比的是包自己的输入、`1762` 不可复现也不绑 HEAD、PRIVACY 中英自相矛盾 |
| 当前交付 | B | **B-** | 合并导入会显示「导入完成」却什么都没变；火狐重连可能循环且旧提示不消；PRIVACY 英文同一段里既说「整张图会发」又说「只发文字」 |

**为什么降的是「变更收敛」和「当前交付」，不是「工程纪律」**：代码底座没变差，测试也没变少；
变差的是**这一批改动的用户可感知后果**（合并导入失效、火狐提示不消）和**每批修复的闭环率**。
这正是分维度的意义——别把过程摩擦折算成作品分数（前几版吃过这个亏）。

**三条「不买账」的逐版状态**：

1. **速度稀释纪律** —— 本轮最明显。用户火狐实测报的两个 bug 都是上一轮（剥 DNR、事件页差异）引入的，
   修完又新添合并导入回归与重连竞态。高密度改动仍在制造下一轮要修的东西，而且这次是**用户先撞到**。
2. **理念有代价** —— 部分改善。esbuild 行号口径已实事求是、火狐包字段裁剪做对了；
   但「剥 DNR 没想到 bilibili 依赖它」正是理念叠加的代价：一套配置通吃两端，任何一端裁剪都会牵动模板。
3. **文档熵** —— 未改善，且出现新的伤害面：PRIVACY 中英互相矛盾、`store.js` note / AMO 审核说明 / 中文
   PRIVACY 三处仍宣称靠 DNR。文档不再只是过时，而是**会误导审核与用户**。

**瓶颈判断（本版更新）**：前几版说「选择度量的能力」，这轮可以更精确地说是
**「改动的影响面检查」**。回应自己写下了这句话——「改 A 的时候没检查 B 是否依赖 A」——而本轮三个 P0
（合并导入删了写回、同源比中间产物、重连改出循环）恰好是同一类错。**它已经能准确说出自己为什么错，
但还不能在动手前拦住那个错。**

**一句话**：**诊断能力已经超过了预防能力。** 下一步最值得做的不是再修条目，是把回应里那句教训
变成动作：每次改动前列一张「谁依赖 A」的清单（配置模板 / 打包产物 / PRIVACY / 夹具 / 火狐形态），
改完逐项打勾。这张清单比第五份 review 有用得多。
