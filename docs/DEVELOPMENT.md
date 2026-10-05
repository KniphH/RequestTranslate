# RequestTranslate 开发说明

面向改这个仓库的人。**README 只讲怎么用，这里讲怎么实现的、怎么验证的。**

零依赖、零构建，MV3，直接「加载解压缩的扩展」。

---

## 目录结构

```
manifest.json          MV3 清单
background.js          请求转发、流式推送、右键菜单、读剪切板 + 调 OCR
content.js             划词小圆点 + Shadow DOM 结果面板
offscreen.html/js      临时的 offscreen 文档：只为读剪切板（读完即关）
popup.html/js          工具栏弹窗：快切配置 + 手动翻译
options.html/js/css    设置页：多配置管理、变量、OCR 供应商、测试
lib/
  request-parser.js    curl / 原始报文解析，引号、续行、注释、JSON 修复
  template.js          占位符替换 + 智能转义
  extract.js           响应路径提取与自动探测
  engine.js            发请求 + SSE / NDJSON / 文本流式解析
  adapters.js          内置适配器（Bing 两步流程），返回结构和 engine 一致
  trigger-styles.js    翻译按钮的样式表与三个预设（content.js 手抄一份，测试会比对）
  clipboard.js         剪切板图片：认 MIME（含按魔数猜）、转 data URL
  ocr.js               OCR 供应商状态、内置两条、请求体、取文字、报错文案
  store.js             配置存储、内置示例、导入导出、版本迁移
tools/
  make-icons.py        纯标准库生成图标
  pack.py              打包 dist/*.zip（传商店 / 挂 Release）
  check-globals.mjs    静态检查：找出「调用了但没定义」的函数
  check-dom.mjs        静态检查：JS 里引用的 id / class 是否真实存在
  test-lib.mjs         解析/转义/提取/适配器/OCR 的单元测试
  test-engine.mjs      起本地假 API 跑端到端（含 Bing 两步流程的假接口）
  e2e-ui.mjs           真的开一个 Edge 加载扩展跑 UI 回归
  perf-probe.mjs       量主线程任务时间 + 采样进程 CPU，四档负载做布局归因
```

---

## 内置适配器：Bing 免费通道

Bing 网页版翻译是**两步**：先 GET `bing.com/translator`，从 630KB 的 HTML 里正则抠出 `IG` / `IID` / `key` / `token`；再拿这些参数 POST 到 `ttranslatev3`。第二步的入参是第一步动态拿到的，**请求模板写不出来**，所以这段走代码。

- token 缓存一小时，失效时 Bing 返回 `HTTP 200` + **空 body**（光看状态码判断不出来），插件会重抓一次自动重试
- 适配器的返回值结构必须和 `engine.runRequest` **完全一致** —— 面板 / 诊断 / 「…」详情 / 错误处理原样复用，不再写第二套
- 适配器只打 `cn.bing.com` 两处（`/translator` + `/ttranslatev3`），没有 MET 模式。所以 README 那份代理直连清单里，第一条 `bing.com` 就是本插件需要的全部，其余几条是给同一客户端里别的 Bing 工具留的
- `www.bing.com` 与 `cn.bing.com` 解析到同一个 IP（实测 `202.89.233.101`），但前者回 302 —— 所以适配器写死 `cn.`

表达不了的其他服务（需要多步、需要动态 token）同样走 `lib/adapters.js`，别在 `engine.js` 里加特例。

---

## 结果面板的实现要点

### 缩放补偿

面板是 `fixed` + `transform: scale(1/zoom)`，而 `transform-origin` 是左上角 —— 缩放**不会移动左上角**，但宽高要乘 `1/zoom`。`chrome.tabs.getZoom` 拿标签页的真实缩放比。

按钮不用 `transform`，而是把尺寸写成 CSS 变量（`--rt-tr-size` / `--rt-tr-radius` / `--rt-tr-font`，圆形预设的底色 / 图标色 / 描边色是 `--rt-tr-bg` / `--rt-tr-fg` / `--rt-tr-bd`）按 `1/zoom` 缩 —— 这样 hover 放大（×1.08）照常工作，尺寸也不会被内联样式写死。

夹取边界要拿「布局尺寸 × 1/zoom」去算；直接拿 `offsetWidth` 和 `innerWidth` 比，网页一缩放就会从右边或下边溜出去。

### 滚动容器必须显式写回 `scrollbar-color: auto`

`.rt-out` / `.rt-src` / `.rt-diag` 三个滚动容器都要写 `scrollbar-color: auto; scrollbar-width: auto;`。

