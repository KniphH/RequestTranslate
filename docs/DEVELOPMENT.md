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
  engine.js            发请求 + 读响应（SSE / NDJSON / JSON / 纯文本），读响应只有 readResponseBody 一处
  adapters.js          内置适配器（Bing 两步流程），返回结构和 engine 一致
  trigger-styles.js    翻译按钮的样式表与三个预设（content.js 手抄一份，测试会比对）
  clipboard.js         剪切板图片：认 MIME（含按魔数猜）、转 data URL
  ocr.js               OCR 供应商状态、内置三条、请求体、取文字、报错文案
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

### 正文区的高度上限是设置里那条 `panelMaxHeight`

自适应模式下 `.rt-out` 的上限**不是**写死的 `46vh`，读的是面板上的 `--rt-max-h`（`applyPanelSize()` 从 `prefs.panelMaxHeight` 写上去，单位 vh）。默认 **46** —— 就是改动前那个写死值，老用户升级看不出变化（`test-lib` 有断言钉着这个数）。

单位选 vh 而不是 px：这条上限的用意是「别顶出视口」，跟着窗口走才对（px 在不同屏幕上都是错的）。填 0 表示不限，靠 `.rt-panel.no-max-h .rt-out { max-height: none }` **显式关掉** —— 别把变量设成 `none`，`calc(none * 1)` 是无效值，会让整条 `max-height` 失效（行为不好预期）。

`.rt-diag` 那个 `34vh` 是**另一条**，不跟这个设置走（诊断区是次要区域，自己有滚动条）。

### 「…」里那个模型名从哪来

`lib/engine.js` 的 `extractModelName(requestInfo)` 是唯一来源，只有两处**确定**的来源，按序取：请求体 JSON 里的 `model` → URL 路径里的 `/models/<名字>`（Gemini 那种把模型写进地址的，`:` 后面是动作要截掉）。请求里两处都没有，才退回**响应回显**的那个（`pickDataModel(finalData)`，不少中转每一帧都带）。都拿不到就是空串，面板**整行不显示** —— 不写「未知」占地方。

内置适配器（Bing）没有可编辑的请求文本（`result.request` 是 `null`），`emptyResult()` 里 `model` 同样是空串 —— 那条路本来就靠「命中路径」那行交代（`Bing ttranslatev3`）。适配器的返回值结构和 `runRequest` 必须一致，**加字段时两边一起加**。

### 滚动容器必须显式写回 `scrollbar-color: auto`

`.rt-out` / `.rt-src` / `.rt-diag` 三个滚动容器都要写 `scrollbar-color: auto; scrollbar-width: auto;`。

`scrollbar-color` 是**继承属性、能穿 shadow DOM** —— 只要网页上那个值不是 `auto`，浏览器就整段忽略自绘的 `::-webkit-scrollbar`，面板里会冒出网页配色的滚动条。写回 `auto` ≠ 放弃自定义，只是掐断继承。同类还有 `color-scheme`（影响 `<select>` 亮暗）。**新增滚动容器要一起加。**

### 流式渲染节流

成本正比于「渲染次数 × 译文长度」，所以 `RENDER_INTERVAL`（默认 50ms，约 20fps）对流式输出做时间节流。分片间隔超过 50ms 时每个分片都立即渲染，和没节流一样；只有分片涌进来（本地模型、开思考的模型）才触发。请求结束时 `done` 立刻写入最终文本，尾巴上不会少字。

流式吐字时**不自动跟随滚动**（`.rt-out` 全程不碰 `scrollTop`）—— 视口被一路拉着往下跑就没法从头读。

### 小圆点的定位

贴选区**末尾那个字**的右下角，不是整个选区外框的右下角（跨行选中时外框右边界会跑到最长那一行的末尾）。倒着拖选（鼠标停在选区开头）时反过来贴开头。

### 划词：哪些地方拿得到选区

`readSelection()` 里有个反直觉的坑：**选区的几何量会丢，文字还在**。所以判据必须挂在文字上，不能挂在几何量上。

