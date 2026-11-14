# 全项目代码通读分析 · 第五版（2026-11-14 凌晨）

> **本版动笔前再次把代码全部重读了一遍**：三路独立逐文件通读（content/面板组、
> options/popup 组、lib/后台/工具组），我自己再对争议点逐条比 `file:line` 源码、跑增量测试。
> 不用前四版结论代替重读。
>
> 基线：`manifest.json` **1.3.2**，工作区 **22 个未提交文件**（另一个 agent 持续进行中）。
> 实测 `test-lib` **1065/0**、`test-engine` 89/0、`test-strip` 19/0、`check-globals` 22 文件、
> `check-dom` 通过；e2e **555/0** 有日志实证（`tools/_e.log` 01:39）。
> 对应回应：`CODE-REVIEW-RESPONSE-2026-11-13.md` **第六版**（称 8 项全做完、2 项保留、
> 「没有要反驳的条目」）。
>
> **本版按验收视角写**：kniph 定的目标是「不断修正直到解决所有问题」，所以每条都标
> **已解决 / 部分 / 未解决 / 缺断言**，并给出「结清判据」（§4）。前四版细节在 git 与回应文件里。

## 1. 第六版回应逐条验收

| 项 | 声称 | 验收 | 证据 |
| --- | --- | --- | --- |
| #10 trail | `frame-bridge` 只记 left/top | ✅ **已解决** | `frame-bridge.js:83-85` 只记 `{left,top}`、注释同步；`content.js:2182-2193` 只累加 `t.left/t.top` 加到 rect 四边 |
| #15 缓存 | 去掉 `cacheKey=null`、挪到早退之后 | ✅ **已解决** | `retryOne:2375` 只 `resultCache.delete(id)`，位于两处 busy 早退之后；`translate` 指纹同图不变不清整批 |
| popup `run()` | try/finally + runSeq | ⚠️ **部分** | `popup.js:240-246` finally、`35/197/220/242` runSeq 到位；但 `onDelta:215-217` / `applyOut:63-74` **无 runSeq 守卫**，旧轮晚到 delta 仍可覆盖新界面；abort 后 `await runRequest` 抛 AbortError **全函数无 catch**，未处理 rejection |
| 预览顶栏 | `s.activeConfigId` → `state.activeConfigId` | ✅ **已解决** | `options.js:2921-2924`。残留：`:2931/2938` 把 v13 的语言**代码**当显示名，与真面板不一致 |
| 导入 panelCss | 保留自己那份 | ✅ **已解决**（有边界缺口） | `:3833-3839` 存 `myPanelCss` 回填；但 `:3838 ...parsed` 整体覆盖 settings，`parsed.settings` 缺失时 `:3839 if(state.settings)` 为假，后续可能崩 |
| 菜单死键 | 两条标题接 `msg()` | ✅ **已解决** | `background.js:55/63/67` 三条 title 全 `await msg(...)`；`:63/67` 兜底空串时仍会创建空标题菜单项（小） |
| 槽位裁切 | 两份名单一起裁 | ⚠️ **部分** | `syncSlotsHint:486-498` 两份都裁 ✅，但**只在 `renderConfigList`(:402) 调用**，`#s-slots` 变更(:2647) 那一刻不裁，须等列表重画；函数注释「并提示一句」实际无提示 |
| 导入分支 | `state.settings.slotConfigs` | ⚠️ **部分** | merge 分支 `:3822-3831` 已改；**非 merge 分支 `:3832-3840`** 由 `...parsed` 把对方整份 `slotConfigs` 盖入，而 `configs` 只是勾选的几条 → 名单引用未导入的 id，`:3842` 又强设 `activeConfigId=configs[0].id`，面板拿到悬空 id |
| `toggleSlot` 合并 | 两个薄包装 | ✅ **已解决** | `:447-477`，`:476/477` 仍被 `:398/2094` 当回调使用 |
| 无赋值字符串 / 过时注释 | 删 + 改指 panel-core | ⚠️ **部分** | `:2790-2792` 只剩 `RTPanelCore.shellHtml()` ✅；但 `options.js:5-6` 示例仍写 `const { PANEL_CSS }`（实际含 `TRIGGER_CSS`）、`:2421-2422` 仍以「手抄两份」类比、`:2738-2744` 与 `:2745-2757` 两段 JSDoc 互相矛盾；`popup.js:204` 只写不读 |
| `verify-pack` 恒真 | 改 `if not problems` | ✅ **已解决** | `verify-pack.py:150-152`，形态检查并入 `problems`、末尾 `if problems: exit(1)` |
| `--target firefox` | 输出名加 `-firefox` | ⚠️ **代码改了，产物过不了自家验包** | `pack.py:404-405` 生成 `request-translate-1.3.2-firefox.zip`（带 `scripts`）；而 `verify-pack.py:146-149` 按后缀判形态：**`.zip` 不该有 `scripts`** → 必然报错；`:158` twin 找 `-firefox.xpi`（未带 `--xpi` 时不存在）→ 双包一致检查静默跳过 |
| ua-rules 断言 | 收紧到「长度 1 且 xmlhttprequest」 | ✅ **已解决** | `test-lib.mjs:4085-4087`；但「SW fetch 是否属 xmlhttprequest」仍无运行时验证，只是把假设钉成断言 |
| 6 条新断言 | 真跑函数 | ⚠️ **4 真 2 假** | `esc` 4 条从 `panel-core.js` 抠函数 `new Function` 真跑（`:4093-4100`，但 `indexOf` 抽取脆弱）；**`configIds` 2 条是测试内复刻 lambda**（`:4103-4107` `const dedupe = ...`），既不读也不 import `background.js`，改 `:467-469` 照样绿——**自证断言** |
| `runOcrTest` 重入闸 | （第四版欠账） | ✅ **本轮已修** | `options.js:2474 btn0.disabled=true` 早于 `:2487 await persist`，有 try/finally。残留：`:2543-2547` finally 无条件解禁，与 `renderOcrDisabled:2149` 按模式禁用冲突 |
| `probed` | 赋 true | ✅ **赋值了** | `options.js:3673`。**但见 §2 P0-1：整条语言下载链仍是死的** |