`scrollbar-color` 是**继承属性、能穿 shadow DOM** —— 只要网页上那个值不是 `auto`，浏览器就整段忽略自绘的 `::-webkit-scrollbar`，面板里会冒出网页配色的滚动条。写回 `auto` ≠ 放弃自定义，只是掐断继承。同类还有 `color-scheme`（影响 `<select>` 亮暗）。**新增滚动容器要一起加。**

### 流式渲染节流

成本正比于「渲染次数 × 译文长度」，所以 `RENDER_INTERVAL`（默认 50ms，约 20fps）对流式输出做时间节流。分片间隔超过 50ms 时每个分片都立即渲染，和没节流一样；只有分片涌进来（本地模型、开思考的模型）才触发。请求结束时 `done` 立刻写入最终文本，尾巴上不会少字。

流式吐字时**不自动跟随滚动**（`.rt-out` 全程不碰 `scrollTop`）—— 视口被一路拉着往下跑就没法从头读。

### 小圆点的定位

贴选区**末尾那个字**的右下角，不是整个选区外框的右下角（跨行选中时外框右边界会跑到最长那一行的末尾）。倒着拖选（鼠标停在选区开头）时反过来贴开头。

### 配置下拉的缓存规矩

每个配置各留一份结果（`resultCache`，按 configId 存 `{r, ocr, action, fatal}`）：

- **翻过的**切回来原样放回（连灯、诊断），**一个请求都不发**
- **没翻过的**当场就翻一次，不能只清空等用户点 ↻
- 「↻」= **重发同一条请求**
- 作废是**数据驱动的**：`translate` 里拿 `cacheKey`（文字原文；截图直传用「长度 + 尾部 64 字符」）比上次，一变就 `resultCache.clear()`
- 归档用 `pendingConfigId`（发请求时那一个）；`pendingConfigId !== currentConfigId` 时 `start` / `delta` 必须直接丢

渲染收口在 `renderResult(r, ocr, action, fatal)` 一处。

顶栏的语言下拉是同一套规矩，另外还挂在 `applyState` 上（`prevLang !== prefs.targetLang` 就 clear），这样在设置页改语言同样作废。**改语言必须 `await saveSetting('targetLang', v)` 再发请求** —— 后台是 `loadState()` 现读存档渲染 `{{target}}`，写没落盘就发，这条会带着上一门语言出去。

---

## 翻译按钮（`lib/trigger-styles.js`）

- 预设全压成 `.rt-trigger:where(.s-xxx)`（`:where()` 优先级贡献 0），所以以后想叠加样式直接写 `.rt-trigger { … }` 就压得住，不用 `!important`。
- `custom` 预设带 `bare: true`，CSS 里 `background / border / box-shadow` **显式清零** + `.rt-ico { padding: 0 }`（显式清零，不是「不写」）。
- `custom` **故意没有 `svg` 字段** —— 设置页那张卡片画的就是你实际会用的图标，没填就空着；预览和页面按钮则用 `TRIGGER_SVG_SAMPLE`（三线 + 箭头）占位。**删字段会牵动预览**，动这份数据结构前先把「谁在拿它兜底」列一遍。
- 老存档里的 `nib` 要归一化：`loadState` 里认不出就 `→ DEFAULT` 并置 `migrated = true` 写回。**这不吃 `STORAGE_VERSION`**（没加字段、没改默认值），所以 version 已最新的存档同样要过这关。

**为什么 SVG 是「整段拒绝」而不是「剔除危险标签」**：content script 能碰到 `chrome.*`，放进来一段能执行的东西代价太大；而「剔除」太容易漏 —— 大小写、`xlink:` 命名空间、`<use>` 引用外部符号…… 漏一个就等于没防。判据在 `SVG_GUARDS`（形状要求 + 命中即拒绝，靠 `negate` 区分语义）。

**content script 不能 `import`** → CSS / 预设 SVG / `SVG_GUARDS` 在 `content.js` 里手抄一份，必须配逐字比对测试（`test-lib.mjs` 第 17 节用 `fs` 读 `content.js` 比）。**坑**：比对拿的是**文件原文**，带换行的 SVG 要写成**模板字符串**（`'\n'` 在原文里是「反斜杠 + n」，squash 空白也对不上）。

---

## OCR 的几个实现点

