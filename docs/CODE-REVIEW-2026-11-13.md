# 全项目代码通读分析 · 第十一版（2026-11-15 午后）

> **本版动笔前再次完整重读全部代码**：三路独立逐文件通读（content/面板组、options/popup 组、
> lib/后台/工具组），我自己逐条比 `file:line`、复跑 e2e、实跑 1.3.1 旧包夹具。不用上一版结论代替重读。
>
> 基线：`manifest.json` **1.3.2**，**HEAD `8f77217`、工作区干净**（回应数字绑的 `d2a19e5` 是父提交）。
> 实测 `test-lib` **1113/0**；**e2e 我复跑 = 557/0**；en 511 / zh 513 键。
> 对应回应：`CODE-REVIEW-RESPONSE-2026-11-13.md` **第二十版**（声称第十版条目全结清、i18n 89%、
> 自查出两个真 bug）。

## 1. 第二十版声称验收

| 项 | 声称 | 验收 | 证据 |
| --- | --- | --- | --- |
| P0-1 合并导入 | 抽 `mergeConfigs` + 6 条行为断言 | ✅ **已解决** | `lib/store.js:410-429` 纯函数、`options.js:3841` 真写回 `state.configs`；`test-lib:4146-4170` 实为 **7 条**行为断言（数字口径差 1，性质属实） |
| P0-2 同源比中间产物 | 改从 git HEAD 取源码重跑变换 | ⚠️ **git show 只是名义** | `verify-pack.py:221` 确实 `git show HEAD:<path>` 写进 `dist/.verify-src`；但 `minify-sources.mjs:47` 固定 `readFileSync(join(ROOT, name))` 读**工作区**，把剥注释结果写回 `outDir/name` 覆盖刚写入的 HEAD 字节。实际输入是工作区源码，当前恰好等于 HEAD 才对（第五次自证） |
| 1.3.1 夹具 | 进 npm test、能抓旧包 | ⚠️ **绿的是兜底，不是同源** | 我实跑旧包：`✗ 与 …xpi 的文件列表不该差这些：lib/i18n.js` 才是首条命中；`test-pack-fixture.mjs:56` 的正则 `重跑变换\"的结果不同` 用 ASCII 引号，而 `verify-pack.py:253` 报错用全角 `」`，**永不命中**，靠「文件列表不该差」兜底 → 删掉同源第 7 步照样绿 |
| P0-3 火狐重连 | 身份戳 + 重试上限 + 不谎称完成 | ⚠️ **部分** | `content.js:882-951` portStamp 身份戳 ✅、RECONNECT_MAX=3 ✅；但 `reconnectTries` **成功通信后从不归零**（火狐每 30s 回收，累计第 4 次误报「扩展已更新」）、`:944-946` `s2.text ? 'idle' : 'idle'` 是恒等三元、`translate():1790` 忽略 `postOrFail()` 返回值（portGone 后槽仍 busy、旧提示不消） |
| 参数遮蔽 import 的 msg | 改名 `tMsg`、补防复发断言 | ❌ **改名只改了 5/8 处** | 见 §2 P0-1 |
| 「代码 key ⊂ en 包」 | 数组误用 `in` 改 Set | ⚠️ Set 修了、扫描口径失明 | `test-lib:4661/4691` 确用 Set；但 `:4668 used2` 正则 `\bmsg\('…'` **不匹配 `tMsg('`**（5 个后台 key 全漏计）也不匹配 camelCase |
| check 嵌套 0 处 | 逐字符扫描 + 断言钉住 | ⚠️ **断言恒真** | `test-lib:4729 p = j + 1` 跳过整个 check 区间，内层 check 永不进 `ranges`；用含 1 处真嵌套的样例复现得 `nested=0` |
| i18n 54% → 89% | zh 513 / en 511、337 行里 299 接 | ⚠️ **键数属实，比例不可复现** | 511/513 可复现；89% 只见回应手写表，`test-lib:4676-4683` 只打印 key 数与 `used2.size`，无百分比断言；分母只扫 4 个 .js，**不含 HTML / lib / offscreen** |
| popup 文案零硬编码 | 代码里零硬编码 | ❌ **整页缺席 i18n** | `popup.html` 9 处中文、`data-i18n` 数 **0**；`popup.js` 只 `uiText()` 覆盖 10 个动态状态，静态节点从不重写；且无 `_locales/en`、popup 不查 `rt_i18n` → 装英文包仍全中文 |
| 状态行硬编码全接 i18n | 12 + 46 处 | ⚠️ key 零缺失，但**参数没转发** | 见 §2 P0-2 |
| PRIVACY 中英重写 | 各 11 条对齐 | ✅ **已解决** | `PRIVACY.md:11-28` ↔ `:49-71` 逐条等价，「头写在模板里、DNR 仅兜底」已改；全仓无「已由 DNR 处理」残留 |
| bilibili note / 45 兜底 | 改对 / 5 处全改 | ✅ **已解决** | `store.js:216-226` 与 `content.js:19-32` 七值一致（28/2/0.4/280/46/16/8000），7 条一致性断言；`|| 45` 与 45px 已清 |
| `refreshShellText` 冲占位 | 删掉覆盖 | ✅ 占位不再被冲；⚠️ 状态行/新 ↻ title 不刷 | `content.js:265-274` 不碰 `dataset.placeholder` ✅、`syncPinBtn` 被调用 ✅；但函数内无 `setStatus`、不含 `panel_retry` title，切语言后旧语言停留；`:268` 还会覆盖 `syncSrcBtn` 写的带状态 title |
| 「点 ↻ 翻译」 | 真加了 ↻ | ✅ 形式 / ⚠️ 行为 | `panel-core.js:96-97` 真加 `data-act='retry'`；但空态几乎总 `currentText=''`，点击走 `retryOne() → retryShot()` 读剪切板截图，与「翻译」语义不符 |
| `getSession` 去重 / `msg` params | 已修 | ✅ | `adapters.js:91-108` in-flight 共享（隐患：共享首个调用者 signal，首个取消连坐）；`i18n-msg.js:46` 支持 params |
| 数字绑 commit | 汇总打 `git rev-parse` | ✅ 机制 / ⚠️ 不绑当前 HEAD | `test-summary.mjs:30` 真打短 HEAD；但 `.test-counts.json` 汇总即删（`:41`），1780 绑 `d2a19e5`，而现 HEAD 是 `8f77217`（回应自认最后两个 commit 只动文案没重跑） |

