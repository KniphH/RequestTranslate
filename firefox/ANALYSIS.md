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

---

## 十、已完成（2026-11-06）

步骤 1 和 2 都落地了，Edge 侧 1641 项全绿。

### ① manifest 加火狐键（**待验 #2 已确认成立**）

```jsonc
"background": {
  "service_worker": "background.js",     // Chromium 读这个
  "scripts": ["background.js"],          // 火狐读这个（它的 MV3 后台是事件页）
  "type": "module"
},
"browser_specific_settings": {
  "gecko": {
    "id": "requesttranslate@kniph.github.io",
    "strict_min_version": "140.0",
    "data_collection_permissions": { "required": ["websiteContent"] }
  }
}
```

**实测确认**：加了 `background.scripts` 之后 Edge 照常加载 —— service worker 起来了、
设置页正常、content script 正常注入、e2e 554 项全绿。也就是 Chrome 会**忽略**这个它不认的键，
所以**一份 manifest 通吃两边成立**，不需要维护两份。

### ② offscreen 降级

把读取逻辑抽成 `lib/clipboard-read.js`，两边共用同一份：

| | 后台形态 | 怎么读剪切板 |
| --- | --- | --- |
| Chromium | service worker（**无 DOM**） | 开一个 offscreen 文档，把读取逻辑跑在里面 |
| 火狐 | 事件页（**有 DOM**） | 后台自己就是「有 DOM 的地方」，直接读 |

判据是 `hasOffscreen()` = `!!(chrome.offscreen && chrome.offscreen.createDocument)`，
不用去嗅探 UA。`offscreen.js` 从 140 行减到 25 行（只剩转发消息）。

**Chromium 侧实测**：`chrome.offscreen` 存在 → 成功建出 offscreen 文档 →
`offscreen.js` 正常回应 `{ok:false, reason:"no-image"}`（剪切板没图，符合预期）。

**火狐侧尚未实测** —— 需要真机跑一次「剪切板 OCR」。这一步在本机做不了（见第九节）。

### ③ 还没做的

- **待验 #1**（`chrome.*` 是否返回 Promise）：靠 `firefox/_probe/` 那个探测扩展，需要真人跑一次。
  若结论是「返回 Promise」（MDN 说 Firefox 在所有异步 API 上都支持），那 23 处 `await` 一行都不用改。
- **待验 #3**：`web-ext lint` 对 `minimum_chrome_version` / `offscreen` 权限的报法。
- **待验 #4**：火狐事件页里读剪切板是否真的可用（`navigator.clipboard.read` 需要焦点）。
- 火狐上的端到端验证（本机跑不了火狐，见第九节）。

---

## 十一、真机实测结论（2026-11-07）

**kniph 在火狐 159 上临时载入本项目根目录的 `manifest.json`，实际跑通了。**
原话是「用起来没什么问题」。

这一次实测同时把三条待验里的两条钉死了：

| 原待验 | 结论 | 依据 |
| --- | --- | --- |
| **#1 `chrome.*` 是否返回 Promise** | **是** —— 代码里那 23 处 `await chrome.*` **一行都不用改** | 扩展在火狐上跑起来了：能加载、后台能起、content script 注入、面板显示、划词翻译走通。这些路径全都依赖 Promise |
| **#2 一份 manifest 通吃** | **成立** | 同一个 `manifest.json`，Edge 侧 1641 项全绿，火狐侧实测可用 |
| #3 `web-ext lint` 的报法 | **仍未做**（网络装不上 `web-ext`） | —— |
| #4 火狐事件页读剪切板 | **仍未单独验**（要试「剪切板 OCR」那条路） | —— |

### 也就是说：`lib/ext.js` 不需要存在

分析报告第二节推翻旧清单的「Promise 全废」，当时还标着「必须真机验证」。
现在验证完了 —— **那个改判是对的**，移植不需要 API 别名层，也不需要给 content script 手抄一份。

实际改动只剩两处，都已落地：

1. `manifest.json` 加 `background.scripts` + `browser_specific_settings`（8 行）
2. `offscreen` 降级：抽出 `lib/clipboard-read.js`，火狐直接读、Chromium 走 offscreen

### 还没验的

- **剪切板 OCR**（右键「翻译剪切板里的截图」）—— 这是唯一走了平台分支的功能，
  火狐那条路（后台直接读）还没实际跑过一次。
- 截图翻译 / 框选 / 图片直传等其余功能；用户说「没什么问题」覆盖的是常规划词翻译。

---

## 十二、`web-ext lint` 实测（待验 #3 完成，2026-11-07）

装了 Mozilla 官方的 `web-ext 10.8.0`，对打好的 `.xpi` 跑 lint。

**最初 1 error + 33 warning，现在 0 error + 33 warning（退出码 0）。**

### 那个 error 是 linter 的误报，已绕开

```
[JS_SYNTAX_ERROR] lib/clipboard.js:15
  Parsing as module error: Unterminated regular expression at line: 21
  Parsing as script error: import/export may appear only with sourceType: module
```

第 21 行是 `return /^image\//i.test(String(type || ''));` —— 转义斜杠的正则。
linter 的解析器把它当成「未终止的正则」，`export` 那半边自然是解析器退而求其次的次生报错。

**这是误报**：`node --check lib/clipboard.js` 通过，`node -e` 单独跑那个正则行为也正确，
项目里 20 个 js 文件 `node --check` 全过。而且**扩展在火狐上实测能跑**。

不过它会挡 AMO 上架，所以改成行为完全等价的写法：

