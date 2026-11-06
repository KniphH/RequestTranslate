# Firefox 移植分析报告

> 2026-11-06 · 对当前 **1.3.0** 代码做的实证扫描（不是沿用旧清单）。
> 旧清单 `docs/firefox-port-plan.md` 是 2026-10-06 针对 1.1.0 写的，其中**一条关键结论是错的**，见第二节。

---

## 一、结论摘要

| 项 | 判断 |
| --- | --- |
| 总体可行性 | **可行**。WebExtension 层面没有结构性障碍，不需要换架构 |
| 真正的阻塞点 | **只有 1 个**：`chrome.offscreen`（Firefox 无此 API） |
| `chrome.*` 调用点 | **59 处**（8 个文件、28 种 API） |
| 其中 `await` 风格 | **23 处 —— 写法不用改**（理由见第二节） |
| manifest 改动 | 加 `background.scripts`、加 `browser_specific_settings`（约 8 行） |
| 最低 Firefox 版本 | **140**（由 `options_page` 与 `data_collection_permissions` 共同顶上来） |
| 构建链 | **不动**（零依赖零构建，`firefox/` 目录不进 Edge 包） |
| 建议版本号 | 与 Edge 同步 `1.3.0`，用 `-fx` 后缀区分产物文件名 |

**一句话**：这比旧清单预估的简单得多 —— 唯一的硬骨头是剪切板读图，而它在 Firefox 上**反而更好做**。

---

## 二、先纠正旧清单里那条错误结论

`docs/firefox-port-plan.md` 开头写：

> 现状：`1.1.0` 在火狐上 **跑不起来**（后台不启动 + Promise 全废）。
> 火狐的 `chrome.*` 命名空间 **只支持回调、不返回 Promise**。

**「Promise 全废」这一半不成立。** MDN 现行原文（`Build a cross-browser extension`）：

> Firefox and Safari support promises on all asynchronous APIs.
> Starting from Chrome 121, all asynchronous extension APIs support promises unless documented otherwise.

另一处（`Chrome incompatibilities`）把它标为**已消解的历史差异**：

> Support for the `browser` namespace and promises are no longer a source of incompatibility.

并且同页说明 Firefox **同时**提供两个命名空间：

> Firefox also supports the `chrome.*` namespace for APIs that are compatible with Chrome,
> primarily to assist with porting.

### 那旧清单当时为什么测出「Promise 全废」？

最可能的解释是**误诊**：Firefox 不支持 `background.service_worker`（BCD 明确 `version_added: false`），
所以 **后台根本没启动** —— 于是任何依赖后台的调用都失败，看起来就像「Promise 全废」。
Promise 是**次生现象**，根因自始至终只有「后台起不来」一个。

### 这条纠正有什么价值

旧清单的方案给 content script 也准备了一份手抄的 `ext`（改动 6），工作量的大头在这里。
如果 Promise 本来就通，**这 23 处 `await chrome.*` 一行都不用动**，
`lib/ext.js` 也可能**根本不需要**（除非要拿 `isGecko` 分支）。

> ⚠️ 这条改判**必须真机验证**才能定稿 —— 见第六节待验 #1。在做完那次验证之前，
> 不要把本报告当定论，也不要把旧清单删掉。

---

## 三、实证数据（当前 1.3.0）

### 3.1 `chrome.*` 调用点分布

扫描口径：`pack.py` 白名单里的全部文件（含 `lib/`）。

| 文件 | 处数 | 主要 API |
| --- | --- | --- |
| `background.js` | 31 | `tabs.sendMessage` ×7、`contextMenus` ×5、`tabs.captureVisibleTab` ×2、`offscreen` ×2、其余事件与 storage |
| `options.js` | 10 | `commands` ×5、`windows` ×3、`storage` ×2 |
| `content.js` | 8 | `storage` ×4、`runtime` ×3、`tabs.getZoom` |
| `lib/store.js` | 5 | `storage.local` |
| `popup.js` | 4 | `tabs.query`、`scripting.executeScript`、`runtime.openOptionsPage` ×2 |
| `offscreen.js` | 1 | `runtime.onMessage` |
| `frame-bridge.js` | **0** | 纯 `postMessage`，与扩展 API 无关 |
| `lib/panel-core.js` | **0** | 纯 DOM，无 API 依赖 |
| `lib/panel-styles.js` | **0** | 纯 CSS 字符串 |