**两条「保留不改」的评判**：

- `loadPack` 不过 `validatePack`——理由**基本成立**（唯一写入口已校验、渲染侧有白名单、能改 storage 者本就能改 state）。但**漏了第二读取口**：`i18n-msg.js:18-28 getDownloaded()` 供右键菜单 `msg()` 使用，同样不校验；四道上限在 load 侧全失效，腐坏大包可做 DoS。属「结论对、论证不全」。
- `probe` 不验 Content-Type——**这一项成立**（CT 会误伤返回 `text/plain` 的 CDN）。但同一函数的 GET 回退 `:222-224` **不消费/不 cancel body、无上限**，`verifyIndex` 会被 200 HTML 错误页骗过；这两处是被「保留 Content-Type」一并带过的，别当成已评估。

## 2. 本次重读仍未闭环 / 新发现（按严重度）

### P0 · 本轮最该先修的两条（都让功能直接不可用，而 1065/0 全绿测不到）

1. **`langFiles` 全项目零声明**。`options.js:3633` 只有注释，`:3660/3661/3706` 三处使用，
   无 `const/let/var`、无 `window.langFiles`。`probeOnce()` 的 `Object.keys(langFiles)`(`:3660`)
   必抛 `ReferenceError` → 被 `:3667 catch` 吞成「取不到语言清单（离线或被挡）」 → `finally`
   里 `probed = true`(`:3673`) **把重试锁死**；change handler `:3706` 同样抛（unhandled rejection）。
   结果：界面语言下拉**永远列不出可用语言包**，即时下载功能整体失效。`probed` 修好了，
   反而把失败状态固化了。`PRIVACY.md` 里关于语言包的描述因此也是空的。
2. **模板字符串里多出一个字面 `}`**。至少 `options.js:241`（`名称}`）、`:1544`
   （`链上共 N 条请求}`）、`:1545`（`model 逐个试，最多发 N 次}`）三处确认，疑有更多同类。
   切到中文/英文界面都会把这些花括号显示给用户，是 i18n 改造留下的 UI 回归。

### P1 · 「看起来修了、实际没闭环」