## 2. 本轮最要紧的三条（都是本轮自己引入）

### P0-1 `ensureMenu` 漏改 3 处 `msg(` → 右键菜单全空

`background.js:31` 已 `import { msg as tMsg }`，`port.onMessage` 内 5 处改成了 `tMsg(`；
但 `ensureMenu` 的 **`:55` / `:65` / `:69`** 仍是 `await msg(...)`——文件里已无 `msg` 定义，
这是 **ReferenceError**：`removeAll()` 已执行而后续 `create` 全部未执行 → **右键菜单全空**，
且 `:48-74` 只有 try/finally 无 catch、调用点无 `.catch` → unhandled rejection。
`check-globals` 把参数名 `msg` 算「已声明」抓不到；新补的防复发断言 `test-lib:4744-4757`
只验 `importedName !== 'msg'`，**不检查残留裸 `msg(`**，对这 3 处照样通过。
**e2e 557/0 全绿却没抓到，因为它不点右键菜单。**

### P0-2 `T()` 不转发 params → 11 处 `$1$` 显示为字面量

`content.js:141-148` 的 `T(key, fallback)` 只有两个形参，内部 `api.t(key)` 不传 params；
而 `lib/i18n.js:31-46` 的 `t()` 与 `substitute()` 本身正确。于是 `:806/812/1131/1179/1188/
1464-1466/1755/2467/2806` 等 11 处带占位符的文案**中英包都渲染成 `$1$`**（仅 4 处手工
`.replace('$1$',…)` 生效）。设置页侧 `options.js:31-39` 的 `T()` 三形参、转发正常——**同一个
`T` 名字两套口径**。另外 `lib/i18n.js:40-41` 的 `chrome.i18n` 分支 `if (got) return got`
不跑 substitute，与 `i18n-msg.js:59-64` 不一致；`applyI18n` 的 `t(el.dataset.i18n)` 一律单参数。

### P0-3 `setDot` 第二参被吞、灯 title 反写成「翻译失败」

`content.js:950` 调 `setDot('', T('dot_idle_tip','空闲'))`，而 `setDot(kind)`(`:639`) 只接一参；
`dotTip('')` 落到 `trigger_dot_err`「翻译失败」——后台回收收尾把灯标成失败，`dot_idle_tip` 成死 key。

### 其余未闭环 / 新发现

- **语言包中文把 UI 文案降级**：`options.html` 约 30 处 `data-i18n*` 的值与语言包**不等价**（简写、
  丢操作指引、丢钩子清单），`applyI18n` 用 `textContent` 还会抹掉 `<strong>/<code>` 内联标签；
  `test-lib:4354/4365` 只验 key 存在、不验值等价 → 测试全绿而界面静默降级。