**28 种 API 全集**：

```
commands(.getAll/.onCommand/.update)   contextMenus(.create/.onClicked/.removeAll)
offscreen(.createDocument/.closeDocument)
runtime(.connect/.onConnect/.onInstalled/.onMessage/.onStartup/.openOptionsPage/.sendMessage)
scripting.executeScript                 storage(.local/.onChanged)
tabs(.captureVisibleTab/.create/.getZoom/.onZoomChange/.query/.sendMessage)
windows(.getCurrent/.onFocusChanged)
```

### 3.2 调用风格

| 风格 | 处数 | Firefox 下是否需要改 |
| --- | --- | --- |
| `await chrome.xxx()` | **23** | **不需要**（见第二节） |
| `chrome.xxx().then()` | 2 | **不需要** |
| 回调（`function` 作末参） | **0** | —— |
| 自建 Promise 队列（与 API 无关） | 5 | 不需要 |

**0 处回调**这点很关键：整个项目从一开始就写成 Promise 风格，没有 callback/Promise 混用的历史债。

### 3.3 manifest 现状

```jsonc
"background": { "service_worker": "background.js", "type": "module" },  // ← Firefox 不认 service_worker
"options_page": "options.html",                                        // ← Firefox 126+ 才支持
"permissions": [..., "offscreen", ...],                                // ← Firefox 不认这个权限
"minimum_chrome_version": "110"                                        // ← Firefox 忽略（会 lint 警告）
```

`content_scripts` 两段（`lib/panel-core.js` + `content.js` 顶层；`frame-bridge.js` 全 frame）结构正常，
Firefox 的 `content_scripts` 与 `all_frames` / `match_about_blank` 都支持。

---

## 四、兼容性矩阵（BCD 实证，非推测）

数据来自 `mdn/browser-compat-data` 主干，逐条查过：

| 能力 | Firefox | 结论 |
| --- | --- | --- |
| `background.service_worker` | **`version_added: false`** | ❌ **不支持**，必须加 `scripts` |
| `background.scripts` | 48+ | ✅ 用这个（事件页，**有 DOM**） |
| `background.type: "module"` | **112+** | ✅ 支持 ESM 后台 |
| `options_page` | **126+** | ✅ 但抬高版本线 |
| `action`（MV3） | 109+ | ✅ 已满足 |
| `scripting.executeScript` | 102+ | ✅ 已满足 |
| `browser_specific_settings` | 42+ | ✅ |
| `gecko.data_collection_permissions` | **140+** | ⚠️ 新扩展**强制**，顶到 140 |
| `offscreen` API | **BCD 里不存在** | ❌ **Chrome 独有**，见第五节 |
| Promise 返回值 | 全部异步 API | ✅ 见第二节 |

**最低版本线的推导**：`options_page` 要 126、`data_collection_permissions` 要 140 →
两条叠加，`strict_min_version` 取 **140.0**。
顺带好处：140+ 能白拿 Firefox **内置**的数据收集同意界面；低于 140 得自己做「装完立即弹出且不可忽略」的流程，不值得。

---

## 五、唯一的硬骨头：`offscreen`

### 现状（Chromium 侧）

`background.js` 两处调用：

```js
await chrome.offscreen.createDocument({ url: OFFSCREEN_PATH, reasons: ["CLIPBOARD"], justification: "..." });
// ... 让 offscreen.js 读出剪切板图片，转 data URL ...
await chrome.offscreen.closeDocument();
```

**为什么要绕这一圈**：MV3 的 service worker **没有 DOM**，而 `navigator.clipboard` 只在有 DOM 的上下文里可用。
所以 Chromium 必须开一个隐形 offscreen 文档当「有 DOM 的地方」。