- **`previewOcrRequest()` 是组装请求的唯一真相源**，`runOcr` 直接拿它的 `body` 发（单测钉着）。`.preview` 必须写 `flex: none`。
- **剪切板只能在 offscreen 文档里读**：content script 读不到（拿不到焦点、没有权限），所以临时开一个 `offscreen.html`，读完就关（省内存），不是常驻。
- **不猜 `blob.type`**：Windows 截图工具丢出来的那一项类型可能是**空串**，直接用会拼出 `data:;base64,…`，接口那边直接拒。所以按**文件头**认 MIME（PNG / JPEG / GIF / BMP / WEBP 魔数）。
- **大图的 base64 要分块转**：几十万字节一次性 `String.fromCharCode.apply` 会把调用栈撑爆。
- **「机制坏了」和「里面没图」分开报**：读不到剪切板（浏览器没放开权限）不会冒充「剪切板里没有图片」。
- **模型和提示词绑在一起**：内置是硅基流动 `deepseek-ai/DeepSeek-OCR`，提示词默认 `Free OCR.`。**提示词不给预设按钮**（各家格式互不相通），也不加 `<image>` 前缀。
- `max_tokens` 默认不发（`normalizeTokenLimit` 归零），因为上限是「提示词 + `max_tokens`」**加在一起**算的。

---

## 存储与迁移（`lib/store.js`）

- 占位符转义看「落在几层引号里」，从内到外逐层转（`quoteStackAt` / `escapeInContext`），**不是**看「两侧紧挨着什么字符」。配套：`tokenize` 在 normal 状态认 `\'`。**改这块必跑 test-lib 第 21 节 + e2e 的「OCR 文本带撇号」。**
- 一条配置带两段模板：`config.request` 翻文字、`config.imageRequest` 翻图。挑哪段只认 `requestTemplateFor(config, context)`，别在别处再判一次。`{{imagePart}}` 是「一段模板两用」的备选，必须裸写、只能放最后。
- **配置级新字段**走 `normalizeConfig` 补默认，**不用迁移**；全新存档走 `freshConfigs()`。
- **新增一条内置配置**才要 `STORAGE_VERSION +1` + 迁移（v3→v4 补 `builtin-deepl`，插在内置 DeepSeek 后面，找不到锚点就 append，用户自己排的顺序一概不动）。
- **改「已有内置项」的默认值同样要迁移**（v4→v5 换内置 OCR）：`{...默认, ...stored}` 救不了，只能显式归位。判据是「这些字段是否**逐字还等于老默认值**」，是才动。要归位的字段直接 `delete`，后面 normalize 补新默认；迁移里那几个老值必须是**冻死的字面量**。
- 新增设置项 `{...默认, ...stored}` 合并即可，不用迁移；但**改已有字段的默认值**要迁移。
- **导出 / 导入**：`kind` / `version` / `exportedAt` 三个元字段必须写在 `...state` **之后** —— 顺序反了导进来的旧 `exportedAt` 会顶掉这次新写的（`version` 是**文件格式**版本，不是 `STORAGE_VERSION`）。`importState` 返回的 `exportedAt` 在 `options.js` 里用解构单独拎出来，别 spread 进 state。

---

## 性能

`npm run perf` 会用系统 Edge 真加载扩展，量主线程的实际任务时间。实测：

| 场景 | 主线程占空比 |
|---|---|
| 空闲（页面静止，无选区无面板） | **0.0%**（5 秒内共 2ms） |
| 连续滚动 3 秒 | 0.9% |
| 连续划词 40 次 | 3.0%（每次约 0.7ms） |
| 流式翻译：800 字 / 100 分片 | 3.4% |
| 流式翻译：8000 字 / 500 分片 | 4.0% |

**空闲零消耗。** 没有 `setInterval`、没有 `MutationObserver`、没有常驻动画，只在划词和点按钮的时刻干活。

**唯一真正花钱的是流式渲染**（理由和节流做法见上）。

| 负载 | 节流前 | 节流后 |
|---|---|---|
| 800 字 / 100 分片 | 52ms | **37ms** |
| 1000 字 / 500 分片 | 115ms | **45ms** |
| 8000 字 / 500 分片 | 435ms | **142ms** |

试过但**实测无效**的做法：把两次强制布局减为一次、用 `requestAnimationFrame` 合并、原地改写文本节点 —— 都在噪声内（±3%）。因为分片间隔本来就接近刷新率，合并不了多少。唯一有效的杠杆是「少渲染几次」。

---

## 开发与验证

```bash
npm test              # 静态检查 + 单元 + 端到端 + 真实浏览器 UI（760 项）
npm run check         # 只跑两项静态检查
npm run test:lib      # 解析器 / 模板 / 提取
npm run test:engine   # 本地 mock 服务器，验证各类响应格式
npm run test:ui       # 开真实 Edge 加载扩展，量 DOM 实际尺寸
npm run perf          # 量性能：主线程任务时间 + 进程 CPU，四档流式负载对照
npm run icons         # 重新生成图标
npm run pack          # 出 dist/request-translate-<版本>.zip（传商店 / 挂 Release 用）
```