| 问题 | 证据 |
| --- | --- |
| **saveSeq 是假闭环**：`++saveSeq` 与第一个 `if (mySave !== saveSeq) return` 之间**全是同步代码**，比对恒真从不触发；唯一有效的比对在 `await saveState` **之后**，只拦「已保存」字样，**没拦落盘**；作废不回滚任何界面状态。`adoptPanelOwned` 改的还是同一个共享 state 对象 | `options.js:3880,3890,3897,3899`；`:3878` 注释「落盘前比对，过期直接放弃」与代码相反 |
| **hidePanel 仍无「面板可见」门禁**：`start/delta/done/fatal` 全都不判 `panel.classList.contains('show')`；后台 `done` 口 `:590` 判 `alive()` → `await appendHistory` → `:608 delete` → `:609 safePost(done)` **无二次判废**，迟到的 done 会把 `hidePanel` 刚回退的槽标成 fail、在隐藏面板上 `renderResult`；迟到的 delta 把槽写回 busy 且无收场 | `content.js:530-553,1047-1180`；`background.js:590-609` |
| **cfgSeq / langSeq 拆开了，但作废不回滚**：跨控件互相作废已修，作废前 `currentConfigId`/`slots`/`prefs.targetLang`/`resultCache.clear()`/写盘都已发生，判废处只 `return`；文字模式 cfgSelect 无 await，守卫同栈内形同虚设 | `content.js:906-907,2551,2563-2589,2610-2623` |
| **`renderSlotResult` 函数内仍缺 `leaveBusy()`**：多槽 `allSettled` 分支只有 `setDot/setStatus`，靠唯一调用点 `:2596` 无条件兜底——其它槽还在飞时也复位全局 busy | `content.js:1409-1426,2595-2596` |
| **`showFailure` / `showNoCachedResult` 多槽不闭环**：`showFailure:680-689` 加了 `slots.length<=1` 守卫但多槽分支**不落槽、不调 renderSlots**（OCR/截图失败时结果区仍是旧译文）；`showNoCachedResult:1019` `outBox.textContent=''` **无守卫**，多槽下清空所有块 | `content.js:677-689,1014-1023,2603` |
| **done/fatal 的 `if (!sl)` 无条件 `leaveBusy()`**：某条流因删槽/切模式不属于任何槽时，其它在飞槽一起失去保护；多槽路径从不调 `showDiag`，对比模式下「⋯」诊断区恒隐藏 | `content.js:1131-1134,1161-1163,996,821` |
| **后台 `runCtrls` key 口径错配未修**：去重按 `wantId`，`runCtrls.set` 用 `config.id`；图片直传时 `pickRequestConfig`(`store.js:399-407`) 忽略 `configId` → 多图槽解析成同一 cid，Map 互盖、done 全带同一 id | `background.js:467-469,493-495,609`；`store.js:292,399-407` |
| **i18n 镜像回退**：`downloadPack:343` 校验没过**直接 return，不试下一个镜像**（与 `:330-332` 注释矛盾）；`:338 clearTimeout` 早于 `readCapped`（读正文无超时）；`probe` GET 回退不消费 body | `lib/i18n.js:186-207,215-232,333-353` |
| **`inline()` 零行为断言**：`test-lib.mjs:4244` 标题写「inline() / sanitizeInlineHtml 行为测试」，实际只跑 `sanitizeInlineHtml`；`options.js:48-52` 的包装（含 `RTI18n` 未加载时降级 `escapeHtml` 分支）零断言。全文搜 `runSeq/saveSeq/persist/toggleSlot/probed/verifyIndex/downloadPack` 在测试里零命中 | `test-lib.mjs:4244-4268` |

### P2 · 死代码、注释、打包与断言（低风险但会误导下一个人）

- `content.js:111 const TRIGGER_CSS` 声明后无引用（`:188` 用 `PANEL_CSS`，内部已插值）；
  `lib/panel-styles.js` 整个是 `export {}` 且 manifest 未加载；`afterSlotChange` 已删但
  `:1499` 留着「原来有个函数」的孤儿注释，`:1496-1498` / `:245` 两处 JSDoc 无对应函数。
- 注释与代码反：`renderSlotResult` JSDoc(`:1406-1407`) 仍写「renderResult 无条件写 slots[0]」，
  而 `:976` 已加守卫；`trigger-styles.js:5-13` 仍宣称手抄逐字比对；`test-lib:4244` 标题与内容不符；
  `options.js:3658-3659 sel.value = keep || ''` 连写两遍。
- **`--target firefox` 与 `verify-pack` 后缀判据冲突**（§1），且 xpi/`-firefox.zip` 仍保留
  `minimum_chrome_version`、`declarative_net_request`、`offscreen` 等 Chromium 字段，权限未裁。
