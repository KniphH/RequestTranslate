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
  pack.py              打包 dist/*.zip（跑完全量测试才打，`--skip-test` 应急、`--no-strip` 不剥注释）
  strip-comments.mjs   打包时用的注释剥离器（词法级，见下）+ test-strip.mjs 它的自测
  verify-pack.py       打包后验包：语法 / 行号守恒 / 剥得干净（幂等）
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

**鼠标划词：直接贴鼠标**，一个字节的选区几何量都不看 —— 松手点右下方 `MOUSE_GAP`（14 物理像素），右下角放不下就整块翻到左上（翻过去离指针还是 14px，指针始终不在按钮里）。选区几何量靠不住：跨行时外框的右边界会跑到**最长那一行**的末尾，双击选段、页面元素多、在空旷处上下划的时候，从选区里挑出来的「角」离手指能差好几百像素。

**键盘扩展选区：贴光标那一行**（`caretRect()`，`focusNode` / `focusOffset` 那一端）的右下角。浏览器**不提供**「当前鼠标在哪」的查询接口 —— 坐标只挂在事件对象上，所以实测里 `lastMouse` 是上一次鼠标动作留下的**旧坐标**，拿它当锚点会指到页面别处去。为此 `keyup`（Shift / 方向键那条路）里会**主动把它清成 null**，`readSelection()` 据此分流。

- `MOUSE_GAP` 必须拉开：按钮压在指针底下会立刻命中 `:hover`，于是「鼠标停在按钮上不消失」永远为真，那个计时器再没机会到点。`mousemove` 里那个「刚出现 250ms 内不算 hover」是给「视口小到夹取兜不住」留的后手。
- **两个计时只有一个事件源**（`mousemove`），别拆成 `mouseenter` / `mouseleave`：指针离开按钮时浏览器发的是 `mouseleave` **紧跟一个 `mousemove`**，那个 `mousemove` 会把刚设好的「移开短计时」清掉 —— 于是「移开才消失」永远不生效（实测踩到过）。`mousemove` 里用 `composedPath().includes(trigger)` 自己判断在不在按钮上。
- 显示时（`armTriggerIdle`）要把**两个**计时一起清掉：上一次残留的「移开短计时」会把刚显示出来的按钮顺手抹掉（鼠标刚好从按钮上滑过之后重划一次就踩到了）。
- 按键页缩放重算位置时**别重新读选区**（`setZoom` → `placePanel(lastAnchor)`）：读出来的是鼠标位置，缩放一下面板就跳到鼠标那儿去了。顺带记一条：**标签页缩放只改视口尺寸，页面里元素的 CSS 坐标不动**（`window.innerWidth` 1170 → 780，同一个字的 x 还是 104），所以锚点原样拿去重算就够了，不要乘比例。
- 抄 rect 用 `copyRect()`，**不要 `{ ...rect }`**：`DOMRect` 的 `left/top/right/bottom` 挂在原型上，展开只会得到 `x/y/width/height`。

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
- **`buildOcrRequest()`（内部）+ `previewOcrRequest()`（打码层）是组装的唯一真相源**，`runOcr` 发的和设置页预览的是同一份。展示层打码统一走 `maskRequest`（url / headers / body 都按名字含 key 的变量打，见「配置存储」那节），真请求别拿打码那份发。`.preview` 必须写 `flex: none`。
- **「读响应」也只有一处：`lib/engine.js` 的 `readResponseBody()`** —— 整体 JSON / `Content-Type` 是 `event-stream` 的 SSE / NDJSON / 纯文本，四类推断加跨分片拼装全在里面；`runRequest`（翻译）和设置页那两个「测试」（`runOcr` / `runImageTranslate`）都调它。原先 OCR 那两个自己写 `JSON.parse(await res.text())`，实机就炸在**图片模板里带 `"stream": true`** 的接口上（Ling 那种回 SSE）：面板那头走引擎翻得好好的，设置页这个「测试」却报「返回的不是 JSON」。它返回一份纯数据（`mode` / `text` / `raw` / `finalData` / `aborted` / `error` / 几个统计），传输途中的 AbortError **不当错误往外抛** —— 「手动中断，以下是已收到的部分」是引擎自己的措辞，OCR 那边不需要这层。OCR 侧判「回的根本不是 JSON」靠 `mode === 'text'`（或 `mode === 'json'` 却没解析出对象）；`joiner` 传 `'\n'`，百度那种 `words_result` 行数组要一行一行拼。**改它必跑 `test-engine` 全量 + `test-lib` 里那两条 SSE 用例。**
- **老字段 → 模板的无损搬家**在 `normalizeOcrProvider` 一处完成（`ocrProviderToTemplate`）：渲染后与旧 `buildOcrBody` 逐字节一致（键序 model→messages→max_tokens?→temperature；`{{image}}` 落在 shell 单引号 + JSON 双引号两层，data URL 两层转义恒等）。**老形状存档（没有 request 字段）整体优先**，不然内置模板里的 `{{apiKey}}` 会顶掉用户存在字段里的真 Key。
- **百度 OCR 是模板化的直接收益**：token 挂 URL 查询参数、`x-www-form-urlencoded` body、`words_result` 行数组 —— 以前这种协议得写适配器，现在就是一段模板（`builtin-baidu-ocr`）。`extractContent` 的自动探测加了 `words_result`。模板的 form 体带 `language_type=auto_detect`：**这个参数不写就是 `CHN_ENG`（中英混合），日文的假名会被当成中文读**（kniph 实测报过），百度没有 OpenAI 那种「天然自动识别」。有它就能钉死一种语言（`JAP` / `KOR` / `DUT` …）。
- **剪切板只能在 offscreen 文档里读**：content script 读不到（拿不到焦点、没有权限），所以临时开一个 `offscreen.html`，读完就关（省内存），不是常驻。
- **不猜 `blob.type`**：Windows 截图工具丢出来的那一项类型可能是**空串**，直接用会拼出 `data:;base64,…`，接口那边直接拒。所以按**文件头**认 MIME（PNG / JPEG / GIF / BMP / WEBP 魔数）。
- **大图的 base64 要分块转**：几十万字节一次性 `String.fromCharCode.apply` 会把调用栈撑爆。
- **OCR 栏和配置栏共用同一套 UI 骨架**（kniph 2026-10-14 要求「把配置栏的推进覆盖到 OCR 栏」）：请求模板也是 `details.preview.tpl-fold`（同骨架、同一条 CSS、同一种折叠手势，占位符标签排放在 `.fold-body` 里当第一个孩子），**OCR 供应商也是「主请求 + 后备」**（`#btn-ocr-add-fallback` + `normalizeOcrItem`，链模型和配置栏共用 `lib/requests.js`，`runOcr` 按顺序试、成了就报 `from` = 「后备 N」），测试结果走配置栏那个 `resultBlockHtml`（没认出文字就折起来、块头带「为什么挂」）。
  - ⚠️ **直传模式（`#ocr-editor.is-imgcfg`）的隐藏清单要单独加 `#ocr-blocks` / `#btn-ocr-add-fallback`** —— 那套隐藏是按 `#editor` 的**直接子元素逐个点**的，把 `.field` 换成一组请求块之后它就不在清单里了，症状是「模式变了但旧东西还在」（这个坑 2026-10-09 就记过一次）。
  - ⚠️ **判「`<details>` 收起来了」不能用 `offsetParent`**：这个 Edge 上收起的 `<details>` 的 `offsetParent` 仍然不是 `null`（内容是用 `content-visibility` 那套隐的），e2e 里要量**几何**（框高缩到只剩标题栏那行）。
- **框选截图 = 直接对着页面框，位图只在松手那一刻才拿来裁** —— 覆盖层**不铺底图**（早期版本铺过，见下），只有一层压暗的挖洞（`.sel` 那条 `box-shadow: 0 0 0 100000px rgba(0,0,0,.45)`）+ 提示条。页面就在下面、原样可见，用户看到的是「直接对着页面框」，不是「先截一张再框」。好处是**框选期间还能滚页面 / 翻页**（裁到的永远是**松手时那一屏**的对应区域），代价是动态内容（视频 / 轮播）拖框期间会变 —— 和系统截屏工具一致（kniph 明确接受）。
  - **「压暗」和「接指针」必须是两层**（`content.js` 里那层 `.veil`）：挖洞那层要求 `pointer-events: none`（不然它挡住页面，就滚不动了），而 `box-shadow` **根本不参与命中测试** —— 只铺挖洞层的话，**真人按住鼠标框选不了**（kniph 报过「点半天没反应」；脚本**直接派发事件**能过，所以 e2e 全绿也照样是这个 bug）。所以另起一层 `.veil`（`position:fixed; inset:0`、透明背景、`cursor:crosshair`）专门接指针。
  - **事件挂在 `hostEl` 上，不挂 shadow root**：shadow root **不是事件目标**，绑在上面只有当事件从内部某个**可命中元素**冒泡上来才触发。`hostEl` 是真实可命中的元素，起点在遮罩内、终点拖到遮罩外的场景也不丢事件；配合 `hostEl.setPointerCapture(e.pointerId)` 保证拖出窗口也能收到 `pointerup`。
  - **测这类 bug 必须用真鼠标**：`shotDrag` 那套 `dispatchEvent` 绕过命中测试，测不出「吃不到鼠标」。e2e 里加了两条：`document.elementFromPoint(x, y)` 必须指回遮罩；以及 Playwright **真鼠标** `mouse.down/move/up` 拖一遍，断言遮罩收掉且真发了请求。
  - **为什么非「先整屏再裁」不可**：`chrome.tabs.captureVisibleTab` **没有区域参数**，只能抓整块可见区域。`getDisplayMedia` / `chrome.tabCapture` 要弹窗授权且拿到的是视频流；DOM 重画会丢图片 / canvas / 跨域 iframe。系统 `Win+Shift+S` 同理。
  - **坐标系那件事（位图含滚动条、拖框坐标不含）**：`captureVisibleTab` 的位图 = `innerWidth × innerHeight × dpr`（**含页面自己那条滚动条**），而拖框坐标是在**内容区**坐标系里量的（`documentElement.clientWidth`，不含滚动条）。差的就是那一条（实机 `innerW 1178 / clientW 1163` → 位图 `1767×1214`）。这一刀**只在 `cropShot()` 里落一次**：先按 `cutX/cutY = Math.round((inner − client) × dpr)` 把右边 / 下边那一条切掉，比例再按「位图 − 那一条」算（`kx = srcW / viewW`、`ky = srcH / viewH`，夹在位图内）。**没有滚动条时 `cutX / cutY` 都是 0** —— 等于没动（`test-lib` 第 23 节钉着这条不变量）。
  - **`cropShot()` 是异步的（返回 Promise）**：松手后**先把覆盖层拆掉**再裁图，这样「把图喂给 OCR」那段时间用户可以继续翻页面。`new Image()` 加载失败 / canvas 跨域报错都 `resolve(null)`，上层转成 `ocr-error`，不炸。
  - **旧设计（已删，别捡回来）**：早期是「先整屏截图 → 覆盖层铺一张底图 → 用户对着底图裁」。病灶有两个：① 底图用 `width:100%; height:100%` 拉伸铺满内容区 → 含滚动条的位图被压扁（横向约 1.3%）、滚动条被拖着显示，**看着就像「框里进来一条」**；② 按位图坐标算源矩形 → 整块偏移 → `drawImage` 一缩一放 → **整个画面偏移一下**（kniph 报的）。当时的补丁是「在覆盖层底图上先切掉那一条」，A 方案直接把底图整个拿掉，这两个病灶连根没了。
  - **测它必须在有头窗口里造一条真滚动条**（`documentElement.style.overflowY = 'scroll'`，经典滚动条占布局）：content script 跑在**隔离世界**里，页面改 `window.innerWidth` 它根本看不见，伪不出「位图比内容区宽一条」。断言只有一条硬的：**框满整屏时裁出来的宽 = 内容区宽**，以及两档（无滚动条 / 有滚动条）的宽度差 = 滚动条宽。尺寸都从**假 OCR 接口收到的请求体**里解 PNG 头读 —— content script 的 `canvas.toDataURL` 钩不到。
- **「机制坏了」和「里面没图」分开报**：读不到剪切板（浏览器没放开权限）不会冒充「剪切板里没有图片」。
- **图片直传时「翻图用哪条配置」是独立选中的**：勾了「禁用外置 OCR」后，设置页 OCR 栏左栏整栏换成「图片配置」，那是 `state.configs` 的**过滤视图**（判据只有一个：`canTranslateImage` —— 图片请求模板非空），选中项存在 `state.ocr.imageConfigId`，跟顶栏那条 `activeConfigId` 互不影响。**不是另一份配置数据** —— 增删改只在「配置」栏（`＋ 新建配置` 在直传模式下收起）。这样翻图前不用先回顶栏把配置切成支持视觉的那条，也不会把图误发给纯文字接口。选错了不会炸：`background.js` 走 `pickRequestConfig()`，`imageConfigId` 指向的那条 `imageRequest` 若是空的（或那 id 已不存在），自动回退到顶栏那条。左栏切换由 `renderOcrDisabled()` 一处收口（`#ocr-editor.is-imgcfg` 那几条 CSS 负责把右边供应商字段压掉，只留一句说明）。
- **同一份列表在面板顶栏也有一个入口**：图片那一屏顶栏的下拉列的就是这批配置（`ready` 消息里每条带 `img` 标志），选中的也是 `state.ocr.imageConfigId` —— 在那拨一下等于回设置页改选中项，所以拨完要写回存档（见上面「顶栏那个配置下拉有两种模式」）。判据收在 `lib/store.js` 的 `canTranslateImage` 一处，`content.js` 里那份 `imageCapable()` 是镜像（content script 不能 import，`test-lib` 有同形断言钉着）。
- **OCR 栏那块「测试」和「请求预览」在直传模式下会换对象**：不测这条 OCR 供应商，改测左栏选中的那条**图片配置的「图片请求模板」**（`runImageTranslate`，和 `runOcr` 共用 `buildOcrRequest` 那套图片占位符装配，差别只在措辞按「译文」）。理由：勾上之后这条路原本没有任何地方能试 —— 只能右键截一张图才知道配没配对。实现上是**同一块 UI**（`#o-test-field` / `.preview` 在 `.is-imgcfg` 下不藏，其余 `.field` 照旧隐藏），只是换标签 / 换提示 / 换数据源；CSS 里那条 `> .field:not(#o-test-field)` 就是为了放它过去。**换对象的三处都得跟着刷**：勾开关、切回 OCR 页签、点左栏另一条（后两处顺手把上次的测试结果收起来 —— 那已经不是这条的了）。
  - 「用不上的字段压暗」那条 `.is-off` 规则**已经删掉**：它和 `.is-imgcfg` 是同一个开关 toggle 的，而供应商字段早被整栏 `display: none` 了，压暗只剩「测试」和请求预览两块挨着 —— 那两块这时**还在用**，看着像被禁用、点了没反应。`e2e-ui` 用 `getComputedStyle().opacity` 钉着「两种模式下都是 1」。
- **`↻` 重发的是「刚才那张图」**：截图那一步就失败（含直传）时 `currentText` 还是空串，重试入口是 `content.js` 的 `retryShot()`。直传那张图 content 自己存着（`lastOcr.image`，见 `translate`），本地重发；OCR 那两条路（剪切板 / 框选）图从来没进过页面，发 `{type:'ocr', reuse:true}` 让后台接着用**上一次真正用过的那张**（`background.js` 里端口作用域的那个 `lastShot`），而不是再读一遍剪切板。旧实现发的是不带图的 `{type:'ocr'}`，后台只能去读剪切板 —— 用户在那之后复制了别的东西，重试就发了一张毫不相干的图（kniph 报的）。只有真拿到图才写 `lastShot`（失败那几次不算）；MV3 的 SW 被回收 / 端口重建后它会空，那时退回读剪切板。两条路都由 `test-lib` 第 27 节 + `e2e-ui` 第 10 节（**重试前把剪切板换成另一张**再断言发出去的还是原来那张）钉着。
- **直传那一屏的原文区贴的就是那张截图本身**（`renderSrcImage`）：原文就是图，贴文字没意义。OCR 中转那条路原文是认出来的文字，照旧贴文字 —— 所以 `renderSrcImage` **只有一个调用点**（`test-lib` 钉着）。页面 CSP 可能挡住 `data:` 图：`img` 的 `error` 一到就撤掉图、只留那句「没有先做外置 OCR」（说明不能丢，它是「这段原文为什么是张图」的唯一交代）。图有 11em 高度上限，`.rt-src.has-img` 把容器那条 6em 上限抬到 14em —— 不然图和那句话挤不进去。

---

## 存储与迁移（`lib/store.js`）

- 占位符转义看「落在几层引号里」，从内到外逐层转（`quoteStackAt` / `escapeInContext`），**不是**看「两侧紧挨着什么字符」。配套：`tokenize` 在 normal 状态认 `\'`。**改这块必跑 test-lib 第 21 节 + e2e 的「OCR 文本带撇号」。**
- **`{{targetCode}}` 可以按配置改写法**（各家接口代码不一样：DeepL 要 `ZH-HANS`、Google 要 `zh-CN`、百度要 `zh`）：请求文本里写一块 `#@lang` —— `#@lang` 单独一行，下面紧跟若干 `# 键 = 值` 行，**遇到空行就结束**；键写语言名或代码都认、不分大小写；命中不了的回落到内置表 `TARGET_LANG_CODES`，所以**不用抄全**（DeepL 那条预设只示范了 4 行）。
  - **整块必须在 `renderTemplate` 里被吃掉、不进输出** —— 原始 HTTP 报文风格把「空行之后的全部」当 body（`request-parser.js` 的 `parseRawHttp`），尾巴上的声明块不剥就会被**吞进请求体**（只有 JSON 解析失败时才靠 `repairJsonBody` 剥 `#` 行抢救，不能依赖）。剥掉之后位置就自由了，所以放末尾当附录是安全的。渲染时剥还有个副作用是好的：设置页预览里看到的就是真发出去的那份。
  - **`TARGET_LANG_CODES` 删不掉**，它的身份是「**Bing 适配器专用 + 兜底**」：Bing 配置的 `request` 是空串、`runRequest` 里有 adapter 就忽略 `requestText`（`engine.js`），适配器只拿到 `vars`（只有语言名）—— 那条路上**根本没有请求文本可以写 `#@lang`**。另外「没写表的配置」也靠它兜底，否则 `{{targetCode}}` 会变空串（`missing` 只在「key 不在表里」时记，塞个空串进去就是静默失败）。README「配置怎么写」里有完整表可抄。
- 一条配置带两段模板：`config.request` 翻文字、`config.imageRequest` 翻图。挑哪段只认 `requestTemplateFor(item, context)`，别在别处再判一次。`{{imagePart}}` 是「一段模板两用」的备选，必须裸写、只能放最后。**参数是「请求条目」不是 config** —— 主请求和后备同形（见下面那条）。
- 挑**哪条配置**只认 `pickRequestConfig(state, configId, hasImage)`（紧跟 `requestTemplateFor` 之后）：文字走传进来的 / 存档里 `activeConfigId` 那条；图片在勾了「禁用外置 OCR」时优先看 `state.ocr.imageConfigId`，**那条能翻图（`canTranslateImage`）才改道**，否则回退。`background.js` 就这一个入口（它 import 里已经没有 `getConfig` 了）。单测在 `test-lib` 第 15d 节。
- **后备请求**（一个配置里挂几条请求，主请求挂了按顺序往下试）：主请求那几个字段仍躺在配置**顶层**（`adapter` / `request` / `imageRequest` / `path` / `responseMode`），后备躺在 `config.fallbacks[]`，每条都是**完整的一条请求**（自己的 `id` / `enabled` + 同名字段，**没有 `name`**），另加 `config.mainEnabled`（默认 true）。**老存档没这两个字段 = 行为一个字节都不变。**
  - 三个出口在 `lib/store.js`：`mainRequest(config)` 把顶层字段包成和后备**同形**的条目（`main: true`）、`allRequests(config)` 返回「主 + 全部后备（不管勾没勾）」（设置页按它画块）、`requestChain(config)` 只返回**勾上的**；**一条都没勾时退回主请求** —— 一条配置存在却什么都不发是个没人看得懂的死状态。
  - **后备没有名字这个字段**：它叫什么由**它在链里的位置**决定，`allRequests` 里现算 `name: \`后备 ${i + 1}\``（所以调序后名字跟着变）。让用户改名就得处理重名 / 空名，而这个名字只出现在状态行和块头上，改它没有任何价值（kniph 2026-10-13 定的）。
  - **`enabled !== false` 而不是 `!!enabled`**：缺字段 = 勾上。`normalizeRequestItem` / `allRequests` / `content.js` 的镜像 `imageCapable` 三处必须同口径（这个语义漂移被「把函数抠出来真跑对答案」的同形测试抓到过，源码字面量比对测不出来）。
  - 两层循环：外层 `requestChain`、内层「管模型的变量填多行就换一个」（`modelVarFor` + `splitVarValues`）。**成功判据仍然只有 `if (result && result.text) break;` 一处** —— 内层 break 之后再判一次并 break 外层。两层都只跑一轮 = 老行为。
  - 状态行：主请求只报 model（老样子），切到后备才带上名字（那个名字就是 `allRequests` 现算的 `后备 N`）—— `bits = [item.main ? '' : item.name, model].filter(Boolean).join(' · ')`，拼不出就是空串。
  - `canTranslateImage(config)` = **轮换链里随便哪一条**的 `imageRequest` 非空。三处同口径：设置页「图片配置」列表、面板顶栏图片模式那个下拉、`pickRequestConfig` 的入围条件（`content.js` 里是同一句的镜像）。
  - 设置页把模板收进 `#req-blocks`，`blockHtml()` 一套模板渲染主请求与后备（请求模板 → 图片模板 → 响应格式 → 提取路径，见下）；折叠状态 `blockFold`（`Map`）**只在内存、不进存档**，**没记过的一律收起（主请求也一样）** —— 一进来就是一列整齐的标题，页面短得多；启用勾是 `.rb-enable`，后备还有 ↑↓× 。
  - 「图片配置」那条线一律走链：判据用 `canTranslateImage`，取模板用 `options.js` 的 `imageItem(c)`（链里**第一条**填了图片模板的条目，可能是某条后备），`runImageTranslate` 收的也是那个条目（读 `imageRequest` / `path`）。**别再读 `c.responsePath`** —— 配置上没这个字段（提取路径在顶层就叫 `path`，`responsePath` 是 OCR 供应商那边的另一个字段），原来那处一直是 `undefined`。
  - 真机轮换由 `e2e-ui` 的 ②.7 节反证：主请求指 `/chainfail`（必 500），勾上的后备真发、没勾的一次都不发、顺序是先主再后备；全不勾时退回主请求。`test-lib` 第 15e / 15f 节钉数据形状与设置页那条线的接线。**设置页块头的几何（不溢出 / ▾ × 真鼠标点得到 / 收得起删得掉）由 `e2e-ui` 第 7 节（配置列表那节）末尾那组真机断言钉着** —— 那儿量的是 `scrollWidth - offsetWidth` 和 `elementFromPoint`，不是「处理器有没有绑」（绑着但点不到正是 kniph 报的那两个 bug 的形态）。
  - **两段模板（文字 / 图片）只有一处渲染**：`options.js` 的 `templateFieldHtml()`，骨架是 `details.preview.tpl-fold > summary + .fold-body > textarea + .hint`。原来是两条完全不同的写法（`.field` + `<label>` + 裸 textarea / `details` + `.fold-body`），字号、hint 间距、文本框最小高度（300 vs 150）全各写一份 —— kniph 2026-10-14 报的「完全是两套布局结构，明明可以复用一套代码」。参数只有四个：类名属性串、标题、默认摊不摊开、给适配器条目 `hidden`。**类名以整段属性串传入**（`'class="preview tpl-fold rb-only-request"'`）而**不是**插值：`check-dom` 从 `class="…"` 字面量收类名，插值那段它认不出（同一坑见 `renderBlocks`）。
  - **折叠手势全站统一成「点那一条的标题栏」**：请求块点 `.rb-head`（角上那枚 ▾ 降级成**指示器**，点它靠冒泡走同一条路，不再有自己的 toggle 分支）；模板那段、预览块、测试结果块都是 `<details>` 原生行为。kniph 2026-10-14 报的「有的地方点顶部、有的地方点角落」。块头里的控件要放过：`.rb-on`（勾选框）和 `.rb-mini`（↑↓×）不折叠 —— 判据是 `!e.target.closest('.rb-on, .rb-mini')`。
  - 往模板框里插标签（`insertAtCursor`）前**要把模板那层折块摊开**：收起的 `<details>` 里 `selectionStart` 恒为 0、`focus()` 是空操作，字会插到最前头而且看不见（和「收起时点标签」那条是同一个坑，只是多了一层折叠）。
- **配置级新字段**走 `normalizeConfig` 补默认，**不用迁移**；全新存档走 `freshConfigs()`。
- **新增一条内置配置**才要 `STORAGE_VERSION +1` + 迁移（v3→v4 补 `builtin-deepl`，插在内置 DeepSeek 后面，找不到锚点就 append，用户自己排的顺序一概不动）。
- **改「已有内置项」的默认值**要迁移的前提是「字段还单独存在」。v7 起 OCR 供应商整体模板化，老字段转换收在 `normalizeOcrProvider` 单一真相源里，v4→v5 那套「逐字比对老默认值再归位」的字段手术已随之删除 —— 老用户的 PaddleOCR 原样转成模板，不再强制换模型。
- **v7→v8 是模板化之后第一次改内置供应商的默认模板**（硅基流动补 `<image>\n` 提示词前缀、百度补 `language_type=auto_detect`），判据还是「逐字还等于老默认值」：`lib/store.js` 里那两段老模板是**冻死的字面量**（不能从 `OCR_PROVIDERS` 反推，那个早改过了）。**这里不能像 `configs` 那样把字段 `delete` 掉** —— `request` 一没，`normalizeOcrState` 会把它当成「老形状」走 `ocrProviderToTemplate`，拿空 endpoint 重新拼一段废模板出来；要显式写上新默认值。用户自己钉了 `language_type=JAP` 的那种，一个字节都不能动。
- 新增设置项 `{...默认, ...stored}` 合并即可，不用迁移；但**改已有字段的默认值**要迁移。**改已有字段的「类型 / 形状」**（例：`ocrHintHidden` boolean → `hiddenHints` 数组）也**不是**迁移，而是在 `loadState` / `importState` 里读一次映射（见 `store.js` 的 `normalizeHiddenHints`）—— 老键要 `delete` 掉，别留在存档里当残渣。
- **导出 / 导入**：`kind` / `version` / `exportedAt` 三个元字段必须写在 `...state` **之后** —— 顺序反了导进来的旧 `exportedAt` 会顶掉这次新写的（`version` 是**文件格式**版本，不是 `STORAGE_VERSION`）。`importState` 返回的 `exportedAt` 在 `options.js` 里用解构单独拎出来，别 spread 进 state。
- **API Key 会在三个地方露脸**：变量栏的值（**名字里含 key 的才默认打码**，点眼睛才看）、配置 / OCR 的请求预览与「测试」结果（`lib/engine.js` 的 `maskRequest`）、以及**请求模板原文本身**（那是一整段可编辑文本，写死在里面的 key 没法打码，只能提醒用户）。变量栏打码走 `-webkit-text-security: disc`，**不用 `<input type="password">`** —— 后者会招来密码管理器的保存提示，还有 Edge 自带那个原生眼睛（跟我们这个按钮重复）。注意这是**防肩窥**不是加密：值仍是明文存的，导出文件里也照样有。
- **变量栏每条变量占两行：名字一行、值一行**（`renderVars` 里的 `.var-row` > 两条 `.var-line` + `.var-k` 小标签，kniph 2026-10-14：「自定义变量一排下来实在太局促了」）。原来是一张表（名字 | 值 | 眼睛 ✕）：表格自动布局把名字列压到一百来像素（`SILICONFLOW_CN_API_KEY` 这种 21 字的名字当场截掉），值也只剩四百来像素 —— 而值才是唯一会长的那栏（多行的 model 列表 / 长 key / 提示词）。改完之后名字框定宽 `260px`（放得下长名字）、值独占整行（实机 602px），眼睛贴着它管的那一栏、`✕` 收在块尾。**内置变量那张只读表不动**（`.vars.builtin`，名字列 170px）。
  - 值还是 `textarea` + JS 按 `scrollHeight` 撑高（`growTextarea` / `growVarValues` 只认 `#vars-body` 里的 `[data-kind="value"]`，跟行是 `tr` 还是 `div` 无关）。
- **打码跟着变量走，不跟着字段名走**（kniph 2026-10-13 定的）：判据是变量名里含 `key`（不区分大小写，`isSecretVar`），命中的那些值的**每一处出现**都换掉 —— 地址查询串（`?key=…`）、任意请求头、请求体，一次全覆盖。老实现只认 `Authorization` 头，URL 里的 key 一直明文摆着（他贴过来的 `...streamGenerateContent?alt=sse&key=AQ.Ab8RN6..` 就是这么漏的）。三处细节：
  - **值替换 + 头部兜底两步走**：先按变量扫值，再对 `Authorization` 兜一次（key 写死没走变量的那种）。第二步前会看有没有 `…（已隐藏）` 记号，**打完的不能再打** —— 否则叠成两层后缀。
  - **太短的值不替换**（< 4 字符）：一个 2 字符的「密钥」会把预览里所有同名片段都涂掉，反而看不清。
  - **空值什么都不换**：`{{apiKey}}` 没填时地址原样；`Authorization: Bearer ` 打成 `Bearer （还没填）` —— 前缀统一重排成一个空格（解析出来的头值已经被 trim，照原样拼会少掉那个空格）。
  - `maskRequest(req, vars)` 返回**新对象**，不改传进来的那份：真发出去的是 `parseRequest` 的结果，两边绝不能是同一个引用。
- **管模型的变量填多行 = 换 model 重试**（一行一个值）。值按**行**拆成候选（`splitVarValues`，一行一个、丢空行、trim 首尾但保留中间空格 —— model id 里可能有 `/` 和空格）。只有一行 = 普通单值，**没有任何新行为**，老存档零迁移；找不到那个变量时调用方完全不启用循环。
  - **「哪个变量管模型」= 这条请求的模板里用到的占位符里，名字含 `model` 的那个**（不区分大小写 —— `model` / `MODEL` / `Model` / `GEMINI_MODEL` / `model_name` 都算，`lib/template.js` 的 `modelVarFor(template, vars)`）。原来只认**死名字** `model`，于是 `{{GEMINI_MODEL}}` 这种写法整段多行值被原样塞进地址、用户还很纳闷「模型轮换怎么没用」（kniph 报的）。
    - **看模板而不是扫变量表**：变量是**全局的**（所有配置共用一张表），一个人完全可以同时存着 `GEMINI_MODEL` 和 `DEEPSEEK_MODEL`，扫表挑不出该轮换哪一个；看模板就永远挑得准。模板里有多个含 model 的占位符时取**第一个**；引用了但变量表里没有 → **不算**（占位符写错了不该凭空开一轮重试）。
  - ⚠️ **覆盖时要用命中的那个键名**：`background.js` 里是 `{ ...vars, [mkey]: model }`，**不是** `{ ...vars, model }` —— 写死覆盖 `model` 的话，模板里的 `{{GEMINI_MODEL}}` 根本没被换掉，表面看就是「轮换没生效」（这个 bug 和上面那条是同一个用户报的）。所以候选也在**链循环里**算（每条后备的模板可能不一样），不再提到循环外。
  - **每个渲染边界都要过 `firstModelVars(template, vars)`**（engine 的 `runRequest` / `previewRequest`、ocr 的 `buildOcrRequest`）：一次请求只用一个 model。漏了这一下，整段多行值会被**原样塞进模板**，地址里出现四个 model 串成一串、请求根本发不出去。收敛放渲染边界而不是设置页，是因为设置页只是众多入口之一（OCR 那条路以前就漏了）。
  - **回退循环在 `background.js` 的 translate 分支，绝不进 `lib/engine.js` 的 `runRequest`**：`runRequest` 是「一次调用 = 一次请求」，返回值面板 / 诊断 / 设置页测试四处共用，改成内部循环会把流式 `onDelta` 和 `result.model` / `ttfbMs` 的语义全搅乱。后台每个候选各调一次 `runRequest`、传进去的本来就是单值，过 `firstModelVars` 等于没变。
  - **成功判据只有一处**：`if (result && result.text) break;`。HTTP 错误 / 空结果 / 解析失败都让 `text` 为空，自然落进「继续试」。
  - **「已取消」（abort）必须立刻退出循环**：它来自「后台收到新的 translate 时中止上一次」（切配置 / 重新触发），不是用户按停（**这个插件根本没有停止按钮**）。若把它当失败继续试下一个 model，结果是白白多发几次请求（返回值还会被 `if (mySeq !== seq)` 丢掉）。
  - 状态行：每次开始试一个 model 都把 `statusText`（形如 `（Qwen3-32B）`）随 `start` 带给面板；**拼不出 model 名就是空串**，状态退回老样子「请求中…」。面板不判断「第几个」。
  - 设置页「发送」测试 = **把这条链按顺序跑一遍，和面板同一套规矩**：按 `requestChain(cfg)` 逐条发，每条请求自己再逐个试 model（谁管模型看模板，见上），拿到译文就停。原来**只发第一个** model —— 第一个恰好挂了就报一片红，用户会得出「这条配置坏了」（而面板会轮换、明明是好的），kniph 2026-10-14 报的。
    - 实现上先 `chain.map()` 排出 `plan[i] = { item, requestText, mkey, attempts }`，**在循环外一次算好** —— 徽章里的「一共几次」和实际发出去的次数必须是同一份数。
    - 徽章**不写「按顺序试 N 条」**（会被读成「N 条都会发」，kniph 报过这个歧义）。**不轮换时**（`total === chain.length`）文案一字不改：「链上共 N 条请求」+「第 i 条拿到译文，后面 N 条没跑」/「N 条都没拿到译文」。**轮换时**单位换成**次发送**（一条请求要发好几回，混着数会读错）：「model 逐个试，最多发 N 次」+「第 i 条第 j 个 model 拿到译文，还有 N 次没发」。
    - 轮换时每个结果块头上挂一枚 model 徽章（`testItemHtml` 的 `opts.model`）—— 好几块长得一样，不标出来分不清哪块是哪个。
    - **没拿到译文的块默认折起来**（`<details class="test-fold">`，判据 `!r.text`）：一次测试可能挂好几个 model，全摊开就是好几屏「错误 + 完整请求体 + 原始响应」（kniph 报的「测试完直接冒出来这么多」）。拿到译文的那块保持摊开 —— 那才是要看的。块头一行用 `shortError()` 交代「为什么挂」：错误正文多半是 `HTTP 503 —— {json}`，直接截前 N 字只会看到 `{`，所以先当 JSON 读、取 `error.message`，读不出来才压平空白截断。
    - 配置预览一次只摊一个 model（一次请求就是一个 model），备注里补一句「`model` 变量填了 N 个候选，上面摊的是第一个」—— 否则看到地址里只有第一个会以为扩展不认后面几行。

---

## 设置页右栏：一列「请求块」

配置栏右栏是 `#req-blocks` 容器 + **一套模板**渲出来的若干块：第一块是主请求（内容就是配置顶层那些字段），后面是各条后备请求。`blockHtml(item, idx, lastIdx)` 画一条块（**字段顺序：两段模板挨着、两个「响应」字段挨着收尾**——响应那两项管的是整条请求回来的东西、两段模板共用，夹在模板中间会被读成「只管上面那一段」，kniph 2026-10-14 报的），`renderBlocks(cfg)` 按 `allRequests(cfg)` 整批画，`readBlock()` / `collectEditor()` 按 DOM 顺序写回（第一块 → 配置顶层，其余 → 各自那条后备）。**主请求和后备同形**，所以模板只一套、两段模板的规矩也一样。

- **块里没有「类型」下拉了**（`选项：自定义请求 / 内置适配器` 那个，kniph 2026-10-13 删的）：内置适配器只有 `bing` 一个、而且只有内置预设 `builtin-bing` 会用上它，用户自己加/改的配置全是自定义请求 —— 一个「只有一个非默认值的二选一」不值一行控件。现在**类型从数据上看**：`.`req-block` 上的 `data-adapter` 有值就是内置通道（`blockHtml` 里 `isAdapter`），空的（或没这属性）就是请求模板。`data-adapter` 同时是 `readBlock()` 取 `adapter` 的**唯一来源**。内置通道那条不再给下拉，只摊一行只读的 `.rb-adapter-note` + hint；`syncBlockMode()` 与 change 里的 `rb-kind` / `rb-adapter` 分支一并删掉。**要加第二个适配器时，得先把这套「选类型」的控件请回来。**
- **折叠状态 `blockFold`（`Map`）只在内存、不进存档**：`foldOpen(id)` 就是 `blockFold.get(id) === true` —— **没记过的一律收起，主请求也一样**（kniph 2026-10-13；原来主请求默认展开，页面一进来就很长）。收起时块体是 `display: none`，所以**跟块里字段打交道前要先摊开**：`＋ 加一条后备请求` 会 `blockFold.set(新 id, true)`，点上面那排标签也会把目标块摊开（否则 `selectionStart` 恒为 0、`focus()` 是空操作，字会插到最前头还看不见）。
- **块头那个「主请求 / 后备 N」是只读的 `<span class="rb-tag">`，不许再变回 `<input>`**。原来那儿是一条 `<input type="text" class="rb-name">` 让用户改名，被本文件那条全局 `input[type="text"] { width: 100% }`（选择器权重 0,1,1 > 单类 0,1,0）撑满整行，把右边的 ↑↓×▾ 顶出块外、再被 `.req-block` 的 `overflow: hidden` 裁掉 —— 实机量到块头宽 1527px 而容器只有 1370px，`elementFromPoint` 在按钮坐标上返回的是 `#editor`，于是「收不起、删不掉」。名字改成按位置现算（`allRequests` 里 `后备 ${i + 1}`）之后那个输入框连根没了。`test-lib` 第 15f 节钉着「js 与 css 里都不许出现 `.rb-name`」。
- **⚠️ 事件必须全部委托到 `els.blocks`**（块是动态画的，别在每个块上各挂一遍），连带两个坑：
  - `insertAtCursor()` 里那个 `dispatchEvent(new Event('input'))` **必须带 `{ bubbles: true }`**。委托之后不冒泡的合成事件到不了容器上 —— 症状是「点标签插进去后框里的字变了、存档和预览都没跟」（`e2e-ui` 抓到的就是 `grew=8` 但 `imageRequest` 还是老值）。
  - `check-dom.mjs` 是**从 `class="…"` 字面量里收类名**的，模板字符串里插值的 class 会漏收。所以「折叠 / 勾掉压暗」这两个状态**不写进模板**，改成在 `renderBlocks` 里 `classList.toggle('open' / 'rb-off', …)` 贴上去，模板里保持 `class="req-block"` 字面量。
- **那排占位符标签长在每一段模板里面**（`.fold-body` 的第一个孩子，kniph 2026-10-14：「变量是在请求模板内的…你就不能都统一到里面吗」）：两段模板（请求 / 图片请求）各有一排，OCR 栏那块也有自己的一排（`CHIPS` 8 个 / `OCR_CHIPS` 4 个）。`bindChips(container)` 插进**当前光标所在的那个框**（`focusedTemplate`，只认同一个 `container` 里的），没点过任何框就落到主请求那段模板；两栏各调一次，别串台。
- 「测试」按 `requestChain(cfg)` **顺序逐条跑**、拿到译文就停；结果头的徽章是「链上共 N 条请求」+「第 i 条拿到译文，后面 N 条没跑」（**别写成「按顺序试 N 条」**，那会被读成「要发 N 条」）。请求预览把**全部块**摊出来（每条都带自己的 vars）。

---

## 两栏右栏的头部：一份函数画两个（+ 固定占位的说明槽）

**右栏头部 = 一句说明 → 名称 → 一句说明**，由 `options.js` 的 `editorHeadHtml()` **一处渲染**，
两栏各调一次（容器是 HTML 里的 `#cfg-head` / `#ocr-head`）。kniph 2026-10-14 报的「强迫症」：
原来两栏各写一份，于是补丁也各打各的（配置栏靠多加一句话、OCR 栏靠给备注 `min-height`），
「顾头不顾尾」，请求块差 76px（140 vs 216），切页签整块上下跳。

- **改一处两边一起变**，想让它们不齐都做不到。e2e 里钉着：把 id 和文案抹掉之后，
  两栏头部的 `innerHTML` 必须**逐字相同**（`#cfg-head` vs `#ocr-head`）。
- 每一段说明待在一个**固定占位的槽**里（`.hint-slot { min-height: 39px }`，槽内 `.hint` 去掉
  下外边距）。为什么非得是槽：说明**能被用户收掉**（`.hint-off` = `display: none`）、备注
  **时有时无**（自建那条为空）—— 靠文字的自然高度凑，一点「不再显示」行数就不对称了。
- 上面那槽可以放**互斥**的几句（OCR 栏是 `#o-hint` / `#imgcfg-hint` 二选一），同一槽 ⇒ 换哪句都不动位置。
- ⚠️ 头部那几个输入框（`#f-name` / `#o-name` / `#o-note` / `#imgcfg-hint`）是**画完才取的**
  （`els.cfgHead.querySelector('#f-name')`）。**别在别处按 id 直接取** —— `check-dom.mjs` 认的是
  「HTML 里写死的 id」，脚本拼出来的它认不到（class 那边倒是认），会报「HTML 里没有这个 id」。
- **已知边界**：槽只是下限（不是定死高度）。窗口窄到让说明换行、或者备注本身超过一行时，
  仍会差一行（~21px）。要彻底消掉只能把头部区定死高度 + 裁字，不值得。

## 设置页左栏：条目必须 `width: 100%`

「配置」栏每条都包在 `.cfg-row`（`display: flex`）里，`.cfg-item` 的 `flex: 1` 把宽度拉平了；左栏（OCR 供应商）那几条是**直接躺在 `.list-body`（`display: block`）里**的 —— 这时 `flex: 1` 是死的，而 `.cfg-item` 的 `width: auto` 对 **`<button>`** 来说等于「**收缩到内容宽度**」（按钮不像普通块级盒那样撑满，走的是 fit-content 那套）。于是名字长的条宽、名字短的条窄，一列参差不齐 —— 实机量过：同一次渲染里四条分别是 `84 / 206 / 310 px`（310 那条还溢出了列表）。修法是补一条 `.list-body > .cfg-item { width: 100% }`（只作用于「直接躺在列表里」的那种，配置栏不受影响）。

左栏有两种长相，判据得同时容得下：OCR 供应商是 `.list-body > .cfg-item`（靠上面那条 `width: 100%`），「图片配置」是 `.list-body > .cfg-row > .cfg-item`（行本身铺满，条目靠 `flex: 1`）。`e2e-ui` 因此量的是「条目 + 同一行里除它以外的那些」= 行宽，判据是**每行都占满列表可用宽度**（不是「彼此相等」）—— 这样**只有一条时也能测**（有 bug 时它会缩成窄条）。

---

## 三处左栏共用一套行（连排序都统一：三处都能拖）

「配置」栏 / OCR 供应商 / 「图片配置」三处左栏长得一样、操作也一样，所以 `options.js` 只有一套实现：`sortableRow()`（手柄 + 条目 + ↑↓）、`moveButton()`、`dropSpot()`、`bindSortDrag()`。`listEl` / `onMove` 都是参数 —— 加列表时照着传就行，别复制一份出来改。

- **三处一律都能排**（kniph 2026-10-14：「连排序的用处也统一」）。原来供应商那栏是「顺序没意义 → `canSort: false` + `.cfg-slot` 同宽空位对齐」的特例；留着它等于**同一套逻辑里还藏着一个分支**，所以整块删了（e2e 现在**真点 ↓、真拖**，只验「有按钮」不算）。`.cfg-mv` 固定 `width: 39px` 就是为了三处行宽一致，不然切模式时列表会「跳一下」。
  - ⚠️ **统一之后 CSS 里不许再按 id 给某一处开特例**。原来那两条补丁（OCR 列表还没有 `.cfg-row` 时的宽度 / 间距）统一之后一条是死的、另一条给条目加了 `margin-bottom: 3px` —— 行高因此比另外两处高 3px（63 vs 60），肉眼就是「三个列表不一样高」。e2e 现在**连行高一起量**，test-lib 静态盯 `#ocr-list .cfg-item` / `.list-body > .cfg-item` 不许再出现。
  - ⚠️ 行的 `data-id` 挂在 **`.cfg-row`** 上、不在 `.cfg-item` 上（三处一致）。谁要按 id 找行就读 `.cfg-row`（e2e 里原来读 `.cfg-item` 的地方踩过：id 读不到 → 切供应商没切过去 → 后面 OCR 测试拿空供应商发请求，一片 401）。
- 三处都能排了 ⇒ 左栏那句 `.list-tip`「可拖动排序」**两种模式都挂着**（HTML 里不再 `hidden`，JS 里也不再按模式切）。
- 页脚的「已保存」两栏各有一个（`#save-status` / `#o-save-status`），`setSaveStatus()` **一次写全部 `.save-status`** —— 两栏共用一个存档，提示必须同步。

拖动排序用 **pointer 事件**而不是 HTML5 的 `draggable`（后者触屏压根不触发，原生拖影在设置页里也脏），代价是插入指示线得自己画（`.drop-before` / `.drop-after` / `.dragging`），落点用坐标算（`dropSpot`）而不做命中测试 —— 拖动时指针是「抓」在手柄上的，`elementFromPoint` 只会把手柄自己还回来。

**`to` 的口径要分清**：「配置」栏给的是完整数组下标；「图片配置」是 `state.configs` 的**过滤视图**，给的是过滤视图下标，得再过一层 `moveVisibleItem(all, visibleIds, from, to)` 换算成完整数组上的落点。**排序动的一定是 `state.configs` 本身**（另存一份顺序就是第二个真相源），副作用是「配置」栏的先后跟着一起变 —— 同一份数据，预期内的，所以两个列表都要重画。

## 说明文字的「不再显示」

设置页的说明文字很多，每条都能自己收掉（kniph 2026-10-14：「这种注释太多了」）。

- HTML 里给说明加 `data-hint="<稳定 id>"`，**按钮由 `applyHintHides()` 统一补**（十几处各贴一遍按钮既啰嗦又迟早漏一处）。id 要**稳定**：它进存档（`settings.hiddenHints`），按位置自动编号会在加一条说明之后错位。
- 收起用 **`.hint-off` 类**（`display: none !important`），**不用 `hidden` 属性** —— 有几条说明的 `hidden` 是**模式逻辑**在管的（OCR ↔ 图片直传的测试说明），一个属性两个主人迟早打架。
- 状态存 `settings.hiddenHints`（数组）。老存档里那个 boolean `ocrHintHidden`（那时候只有 OCR 栏顶那一句能收）在 `store.js` 的 `normalizeHiddenHints()` 里读一次映射成 `['ocr']` 并抹掉老键 —— **这不是版本迁移**，是「改字段类型」的兼容读取（`{...默认, ...stored}` 救不了）。
- **没做恢复入口**（他只要「点了不再显示」）：要恢复就清 `hiddenHints`。别在没确认之前加「恢复全部」按钮。

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

**平时只跑受改动影响的那一层，全量留到打包前**（kniph 2026-10-14 定的 —— 每改一处就 `npm test`
等于每次都等真实浏览器那一分多钟）。对应关系大致是：

| 改了什么 | 跑什么 |
| --- | --- |
| `lib/*.js` | `npm run test:lib`（改了 `engine.js` / `adapters.js` 再加 `npm run test:engine`） |
| `options.js` / `options.html` / `options.css` | `npm run test:ui`（+ `npm run check`，选择器和类名对不上它先报） |
| `content.js` / `popup.js` | `npm run test:ui` + `npm run check` |
| 准备打包 / 发版 | **`npm test` 全量**（四项都跑） |

```bash
npm test              # 全量：静态检查 + 单元 + 端到端 + 真实浏览器 UI（1406 项）
npm run check         # 只跑两项静态检查
npm run test:lib      # 解析器 / 模板 / 提取
npm run test:engine   # 本地 mock 服务器，验证各类响应格式
npm run test:ui       # 开真实 Edge 加载扩展，量 DOM 实际尺寸
npm run perf          # 量性能：主线程任务时间 + 进程 CPU，四档流式负载对照
npm run icons         # 重新生成图标
npm run pack          # 跑 npm test → 剥注释出包 → 验包（语法 / 行号 / 剥得干净）
```

`npm run perf` 只跑指定档位可以快很多：`PERF_ONLY=heavy npm run perf`（可选档位 `normal` / `fewLong` / `manyShort` / `heavy`）。

拆开看是 `test-lib` 810 项、`test-engine` 89 项、`test-strip` 19 项、`e2e-ui` 486 项，另加两项静态检查。各层补的盲区不同：

- **`check-globals`** — 语法检查看不出 `bindConfigList()` 这种「调用了但没写」，只有运行时才炸。它把注释、字符串、正则字面量剥掉之后逐个比对调用与声明。也可以指定文件：`node tools/check-globals.mjs lib/engine.js`。新增 `lib/*.js` 记得加进目标清单（含 `offscreen.js`）。识别**解构出来的对象参数**（`function f({ a, b })`）要单独一条正则 —— 只写 `\(([^()]*)\)` 的话 `{ a, b }` 整块留下来、拆开后每片都带花括号，一个都认不出来，里面的 `a` / `b` 反倒被报成「没定义」（`moveButton({ … onMove })` 踩过）。
- **`check-dom`** — 比对 JS 里的 `$('#id')` / `querySelector('.x')` / `closest('.x')`，和「HTML 里写死的**加上** JS 里拼出来的」类名，防的是「选择器指向不存在的元素，启动时炸在 null 上」。正则里的坑：`querySelectorAll?` 那个 `?` 只管最后一个 `l`，**所有 `querySelector('.x')` 从来没被扫到**，得写 `querySelector(?:All)?`。
- **`e2e-ui`** — 前两项只能说「代码能跑、选择器对得上」，管不了**长得对不对**。脚本用系统 Edge（`playwright-core`，不下载浏览器）加载扩展，真去划词、点按钮，用 `getBoundingClientRect` 量顶栏多高、面板多宽、缩放后尺寸有没有变。没装 Edge 会自动跳过。几处要点：
  - **正文是一个大 `try` 块**，`const` 同一作用域：加变量前先 grep 名字，重名直接 `SyntaxError`（跑 1 秒就退）
  - **小节之间会互相污染**：某节写进 storage 的开关不收尾，后面就走另一条路，而且**不报错**。瞬时态靠假接口 `/slow`（挂 1.2s）+ `waitForFunction` 采，别 sleep；失败消息带「class｜状态栏文字｜lastPath」
  - 状态灯那三态（紫/绿/红）靠 `/slow` 把「请求在飞」的瞬间停住才采得到
  - 截图 OCR 那段会**往系统剪切板里真塞一张 PNG**（PowerShell `-STA` + `System.Windows.Forms.Clipboard::Set*`）再跑全链路，而且必须开**有头**窗口 —— 无头 Chromium 的剪切板是桩实现，读回来永远是空的
  - 「换配置」一节用两个假配置各带 `?tag=`，靠假接口被打的次数和译文里的标记钉住三条：切回翻过的**一个请求都不发**、切到没翻过的**当场就翻**、流还在飞时用户切走了别的配置的流不许糊到这一屏上
  - 往测试页 `html` 写一条 `scrollbar-color`，验面板里的滚动条**不吃网页配色**
  - **框选截图那节末尾加两档**（验「右边那条滚动条不会被裁进去」）：先 `overflow-y: hidden` 断言「框满整屏 = 原样裁出整张，老行为不变」，再换成 `overflow-y: scroll` 造一条**真**滚动条，断言裁出来的宽正好少了那一条（实机 1178 → 1163，差 15）。两个硬点：① content script 跑在**隔离世界**里，页面伪 `window.innerWidth` 它看不见，只能造真滚动条；② 裁出来的尺寸只能从**假 OCR 接口收到的请求体**里解 PNG 头读（content script 的 `canvas.toDataURL` 钩不到）。A 方案后覆盖层里**没有 `.img` 了**，脚手架断言改成「有 `.veil` 接指针层 + `.sel` 挖洞层」+「提示条写了可滚动页面」
  - **框选那节必须有真鼠标用例**：`shotDrag()` 那套 `dispatchEvent` **绕过命中测试**，测不出「覆盖层吃不到鼠标」（踩过：真人框选不了，脚本却全绿）。所以另加两条：`document.elementFromPoint(x, y)` 必须指回遮罩（`hitIsHost`），以及 Playwright **真鼠标** `mouse.down/move/up` 拖一遍，断言遮罩收掉且真发了请求
  - 按钮样式那节把「自定义」两个分支都走一遍（填了图标 / 没填用示例顶着），在页面上量计算样式确认**真的没有底色**
  - 「导出 / 导入」真点一次导出、把下载的文件读出来解析，再拿它改一份「别的设备导出的」塞回去，顺带走「点取消什么都不动」「坏文件」「别的软件的 JSON」三条失败路径
  - 最后两节：**顶栏换目标语言**（把 `{{targetCode}}` 接进假接口查询串，拨一下下拉就断言请求真带着 `tag=EN` 重发了一条），以及**流式输出不甩着滚动条跑**（`/streamlong` 长流式路由把面板撑出滚动条，断言吐到一半和吐完之后 `scrollTop` 都是 0 —— 光断言「没滚」不够，得同时断言「内容确实长到该滚了」，不然是空跑）
  - 长流式那节的收尾顺手量**结果区最大高度**：从设置页改 `panelMaxHeight`（走 storage + `onChanged` 那条真路），量 `getComputedStyle('.rt-out').maxHeight` 换算的 px 对不对得上 `vh × innerHeight × --rt-zoom`，**同时**断言 `clientHeight` 真的跟着变 —— 只看 max-height 的话，「写了个变量但没生效」会漏过去
  - 最后一节量**按钮贴哪儿 / 什么时候自己消失**：鼠标那一路断言「离松手点正好 14px」（纵向也量）；键盘那一路用**真鼠标拖**出选区（脚本造的选区 Chrome 不让键盘改）再把鼠标扔到 `(900, 600)`，按真 Shift 键后断言按钮贴的是实测光标那一行、且离那个旧鼠标坐标 100px 以上；自动消失那几条把两个时间临时拨成 `2.5 / 1.5` 秒，依次验「停在按钮上不消失」「移开就消失」「移回则作废」「停着不动自己消失」「填 0 就不消失」。三个要点：
    - **往按钮上放鼠标之前必须先按 Esc 关掉面板** —— 两个都是 fixed，面板会盖住按钮，鼠标就落到面板上了（踩过一次，断言全绿着错）
    - **动手前先 `page.bringToFront()`**：这一节前面已经开过 `opt` / `opt2` / `opt3` 好几个页签，`page` 早退到后台，而后台页上的鼠标事件会被拖成**1 秒一个**（`steps:6` 实测 6 秒；单独复现同样的页面只要 60ms）—— 靠计时器判的用例会被这一步拖垮
    - **「移回则作废」那条是在跟计时器抢时间**：往返一律用**单步**移动（一个 mousemove）压到最短，并加一条「往返耗时 < 计时器」的脚手架断言 —— 环境一慢就让它直接报「脚手架太慢」，别让「按钮到点自己没了」冒充成「作废生效了」
- 量面板时**别让请求去够真实网络**，做本地假接口再把它指过去。

### 改完代码怎么生效

在扩展管理页点一下「重新加载」，**然后刷新目标网页** —— 两件都要做。

只重新加载扩展不够：已经在开着的页面里跑的是**旧的那份 content script**，它不会自己换成新的（而且扩展一重新加载，旧脚本手里的 `chrome.*` 就失效了）。症状很好认：设置页明明是新的、预览也对，网页上却还是老样子。

### 包里的源码是剥了注释的，仓库里那份是完整的

`npm run pack` 会先把 `.js/.css/.html` 剥一遍注释再打进 zip。**源码里的注释一个字都不动** —— 注释是给克隆仓库的人看的，装着扩展的人不会打开 `content.js`。

- **必须词法地剥，不能用正则**：`"https://a.com"` 里的 `//`、正则字面量 `/a\/b/`、模板串 `${x} // 文本` 都会被正则误伤。`tools/strip-comments.mjs` 是一个逐字符的词法器（区分代码/行注释/块注释/字符串/正则/模板串），`tools/test-strip.mjs` 是它的自测（19 项，重点全在「该留的留住了」）。
  `check-globals.mjs` 里也有一个词法器，但那个把**字符串内容也抹了**（它只想看代码结构），打包不能用。
- **换行和空行全留着**（`tidyBlankLines` 现在是原样返回）。DEFLATE 之后空行几乎不占体积，而留着它们意味着扩展万一在用户那儿炸了、报错栈的行号**仍能对上 GitHub 上的源码**。别为了省几百字节把它删掉。
- **剥完当场验语法**：每个 `.js` 都过一遍 `node --check`，剥坏了直接退出非零 —— 装上才发现面板打不开就晚了。
- **`tools/verify-pack.py` 验三件事**：① 15 个 js 全过 `node --check`；② 每个文件行数和仓库一致；③ **幂等** —— 把包里那份再剥一遍结果必须逐字相同。
  第三条是唯一站得住的「剥干净了」判据。**别用「仓库里有的字样包里也得有」**：注释里举的例子（`{{变量}}`、`https://x`）本来就该消失，这么判会误报一串（真踩过）。
- 想看带注释的包：`npm run pack -- --no-strip`。

---

## 已知的硬边界

- **`manifest.json` 的 `proxy` 权限已经整块删掉**（原先只为「临时直连」服务）。别再捡回来 —— 代理分流应该在代理软件里按规则做，加这个权限会让 Edge 显示「读取和更改您的代理设置」。
- Bing 通道**代理开启时必然空 body**。首选在代理客户端加 `DOMAIN-SUFFIX,bing.com,DIRECT`；插件侧不再有任何兜底手段。
- API key 明文存 `chrome.storage.local`，导出配置文件等于泄 key。