- **Shadow DOM（Web Component）**：选区落在 shadow 里面时，会被**重定目标**到 document 层 —— `isCollapsed` 变成 `true`、`range.getBoundingClientRect()` 全 0、`getClientRects()` 空，**只有 `toString()` 还拿得到文字**。B 站评论区（`<bili-comments>`）和它里面的评论框都属这一类，症状就是「划视频标题弹按钮、划评论不弹」。现在的处理：以「文字为空」作为没选中的唯一判据；几何量全 0 时退回**鼠标松开的位置**（`pointRect`，和右键菜单那条路同一种形态，`placePanel` 本来就吃得下）。
- **`<input>` / `<textarea>`**：`window.getSelection()` 拿得到文字，几何量同样全 0、`anchorNode` 变成 `BODY` —— 也就是说 `isEditable()` 在它们身上**认不出来**（它真正拦住的只有普通 DOM 里的 `contenteditable`）。这类输入框现在也走「退回鼠标位置」那条路。
- **普通 DOM 里的 `contenteditable`**（知乎 / 微博那种编辑框）：文字和几何量都正常，`anchorNode` 是文本节点，**仍然被 `isEditable()` 有意排除** —— 在那里面划词多是在编辑文字（选中准备删改），弹按钮只会碍事。

**脚本构造的选区不代表真实行为**：`document.createRange()` + `selection.addRange()` 自己持有 shadow 内部节点，浏览器不做重定目标，几何量是好的。要复现这个现象**必须用真鼠标拖**（`page.mouse`），否则前置条件根本不成立 —— e2e 第 1.5 节就是这么写的。

### 配置下拉的缓存规矩

每个配置各留一份结果（`resultCache`，按 configId 存 `{r, ocr, action, fatal}`）：

- **翻过的**切回来原样放回（连灯、诊断），**一个请求都不发**
- **没翻过的**当场就翻一次，不能只清空等用户点 ↻
- 「↻」= **重发同一条请求**
- 作废是**数据驱动的**：`translate` 里拿 `cacheKey`（文字原文；截图直传用「长度 + 尾部 64 字符」）比上次，一变就 `resultCache.clear()`
- 归档用 `pendingConfigId`（发请求时那一个）；`pendingConfigId !== currentConfigId` 时 `start` / `delta` 必须直接丢

渲染收口在 `renderResult(r, ocr, action, fatal)` 一处。

### 顶栏那个配置下拉有两种模式

面板顶栏的下拉不是永远列全部配置：

| 这一屏在干什么 | 列表 | 选中的那条 |
|---|---|---|
| 划词 / OCR 认出来的文字 | `state.configs` 全部 | `currentConfigId`（面板自己的，**不落盘**） |
| **图片直传**（勾了「禁用外置 OCR」后截图） | 只列能翻图的（`canTranslateImage`，= 图片请求模板非空） | `imageConfigId`，**就是存档里的 `state.ocr.imageConfigId`** |

- 模式跟着**这次翻译**走：`translate()` 里 `hasImage` 一算出来就先切 `cfgMode` 并重画下拉，**再挑配置** —— 反了就会拿着上一屏那条发出去。
- `shownConfigId()` 是「这一屏用的是哪条」，缓存 / 状态灯的守卫全用它（原来直接写 `currentConfigId`）。
- **两个模式的选中项分开记**：翻图那一下不该改掉「文字用哪条」。但图片那一屏拨下拉**是要写回存档的**（`saveImageConfigId`）—— 后台只认 `state.ocr.imageConfigId`，不写回就变成「拨了没反应」。和换目标语言同一个坑：**先 `await` 写下去，再发请求**。
- 调用方**别把下拉的当前值当参数传给 `translate()`**（`cfgSelect.value` 可能是上一屏的）—— 传 `''`，让 `translate` 自己在切完模式之后读。
- 一条能翻图的都没填时退回全量 + 在 `title` 里说清「去哪填」，因为后台这时也会回退到顶栏那条，下拉得如实显示。

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