```js
// 原来
return /^image\//i.test(String(type || ''));
// 现在
return String(type || '').toLowerCase().startsWith('image/');
```

### 33 个 warning 全是预期的，不挡上架

| 条数 | code | 是什么 |
| --- | --- | --- |
| 27 | `UNSAFE_VAR_ASSIGNMENT` | 动态 `innerHTML`。面板与列表都用它，内容走 `esc()` 转义 |
| 3 | `UNSUPPORTED_API` | `offscreen.createDocument` / `closeDocument` —— **正是运行时分支要处理的**，linter 只做静态扫描，看不出我们判了 `hasOffscreen()` |
| 1 | `MANIFEST_PERMISSIONS` | `offscreen` 权限火狐不认识 |
| 1 | `BACKGROUND_SERVICE_WORKER_IGNORED` | 火狐忽略 `background.service_worker`，读 `scripts` —— **这正是「一份 manifest 通吃」依赖的行为** |
| 1 | `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` | 某个清单键在 Firefox for Android 的最低版本上不支持；**我们不做 Android，无关** |

### 顺带把「`minimum_chrome_version` 会不会被报」也答了

**没报**。分析报告当初把它列进待验，担心会出 error —— 实际 linter 完全没提它。

### 复现命令

```bash
# 装（一次即可）
npm i -g web-ext

# 解压 xpi 到**短路径**（火狐那个长路径的坑同样适用于调试目录）
python -c "import zipfile; zipfile.ZipFile('dist/request-translate-1.3.0.xpi').extractall('C:/rtsrc')"

# lint（直接调 .js，别用 web-ext.cmd —— MSYS 会把它的路径转换坏）
node "$(npm root -g)/web-ext/bin/web-ext.js" lint --source-dir C:/rtsrc --output json
```

---

## 十三、火狐自动化测试（2026-11-07）

**火狐能跑自动测试了，用的是 WebDriver 而不是 Playwright。**

### 为什么不是 Playwright

Playwright 的 `firefox` 要 Mozilla 之外的**定制二进制**（走 Juggler 协议），
装不了任意扩展 —— 它只能跑 Playwright 自己认的那条通路。所以火狐侧走 WebDriver：

```
selenium 4.52 + geckodriver 0.37.1（Selenium Manager 自动获取，不用手装）
driver.install_addon(<源码目录>, temporary=True)
```

`install_addon(..., temporary=True)` 正好对应火狐的「临时载入」，
也是 Release 版唯一能装未签名扩展的路。

### 脚本：`tools/e2e-firefox.py`

```bash
pip install selenium
python tools/e2e-firefox.py
```

实测输出（火狐 159.0.1）：

```
  ok   扩展装得上（临时载入）  requesttranslate@kniph.github.io
  ok   content script 注入
  ok   划词弹出小圆点  {"show": true, "w": 45}
  ok   点小圆点能开面板  {"h": 248, "show": true}
  SKIP 扩展页面里验 Promise  WebDriver 不让进 moz-extension://

火狐冒烟：4 项通过，0 项失败
```

### 踩过的坑

| 坑 | 现象 | 解法 |
| --- | --- | --- |
| `-profile` 与 `set_preference` 冲突 | `SessionNotCreatedException: Failed to set preferences` | prefs 全写进 profile 的 `user.js`，别调 `set_preference` |
| `install_web_extension(temporary=True)` | `TypeError: unexpected keyword argument` | 用旧的 `install_addon`（4.52 的这个新方法不接 `temporary`） |
| `moz-extension://` 导航 | `Navigation ... is not allowed in this context` | WebDriver 的安全限制，改不了；这条降级为 SKIP |
| 扩展 UUID 在哪 | `extensions.json` 里没有（临时载入不写那个文件） | 在 `prefs.js` 的 `extensions.webextensions.uuids` 里，值是转义过的 JSON 字符串 |
| 块里改 `uuid = None` 想跳过后面的代码 | `ReferenceError: chrome is not defined` | **不行** —— Python 不会因为变量变了就中断当前代码块，必须再写一个 `if` |

### 比 SKIP 更有力的证据：面板真的翻译出来了

同一轮截图（`C:\rt-ff-e2e.png`）里，点开小圆点后面板显示的是**真实结果**：

```
Bing 翻译（免费 · 无需 Key）  |  简体中文
原文区：选中的两行
结果区：译文（状态「完成」）
底栏：HTTP 200 · 1.8s · Bing ttranslatev3
```

这条链路要跑通必须经过 `await chrome.storage.local.get`（读配置）、
`await chrome.runtime.connect` / `sendMessage`（连后台）、`await` 请求链。
**火狐上它跑通了，就是 `chrome.*` 返回 Promise 的直接证据** —— 比在扩展页面里
单独测一次更实在（那是「能不能」, 这是「实际在用并且成立」）。

### 和 Edge 那套的关系

| | Edge | 火狐 |
| --- | --- | --- |
| 驱动 | Playwright（CDP） | Selenium（WebDriver） |
| 脚本 | `tools/e2e-ui.mjs` | `tools/e2e-firefox.py` |
| 规模 | **554 项**，覆盖全功能 | **4 项**冒烟，只打火狐专有风险 |
| 进 `npm test` | 是 | **否**（要火狐和 geckodriver，太重） |

火狐这套定位是**移植验证**，不是回归主力 —— 凡是 Chromium 也能量到的，不在这里重复。
真要扩，优先补这几条：剪切板 OCR（唯一走平台分支的功能）、截图/框选、图片直传。