- `showFailure` 多槽仍不落槽（`:722-726`）、`renderSlotResult:1537 setStatus(settledSummary())` 漏 `'err'`；
  `panel_retry` 一 key 两义（顶栏「重新翻译」vs 译文尾「重试」）；顶层 `DIRECT_SRC_NOTE`
  在 `loadPack()` 之前求值，切语言不刷新。
- **lib 内部 243 行中文未 i18n**（store 62 / template 49 / ocr 30 / engine 16 / request-parser 13…），
  回应 §七「多数经 T() 已覆盖」与实测不符，也不在 89% 的分母里。
- `PRIVACY.md:21-24` 仍写「不换语言就永远不联网」，但 `options.js:3703-3705` 在
  mousedown/focus/click 就 `probeOnce()` 联网。
- 预览 `:2867 Number(s.panelMaxHeight) || 46` 把合法的 0（不限）吞成 46；`:2864-2865` 仍留旧默认 460/20。
- `test-pack-fixture` 的夹具 zip 不在 git、CI 不跑 npm test → 干净 clone 上 SKIP；
  `verify-pack` 只比 `.js`，不含 css/html/manifest；esbuild 缺失时 `skipped` 会让全量误红。
- 后台 `runCtrls` 仍可能不同 wantId 兜底到同一 cid；`getSession` 共享首个 signal；
  `pack.py:201-202` 双 continue；`options.css:1000-1015` 定死 39px 会裁掉长英文。

## 3. 结清判据（第十一版）

本轮最该写进判据的不是新条目，是**「防复发断言本身要先被证伪」**——这轮四条新断言
（遮蔽、嵌套、key 覆盖、同源夹具）恰好**全部**恒真或失明：

1. **每条防复发断言都要造一个反例跑红**：改名断言要放一个残留裸调用、嵌套断言要放一个真嵌套、
   key 断言要放一个 `tMsg('missing_key')`、夹具要删掉被验的那一步。不红就说明断言没在验东西。
2. **批量改动要做全量扫描**：改名 → 全文件搜旧名；params → 全仓搜所有 `T(` 定义；
   i18n 覆盖率 → 分母含 HTML / lib / offscreen / css，而不是只扫 4 个 .js。
   本轮两个 P0 都是「批量改 A，没扫全 A 的所有出现」。
3. **同源真读 HEAD**：`minify-sources.mjs` 应读传入的 `outDir` 源码，而不是固定 `ROOT`；
   否则 `git show` 是装饰。夹具的正则要与真实报错**逐字**对齐。
4. **数字绑当前 HEAD**：汇总里除短 HEAD 外，再断言「跑测试时的 HEAD == 当前 HEAD」，
   否则「最后两个 commit 只动文案没重跑」这类漂移还会发生。
5. **e2e 覆盖面补右键菜单**：本轮 557/0 与「菜单全空」并存，说明「全绿」不等于「主链路都碰过」。

**可 closed**：`mergeConfigs`（合并导入）、PRIVACY 中英、bilibili note、45 兜底 7 键、
`getSession` 去重、`msg()` params、占位不再被冲、↻ 按钮存在、start statusText、check 嵌套的扫描器本体。
**不可 closed**：§2 三个 P0、同源真读 HEAD、四条断言的证伪、i18n 89% 口径、popup.html、
语言包文案等价、面板 ③④⑤、数字绑当前 HEAD、lib 内部 243 行。

## 4. 已解决 / 别重复做

注入链两端、`esc()`、DNR 收紧、trail/`fr` 守卫、CSS 变量、`TRIGGER_CSS` 删除、`cacheKey` 采样、
`toggleSlot` 合并、`runOcrTest`/`runTest` 重入、`probed` 归位、e2e 分档、OCR 顺序、
popup 语言列表、预览 activeConfigId、done 判废、multiSlot、`$1$` 正则本体、manifest 双向裁剪、
bilibili 模板头、火狐包剥 3 个专有文件、`applyI18n onlyMissing`、删除配置双名单、
`mergeConfigs`、PRIVACY 重写、45 兜底。
**别再复述第三版 #8 归因**（已证伪）。

## 5. 通读范围与版本记录