- **OCR 供应商也是一段可编辑的请求模板**（v7，和配置栏同一套管线）：`fillOcrTemplate` 填 `{{image}}` / `{{imageBase64}}` / `{{imageUrlEncoded}}` → `parseRequest` 解析 → fetch → `extractContent(json, responsePath, '\n')`。提示词**不是占位符**，直接写在模板文本里。`request` 留空才走老字段路径兜底（`buildOcrBody`，只为异常存档留着）。
- **提示词的内容不能随手写**：DeepSeek-OCR 只认训练时那几个固定预设，官方那条是 `<image>` 标记 + 换行 + `Free OCR.`。**换成别的措辞（哪怕意思一模一样的中文）就是把它推出训练分布，输出会退化** —— 实测会跑去生成 `<table>` 表格、识别率也掉。所以内置模板里那句不是随便写的，`test-lib` 有断言钉着这个字面量。
  - **落到模板里有两层转义**：JS 模板字符串里要写 `\\n`（两个反斜杠），生成出来的模板文本里才是字面的 `\n`，再经 `JSON.parse` 才得到真正的换行。**少写一个反斜杠就是裸换行 → JSON 解析直接失败**。老字段路径的 `DEFAULT_OCR_PROMPT` 反过来，那里是真值（JS 里写 `\n` 就是换行），`JSON.stringify` 会自己转义。
- **`buildOcrRequest()`（内部）+ `previewOcrRequest()`（打码层）是组装的唯一真相源**，`runOcr` 发的和设置页预览的是同一份。Authorization 在展示层打码（`maskAuthHeaders`），真请求别拿打码那份发。`.preview` 必须写 `flex: none`。
- **「读响应」也只有一处：`lib/engine.js` 的 `readResponseBody()`** —— 整体 JSON / `Content-Type` 是 `event-stream` 的 SSE / NDJSON / 纯文本，四类推断加跨分片拼装全在里面；`runRequest`（翻译）和设置页那两个「测试」（`runOcr` / `runImageTranslate`）都调它。原先 OCR 那两个自己写 `JSON.parse(await res.text())`，实机就炸在**图片模板里带 `"stream": true`** 的接口上（Ling 那种回 SSE）：面板那头走引擎翻得好好的，设置页这个「测试」却报「返回的不是 JSON」。它返回一份纯数据（`mode` / `text` / `raw` / `finalData` / `aborted` / `error` / 几个统计），传输途中的 AbortError **不当错误往外抛** —— 「手动中断，以下是已收到的部分」是引擎自己的措辞，OCR 那边不需要这层。OCR 侧判「回的根本不是 JSON」靠 `mode === 'text'`（或 `mode === 'json'` 却没解析出对象）；`joiner` 传 `'\n'`，百度那种 `words_result` 行数组要一行一行拼。**改它必跑 `test-engine` 全量 + `test-lib` 里那两条 SSE 用例。**
- **老字段 → 模板的无损搬家**在 `normalizeOcrProvider` 一处完成（`ocrProviderToTemplate`）：渲染后与旧 `buildOcrBody` 逐字节一致（键序 model→messages→max_tokens?→temperature；`{{image}}` 落在 shell 单引号 + JSON 双引号两层，data URL 两层转义恒等）。**老形状存档（没有 request 字段）整体优先**，不然内置模板里的 `{{apiKey}}` 会顶掉用户存在字段里的真 Key。
- **百度 OCR 是模板化的直接收益**：token 挂 URL 查询参数、`x-www-form-urlencoded` body、`words_result` 行数组 —— 以前这种协议得写适配器，现在就是一段模板（`builtin-baidu-ocr`）。`extractContent` 的自动探测加了 `words_result`。模板的 form 体带 `language_type=auto_detect`：**这个参数不写就是 `CHN_ENG`（中英混合），日文的假名会被当成中文读**（kniph 实测报过），百度没有 OpenAI 那种「天然自动识别」。有它就能钉死一种语言（`JAP` / `KOR` / `DUT` …）。
- **剪切板只能在 offscreen 文档里读**：content script 读不到（拿不到焦点、没有权限），所以临时开一个 `offscreen.html`，读完就关（省内存），不是常驻。
- **不猜 `blob.type`**：Windows 截图工具丢出来的那一项类型可能是**空串**，直接用会拼出 `data:;base64,…`，接口那边直接拒。所以按**文件头**认 MIME（PNG / JPEG / GIF / BMP / WEBP 魔数）。
- **大图的 base64 要分块转**：几十万字节一次性 `String.fromCharCode.apply` 会把调用栈撑爆。
- **「机制坏了」和「里面没图」分开报**：读不到剪切板（浏览器没放开权限）不会冒充「剪切板里没有图片」。
- **图片直传时「翻图用哪条配置」是独立选中的**：勾了「禁用外置 OCR」后，设置页 OCR 栏左栏整栏换成「图片配置」，那是 `state.configs` 的**过滤视图**（判据只有一个：`canTranslateImage` —— 图片请求模板非空），选中项存在 `state.ocr.imageConfigId`，跟顶栏那条 `activeConfigId` 互不影响。**不是另一份配置数据** —— 增删改只在「配置」栏（`＋ 新建供应商` 在直传模式下收起）。这样翻图前不用先回顶栏把配置切成支持视觉的那条，也不会把图误发给纯文字接口。选错了不会炸：`background.js` 走 `pickRequestConfig()`，`imageConfigId` 指向的那条 `imageRequest` 若是空的（或那 id 已不存在），自动回退到顶栏那条。左栏切换由 `renderOcrDisabled()` 一处收口（`#ocr-editor.is-imgcfg` 那几条 CSS 负责把右边供应商字段压掉，只留一句说明）。
- **同一份列表在面板顶栏也有一个入口**：图片那一屏顶栏的下拉列的就是这批配置（`ready` 消息里每条带 `img` 标志），选中的也是 `state.ocr.imageConfigId` —— 在那拨一下等于回设置页改选中项，所以拨完要写回存档（见上面「顶栏那个配置下拉有两种模式」）。判据收在 `lib/store.js` 的 `canTranslateImage` 一处，`content.js` 里那份 `imageCapable()` 是镜像（content script 不能 import，`test-lib` 有同形断言钉着）。
- **OCR 栏那块「测试」和「请求预览」在直传模式下会换对象**：不测这条 OCR 供应商，改测左栏选中的那条**图片配置的「图片请求模板」**（`runImageTranslate`，和 `runOcr` 共用 `buildOcrRequest` 那套图片占位符装配，差别只在措辞按「译文」）。理由：勾上之后这条路原本没有任何地方能试 —— 只能右键截一张图才知道配没配对。实现上是**同一块 UI**（`#o-test-field` / `.preview` 在 `.is-imgcfg` 下不藏，其余 `.field` 照旧隐藏），只是换标签 / 换提示 / 换数据源；CSS 里那条 `> .field:not(#o-test-field)` 就是为了放它过去。**换对象的三处都得跟着刷**：勾开关、切回 OCR 页签、点左栏另一条（后两处顺手把上次的测试结果收起来 —— 那已经不是这条的了）。
  - 「用不上的字段压暗」那条 `.is-off` 规则**已经删掉**：它和 `.is-imgcfg` 是同一个开关 toggle 的，而供应商字段早被整栏 `display: none` 了，压暗只剩「测试」和请求预览两块挨着 —— 那两块这时**还在用**，看着像被禁用、点了没反应。`e2e-ui` 用 `getComputedStyle().opacity` 钉着「两种模式下都是 1」。