`npm run perf` 只跑指定档位可以快很多：`PERF_ONLY=heavy npm run perf`（可选档位 `normal` / `fewLong` / `manyShort` / `heavy`）。

拆开看是 `test-lib` 451 项、`test-engine` 75 项、`e2e-ui` 232 项，另加两项静态检查。各层补的盲区不同：

- **`check-globals`** — 语法检查看不出 `bindConfigList()` 这种「调用了但没写」，只有运行时才炸。它把注释、字符串、正则字面量剥掉之后逐个比对调用与声明。也可以指定文件：`node tools/check-globals.mjs lib/engine.js`。新增 `lib/*.js` 记得加进目标清单（含 `offscreen.js`）。
- **`check-dom`** — 比对 JS 里的 `$('#id')` / `querySelector('.x')` / `closest('.x')`，和「HTML 里写死的**加上** JS 里拼出来的」类名，防的是「选择器指向不存在的元素，启动时炸在 null 上」。正则里的坑：`querySelectorAll?` 那个 `?` 只管最后一个 `l`，**所有 `querySelector('.x')` 从来没被扫到**，得写 `querySelector(?:All)?`。
- **`e2e-ui`** — 前两项只能说「代码能跑、选择器对得上」，管不了**长得对不对**。脚本用系统 Edge（`playwright-core`，不下载浏览器）加载扩展，真去划词、点按钮，用 `getBoundingClientRect` 量顶栏多高、面板多宽、缩放后尺寸有没有变。没装 Edge 会自动跳过。几处要点：
  - **正文是一个大 `try` 块**，`const` 同一作用域：加变量前先 grep 名字，重名直接 `SyntaxError`（跑 1 秒就退）
  - **小节之间会互相污染**：某节写进 storage 的开关不收尾，后面就走另一条路，而且**不报错**。瞬时态靠假接口 `/slow`（挂 1.2s）+ `waitForFunction` 采，别 sleep；失败消息带「class｜状态栏文字｜lastPath」
  - 状态灯那三态（紫/绿/红）靠 `/slow` 把「请求在飞」的瞬间停住才采得到
  - 截图 OCR 那段会**往系统剪切板里真塞一张 PNG**（PowerShell `-STA` + `System.Windows.Forms.Clipboard::Set*`）再跑全链路，而且必须开**有头**窗口 —— 无头 Chromium 的剪切板是桩实现，读回来永远是空的
  - 「换配置」一节用两个假配置各带 `?tag=`，靠假接口被打的次数和译文里的标记钉住三条：切回翻过的**一个请求都不发**、切到没翻过的**当场就翻**、流还在飞时用户切走了别的配置的流不许糊到这一屏上
  - 往测试页 `html` 写一条 `scrollbar-color`，验面板里的滚动条**不吃网页配色**
  - 按钮样式那节把「自定义」两个分支都走一遍（填了图标 / 没填用示例顶着），在页面上量计算样式确认**真的没有底色**
  - 「导出 / 导入」真点一次导出、把下载的文件读出来解析，再拿它改一份「别的设备导出的」塞回去，顺带走「点取消什么都不动」「坏文件」「别的软件的 JSON」三条失败路径
  - 最后两节：**顶栏换目标语言**（把 `{{targetCode}}` 接进假接口查询串，拨一下下拉就断言请求真带着 `tag=EN` 重发了一条），以及**流式输出不甩着滚动条跑**（`/streamlong` 长流式路由把面板撑出滚动条，断言吐到一半和吐完之后 `scrollTop` 都是 0 —— 光断言「没滚」不够，得同时断言「内容确实长到该滚了」，不然是空跑）
- 量面板时**别让请求去够真实网络**，做本地假接口再把它指过去。

### 改完代码怎么生效

在扩展管理页点一下「重新加载」，**然后刷新目标网页** —— 两件都要做。

只重新加载扩展不够：已经在开着的页面里跑的是**旧的那份 content script**，它不会自己换成新的（而且扩展一重新加载，旧脚本手里的 `chrome.*` 就失效了）。症状很好认：设置页明明是新的、预览也对，网页上却还是老样子。

---

## 已知的硬边界

- **`manifest.json` 的 `proxy` 权限已经整块删掉**（原先只为「临时直连」服务）。别再捡回来 —— 代理分流应该在代理软件里按规则做，加这个权限会让 Edge 显示「读取和更改您的代理设置」。
- Bing 通道**代理开启时必然空 body**。首选在代理客户端加 `DOMAIN-SUFFIX,bing.com,DIRECT`；插件侧不再有任何兜底手段。
- API key 明文存 `chrome.storage.local`，导出配置文件等于泄 key。