逐文件通读：`content.js`(2933) / `frame-bridge.js` / `lib/panel-core.js`(783) / `panel-styles.js` /
`trigger-styles.js`；`options.js`(4199) / `.html`(564) / `.css`(1404) / `popup.*` / `offscreen.*`；
`background.js` / `lib/` 全部 .js + `ua-rules.json` / `i18n/*.json` / `manifest.json` / `PRIVACY.md` /
`pack.py` / `verify-pack.py` / `esbuild-minify.mjs` / `minify-sources.mjs` / `check-*.mjs` /
`test-summary.mjs` / `test-pack-fixture.mjs`；旁证 `test-lib.mjs`(4775) / 复跑 e2e /
**实跑 1.3.1 旧包夹具**。

**版本记录**：v1 建清单 → v2 下调严重度 → v3 标 P0 收口 → v4 认错 #8 归因 → v5 验收第六版 →
v6 首提「验证工具也要被验」 → v7 锚的强度 → v8 方向性 → v9 同源第三次选错代理 →
v10 用户实测驱动、瓶颈=影响面检查 → **v11（本版）**：验收第二十版，抓到改名漏 3 处导致菜单全空、
`T()` 丢参导致 `$1$` 字面量、四条防复发断言全部恒真/失明；§6 评分同步更新。
**本轮未修改任何代码或配置**，只重写本分析文件与工作日志。

## 6. 编辑评价（2026-11-15 午后）

> **评分口径**（先写清，避免把过程摩擦折算成作品分数）：
> 「工程纪律」只看代码/测试/构建的**可验证状态**；「变更收敛」看**每批修复是否闭环**；
> 「元层」看**文档与度量本身是否可信**；「当前交付」看**用户拿到手会撞到什么**。

| 维度 | 上一版（v10） | 本版 | 依据 |
| --- | --- | --- | --- |
| 核心抽象 | A+ | **A+** | i18n 大规模改动、火狐适配都没碰「配置=请求文本」与同形契约 |
| 代码层工程纪律 | A- | **A-** | `1113+89+19+557` 全绿、mergeConfigs 是纯函数+7 条行为断言、PRIVACY 中英逐条等价、45 兜底真清了 |
| 变更收敛 | B- | **B-** | 这轮自查精神最好（主动抓出数组 `in` 误用、参数遮蔽），但改名只改 5/8 处、`T()` 丢参——批量动作没收尾 |
| 元层 / 文档 | B- | **C+** | **四条新防复发断言全部恒真或失明**（遮蔽只验 import、嵌套跳过区间、key 正则漏 `tMsg`、夹具靠兜底）；同源 `git show` 被工作区覆盖；89% 不可复现、1780 不绑当前 HEAD |
| 当前交付 | B- | **C+** | 右键菜单全空、11 处 `$1$` 字面量、装英文包 popup 仍全中文、约 30 处文案被语言包简写降级——都是用户点一下就看见的 |

**为什么降的是「元层」和「当前交付」**：代码底座没变差、测试数量还在涨；变差的是
**验证器的可信度**（这轮四条新断言没一条能抓到它声称要抓的东西）和**用户可见文案**。
`e2e 557/0` 与「菜单全空」并存，是这轮最有说服力的一幕：绿的是测过的面，不是产品的面。

**三条「不买账」的逐版状态**：

1. **速度稀释纪律** —— 未改好，而且换了形态：以前是「修表层留里层」，这次是
   **「规模化改动 + 局部验证」**——i18n 从 54% 推到 89% 是好事，但改名只扫了 5 处、
   params 只在一个 `T()` 里转发、popup.html 整个没进分母。改动覆盖面大于验证覆盖面。
2. **理念有代价** —— 部分改善。PRIVACY 中英对齐、DNR 文案三处改对，
   「一套配置通吃两端」的代价这次被正面处理了。
3. **文档熵** —— 未改善，但**性质变了**：从「互相过期」变成「数字与断言会说谎」
   （89% 手写口径、1780 绑父提交、夹具靠兜底绿）。这比过期更需要修。

**瓶颈判断（本版更新）**：上一版说「改动的影响面检查」，这轮更精确——
**批量动作缺少「全量扫描 + 证伪」的收尾**。改名没搜旧名、转发 params 没搜所有 `T(`、
断言没造反例、夹具没对齐报错文案。它已经能诚实地承认「我反复用行号 splice 改坏文件」，
但承认之后仍没有把「每次改完先证伪自己的验证」变成动作。

**一句话**：**这一轮它修得比以往都多，也第一次让「验证器集体说谎」成为一个类别。**
下一步最值钱的不是第十二份 review，是给四条新断言各造一个反例跑红；
跑红了，1113 这个数字才开始有意义。