---

## 存储与迁移（`lib/store.js`）

- 占位符转义看「落在几层引号里」，从内到外逐层转（`quoteStackAt` / `escapeInContext`），**不是**看「两侧紧挨着什么字符」。配套：`tokenize` 在 normal 状态认 `\'`。**改这块必跑 test-lib 第 21 节 + e2e 的「OCR 文本带撇号」。**
- 一条配置带两段模板：`config.request` 翻文字、`config.imageRequest` 翻图。挑哪段只认 `requestTemplateFor(config, context)`，别在别处再判一次。`{{imagePart}}` 是「一段模板两用」的备选，必须裸写、只能放最后。
- 挑**哪条配置**只认 `pickRequestConfig(state, configId, hasImage)`（紧跟 `requestTemplateFor` 之后）：文字走传进来的 / 存档里 `activeConfigId` 那条；图片在勾了「禁用外置 OCR」时优先看 `state.ocr.imageConfigId`，**那条的 `imageRequest` 非空才改道**，否则回退。`background.js` 就这一个入口（它 import 里已经没有 `getConfig` 了）。单测在 `test-lib` 第 15d 节。
- **配置级新字段**走 `normalizeConfig` 补默认，**不用迁移**；全新存档走 `freshConfigs()`。
- **新增一条内置配置**才要 `STORAGE_VERSION +1` + 迁移（v3→v4 补 `builtin-deepl`，插在内置 DeepSeek 后面，找不到锚点就 append，用户自己排的顺序一概不动）。
- **改「已有内置项」的默认值**要迁移的前提是「字段还单独存在」。v7 起 OCR 供应商整体模板化，老字段转换收在 `normalizeOcrProvider` 单一真相源里，v4→v5 那套「逐字比对老默认值再归位」的字段手术已随之删除 —— 老用户的 PaddleOCR 原样转成模板，不再强制换模型。
- **v7→v8 是模板化之后第一次改内置供应商的默认模板**（硅基流动补 `<image>\n` 提示词前缀、百度补 `language_type=auto_detect`），判据还是「逐字还等于老默认值」：`lib/store.js` 里那两段老模板是**冻死的字面量**（不能从 `OCR_PROVIDERS` 反推，那个早改过了）。**这里不能像 `configs` 那样把字段 `delete` 掉** —— `request` 一没，`normalizeOcrState` 会把它当成「老形状」走 `ocrProviderToTemplate`，拿空 endpoint 重新拼一段废模板出来；要显式写上新默认值。用户自己钉了 `language_type=JAP` 的那种，一个字节都不能动。
- 新增设置项 `{...默认, ...stored}` 合并即可，不用迁移；但**改已有字段的默认值**要迁移。
- **导出 / 导入**：`kind` / `version` / `exportedAt` 三个元字段必须写在 `...state` **之后** —— 顺序反了导进来的旧 `exportedAt` 会顶掉这次新写的（`version` 是**文件格式**版本，不是 `STORAGE_VERSION`）。`importState` 返回的 `exportedAt` 在 `options.js` 里用解构单独拎出来，别 spread 进 state。
- **API Key 会在三个地方露脸**：变量栏的值（**默认打码**，点眼睛才看）、配置 / OCR 的请求预览（`maskApiKey` / `maskAuthHeaders` 打码）、以及**请求模板原文本身**（那是一整段可编辑文本，写死在里面的 key 没法打码，只能提醒用户）。变量栏打码走 `-webkit-text-security: disc`，**不用 `<input type="password">`** —— 后者会招来密码管理器的保存提示，还有 Edge 自带那个原生眼睛（跟我们这个按钮重复）。注意这是**防肩窥**不是加密：值仍是明文存的，导出文件里也照样有。