### Firefox 为什么反而更简单

**Firefox 的 MV3 后台是事件页（event page），它本身就有 DOM。**
（这也正是它不支持 `service_worker` 的原因 —— 两者是互斥的实现路径。）

因此在 Firefox 上：

1. **不需要 `offscreen` 权限、不需要 `offscreen.html/js`、不需要 createDocument/closeDocument**；
2. 后台直接跑现在 `offscreen.js` 里那段读剪切板的逻辑即可；
3. `clipboardRead` 权限 Firefox 支持，`execCommand("paste")` 那条兜底路径也还在。

### 三种落地方式（按侵入性从低到高）

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| **A. 运行时分支** | 探测 `chrome.offscreen` 是否存在；有则走 offscreen，无则后台直接读 | 一份代码通吃，代价是 background 里多一个分支与一个手抄的读取函数 |
| **B. 火狐专用后台垫片** | `firefox/offscreen-shim.js` 提供同名接口，后台代码不改 | 干净，但多一个文件要维护 |
| **C. 打包时裁剪** | Chromium 包留 offscreen，Firefox 包用不同 manifest + 换掉 background | 两个包内容差异变大，违背「一份代码」初衷 |

**倾向 A**：符合项目「一处真相源」的既有取向，且分支点只有一处、判据明确（`!!chrome.offscreen`）。

> 待验：Firefox 事件页里 `navigator.clipboard.read()` 是否需要用户手势、`execCommand("paste")` 是否仍可用。
> 真机试完再定 A 还是 B。

---

## 六、待验证清单（真机才能定，别猜）

| # | 待验 | 影响面 | 怎么验 |
| --- | --- | --- | --- |
| 1 | **Firefox 的 `chrome.*` 是否真返回 Promise** | 决定 23 处 `await` 要不要改、`lib/ext.js` 要不要存在 | 装 Firefox，控制台 `chrome.storage.local.get("k") instanceof Promise` |
| 2 | 一份 manifest 通吃是否成立 | 决定要不要维护两份 manifest | 加 `background.scripts` 后，**Edge 侧仍能正常加载**吗（Chrome 对 MV2-only 键的处理） |
| 3 | `web-ext lint` 对 `minimum_chrome_version` / `offscreen` 权限的报法 | 若报 **error** 就得按目标裁 manifest | `npx web-ext lint` |
| 4 | 事件页里剪切板能否读 | 第五节选 A 还是 B | 真机手动触发一次「剪切板 OCR」 |
| 5 | `data_collection_permissions` 的分类是否被审核认可 | 选错会被拒 | 首次提交时看审核反馈 |
| 6 | 火狐对 `match_origin_as_fallback` 的处理 | 影响 iframe 划词 | 真机在内嵌 iframe 的页面上试划词 |

**本机当前没有 Firefox**（第三节扫描全程只用 Node + 网络），第 1、4 条都要先装浏览器才能做。

---

## 七、建议的推进顺序

1. **先做待验 #1**（10 分钟）：装 Firefox，跑最小的 API 探测页，把 Promise 这条钉死。
   这一步的结论**决定后面所有工作量**，必须最先做。
2. 按结论做 `chrome.` → 别名的机械替换（若 #1 证明不需要，这步直接省掉）。
3. manifest 加 `background.scripts` + `browser_specific_settings`，做待验 #2。
4. `web-ext lint` + `web-ext run`，处理待验 #3。
5. 剪切板降级（第五节），做待验 #4。
6. 补测试与文档，两个商店分别提交。

---

## 八、这个文件夹打算怎么用

```
firefox/
  ANALYSIS.md      # 本报告
  manifest.json    # （待定）火狐专用 manifest —— 取决于待验 #2 的结论
  README.md        # （待定）构建/调试说明：web-ext run / web-ext lint 怎么跑
```

**与主仓库的关系**：