- `esbuild-minify.mjs:77` 无 sourcemap、函数名被压；`verify-pack.py:66-91` 对 `a<b` 一律放过，
  `pack.py:12-14` / `PRIVACY.md:27-28` 的「报错栈对得上源码」已不成立；`--target=chrome100`
  对 firefox 包同样生效。
- `verify-pack.py:49/:102` 只验 `.js/.css/.html`，**任何 `.json` 都不验**（ua-rules / manifest / messages
  语法与引用完整性零检查）；`test-lib.mjs:3325-3333` 并发判废仍是源码正则；
  `check-dom.mjs` 只覆盖 options/popup/content，`$('#id')` 只认单引号。
- `panel-core.js:150-151` fail 分支把错误文案当 `hasText=true` → 失败态「复制/朗读」按钮 enabled，
  会把错误串复制/朗读出去。

## 3. 已解决 / 别重复做

- P0 注入链两端（`validatePack` 白名单+四上限 / `inline()` 白名单）已收口，19 条行为断言在跑。
- `esc()` 引号、`code`/`meta.file` 统一、DNR `resourceTypes` 收紧并钉住断言、PRIVACY 口径统一。
- `runTest` / **`runOcrTest` 重入闸**（本轮已修）、`probed` 赋值、`frame-bridge` trail、
  同图重试缓存、`toggleSlot` 合并、菜单死键、预览顶栏、`verify-pack` 恒真断言、
  `renderResult`/`showFailure` 的单槽守卫、`afterSlotChange` 死代码删除——都已落地。
- 1.3.2 双包同源、Firefox 已上架、T1~T6 收尾、CSS 合一——别当待办重新提。
- **别再复述第三版 #8 的归因**（已证伪：done/fatal 本来就有单/多槽守卫）。

## 4. 结清判据（让循环真正收敛）

回应第六版写「没有要反驳的条目」，但本次完整重读找出 §2 的 P0 两条与一批 P1 未闭环。
问题不在迭代意愿，在**「改了」被当成「解决了」**。建议每轮结束前固定三道门禁：

1. **每条修复配行为断言**：必须读生产函数 / import 之，不许像 `configIds` 那样在测试里
   复刻一个 lambda 自证；`inline()`、`saveSeq`、面板可见门禁、`langFiles` 链路都要有真断言。
2. **声称结清前跑一次 `npm test` 全量并贴真实输出**：本轮各项增量分别通过（1065/89/19/555），
   但回应自己也写明「未跑 `npm test` 组合」——措辞已改对，组合仍应补一次。
3. **明确宣布 closed 清单**：下一轮只审 closed 之外 + 本轮新引入面。按此判据，本轮
   **可 closed**：§1 里标 ✅ 的 9 项；**不可 closed**：§1 标 ⚠️ 的 8 项与 §2 全部。

**下一批顺序**：P0 两条（`langFiles` 声明 + 多余的 `}`）→ P1 里 saveSeq / 面板可见门禁 /
作废回滚 / `renderSlotResult` 收口 → i18n 镜像与 `inline()` 断言 → P2 批量清。
每条按 §4.1 配断言，然后才跑全量。

## 5. 通读范围与版本记录

逐文件通读：`content.js`(2753) / `frame-bridge.js` / `lib/panel-core.js`/`panel-styles.js`/
`trigger-styles.js`；`options.js`(4178) / `.html` / `.css` / `popup.*` / `offscreen.*`；
`background.js` / `lib/` 全部 .js + `ua-rules.json` / `i18n/*.json` / `manifest.json` /
`PRIVACY.md` / `check-globals.mjs` / `check-dom.mjs` / `pack.py` / `verify-pack.py` /
`esbuild-minify.mjs`；旁证 `test-lib.mjs` / `test-engine.mjs` / 两份回应文档。

**版本记录**：v1 建清单 → v2 下调三条严重度 → v3 标 P0 收口 → v4 认错 #8 归因、
逐条核实「3+10」 → **v5（本版）**：写前再次完整重读，按验收视角给第六版回应的
「已解决 / 部分 / 未解决 / 缺断言」清单，并定下 §4 的结清判据。旧版细节在 git 与回应文件里。

**本轮未修改任何代码或配置**，只重写本分析文件与工作日志。