---

## 设置页左栏：条目必须 `width: 100%`

「配置」栏每条都包在 `.cfg-row`（`display: flex`）里，`.cfg-item` 的 `flex: 1` 把宽度拉平了；左栏（OCR 供应商）那几条是**直接躺在 `.list-body`（`display: block`）里**的 —— 这时 `flex: 1` 是死的，而 `.cfg-item` 的 `width: auto` 对 **`<button>`** 来说等于「**收缩到内容宽度**」（按钮不像普通块级盒那样撑满，走的是 fit-content 那套）。于是名字长的条宽、名字短的条窄，一列参差不齐 —— 实机量过：同一次渲染里四条分别是 `84 / 206 / 310 px`（310 那条还溢出了列表）。修法是补一条 `.list-body > .cfg-item { width: 100% }`（只作用于「直接躺在列表里」的那种，配置栏不受影响）。

左栏有两种长相，判据得同时容得下：OCR 供应商是 `.list-body > .cfg-item`（靠上面那条 `width: 100%`），「图片配置」是 `.list-body > .cfg-row > .cfg-item`（行本身铺满，条目靠 `flex: 1`）。`e2e-ui` 因此量的是「条目 + 同一行里除它以外的那些」= 行宽，判据是**每行都占满列表可用宽度**（不是「彼此相等」）—— 这样**只有一条时也能测**（有 bug 时它会缩成窄条）。

---

## 两个列表共用一套排序

「配置」栏和 OCR 栏那份「图片配置」长得一样、操作也一样，所以 `options.js` 只有一套实现：`sortableRow()`（手柄 + 条目 + ↑↓）、`moveButton()`、`dropSpot()`、`bindSortDrag()`。四个的 `listEl` / `onMove` 都是参数 —— 加第三个可排序列表时照着传就行，别复制一份出来改。