- 源码**不分叉** —— `content.js` / `background.js` / `lib/` 仍只有一份，放在仓库根目录。
- `firefox/` 只放**火狐独有的增量**（专用 manifest、垫片、调试说明）。
- `tools/pack.py` 的白名单（`ROOT_FILES` + `DIRS = ["lib","_locales","icons"]`）**不含 `firefox/`**，
  且它的兜底检查只扫**根目录的文件**、不递归目录 —— 所以这个文件夹不会被误打进 Edge 包。
- 若待验 #2 成立（一份 manifest 通吃），这个文件夹就只剩本报告 + 一份调试说明，更省事。

---

## 附：与旧清单的差异对照

| 项 | 旧清单（1.1.0） | 本报告（1.3.0） |
| --- | --- | --- |
| `chrome.*` 处数 | 约 45 | **59**（新增 frame-bridge 之外的模块，且 `lib/network.js` 已整块删除） |
| `lib/network.js` proxy 8 处 | 专门讨论「刻意不改」 | **文件已删除**，「临时直连」整块移除，本节作废 |
| Promise 判断 | 「全废」，需 `lib/ext.js` + content 手抄一份 | **不成立**，很可能一行都不用改（待验 #1） |
| 测试基数 | 808 项 | **1638 项**（静态 2 + lib 977 + engine 89 + strip 19 + e2e 551） |
| 最低版本 | 建议 140 | **140**（结论相同，但依据更明确：126 与 140 两条叠加） |
| 新文件 `lib/panel-core.js` | —— | 普通脚本、**零 API 依赖**，移植零成本 |

---

## 九、验证环境的一条限制（2026-11-06，已定位到根因）

本机装了绿色版火狐（159.0.1，见 `README.md`），但**助手所在的执行环境里跑不起完整的火狐进程**。

### 症状

```
[Parent 36908, IPC I/O Parent] WARNING: Failed to launch gpu subprocess
  @SB::LA::SpawnTarget (Error:-2147024891)
  file checkouts\gecko\ipc\glue\GeckoChildProcessHost.cpp:993
```

`-2147024891` = `0x80070005` = **拒绝访问**。火狐创建 GPU 子进程失败后直接退出。

### 根因：进程令牌缺特权

`SB::LA::SpawnTarget` 是火狐借自 Chromium 的沙箱库，创建降权子进程要用到：

| 特权 | 本环境状态 |
| --- | --- |
| `SeAssignPrimaryTokenPrivilege`（替换进程级令牌） | **令牌里根本没有** |
| `SeIncreaseQuotaPrivilege`（调整进程内存配额） | 在，但**已禁用** |

`whoami /priv` 实测确认。

### 这不是「创建子进程被禁止」

**同一个环境里 Edge 完全正常**：Playwright 能驱动它起多进程、开页面、渲染、截图。
所以全局的进程创建没问题 —— 是火狐沙箱这条**特定路径**需要那两个特权。

已排除的其它可能：

- 不在 job object 里（`IsProcessInJob` = False）
- 不是环境变量污染（构造干净环境重跑，错误不变）
- 不是 profile 问题（每次换全新 profile）
- 不是渲染/沙箱开关能解决的：`security.sandbox.content.level=0`、
  `gfx.webrender.software=true`、`fission.autostart=false`、
  `MOZ_FORCE_DISABLE_E10S=1`、`MOZ_DISABLE_CONTENT_SANDBOX=1` 全都无效 ——
  GPU 子进程在**这些开关生效之前**就已经尝试创建了
- `firefox.exe -v` 正常输出 `Mozilla Firefox 159.0.1`、退出码 0
  → 程序、依赖、目录布局都没问题

### 对移植工作的影响

**待验 #1 改由真人跑一次**：`firefox/_probe/` 是一个只做检测的最小扩展，
按 `README.md` 那五步操作（约 1 分钟），把弹出的结果页文本贴回来即可定稿。

**这个限制只影响助手**，不影响 kniph：正常桌面会话里登录用户持有完整令牌，
双击 `启动火狐.vbs` 不会被这一点挡住。