拖动排序用 **pointer 事件**而不是 HTML5 的 `draggable`（后者触屏压根不触发，原生拖影在设置页里也脏），代价是插入指示线得自己画（`.drop-before` / `.drop-after` / `.dragging`），落点用坐标算（`dropSpot`）而不做命中测试 —— 拖动时指针是「抓」在手柄上的，`elementFromPoint` 只会把手柄自己还回来。

**`to` 的口径要分清**：「配置」栏给的是完整数组下标；「图片配置」是 `state.configs` 的**过滤视图**，给的是过滤视图下标，得再过一层 `moveVisibleItem(all, visibleIds, from, to)` 换算成完整数组上的落点。**排序动的一定是 `state.configs` 本身**（另存一份顺序就是第二个真相源），副作用是「配置」栏的先后跟着一起变 —— 同一份数据，预期内的，所以两个列表都要重画。

`moveItem` / `moveVisibleItem` 的 `to` 都是「**移除之后**」的坐标，往下挪时和「移除之前」差一位（经典 off-by-one）。两者算下来没动就**返回原数组引用**，调用方靠 `next === arr` 跳过重渲染。

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
npm test              # 静态检查 + 单元 + 端到端 + 真实浏览器 UI（926 项）
npm run check         # 只跑两项静态检查
npm run test:lib      # 解析器 / 模板 / 提取
npm run test:engine   # 本地 mock 服务器，验证各类响应格式
npm run test:ui       # 开真实 Edge 加载扩展，量 DOM 实际尺寸
npm run perf          # 量性能：主线程任务时间 + 进程 CPU，四档流式负载对照
npm run icons         # 重新生成图标
npm run pack          # 出 dist/request-translate-<版本>.zip（传商店 / 挂 Release 用）
```

`npm run perf` 只跑指定档位可以快很多：`PERF_ONLY=heavy npm run perf`（可选档位 `normal` / `fewLong` / `manyShort` / `heavy`）。

拆开看是 `test-lib` 535 项、`test-engine` 87 项、`e2e-ui` 302 项，另加两项静态检查。各层补的盲区不同：

- **`check-globals`** — 语法检查看不出 `bindConfigList()` 这种「调用了但没写」，只有运行时才炸。它把注释、字符串、正则字面量剥掉之后逐个比对调用与声明。也可以指定文件：`node tools/check-globals.mjs lib/engine.js`。新增 `lib/*.js` 记得加进目标清单（含 `offscreen.js`）。识别**解构出来的对象参数**（`function f({ a, b })`）要单独一条正则 —— 只写 `\(([^()]*)\)` 的话 `{ a, b }` 整块留下来、拆开后每片都带花括号，一个都认不出来，里面的 `a` / `b` 反倒被报成「没定义」（`moveButton({ … onMove })` 踩过）。
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
  - 长流式那节的收尾顺手量**结果区最大高度**：从设置页改 `panelMaxHeight`（走 storage + `onChanged` 那条真路），量 `getComputedStyle('.rt-out').maxHeight` 换算的 px 对不对得上 `vh × innerHeight × --rt-zoom`，**同时**断言 `clientHeight` 真的跟着变 —— 只看 max-height 的话，「写了个变量但没生效」会漏过去
- 量面板时**别让请求去够真实网络**，做本地假接口再把它指过去。

### 改完代码怎么生效

在扩展管理页点一下「重新加载」，**然后刷新目标网页** —— 两件都要做。

只重新加载扩展不够：已经在开着的页面里跑的是**旧的那份 content script**，它不会自己换成新的（而且扩展一重新加载，旧脚本手里的 `chrome.*` 就失效了）。症状很好认：设置页明明是新的、预览也对，网页上却还是老样子。

---

## 已知的硬边界

- **`manifest.json` 的 `proxy` 权限已经整块删掉**（原先只为「临时直连」服务）。别再捡回来 —— 代理分流应该在代理软件里按规则做，加这个权限会让 Edge 显示「读取和更改您的代理设置」。
- Bing 通道**代理开启时必然空 body**。首选在代理客户端加 `DOMAIN-SUFFIX,bing.com,DIRECT`；插件侧不再有任何兜底手段。
- API key 明文存 `chrome.storage.local`，导出配置文件等于泄 key。
