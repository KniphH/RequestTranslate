# 隐私政策 / Privacy Policy

最后更新 / Last updated: 2026-11-08

## 中文

RequestTranslate 是一款划词翻译浏览器扩展。**开发者不收集、不存储、不上传任何用户数据到开发者自己的服务器。**

### 本扩展如何处理数据

- **翻译请求**：你选中的文字（以及截图翻译时剪切板里的图片）会被发送到**你当前选中的那条配置指向的接口** —— 要么是你自己填写的地址（自己的模型网关、任何 OpenAI 兼容服务），要么是下面说明的内置 bilibili 免费通道。这些请求由扩展直接发往目标地址，**开发者无法看到它们，也不经过任何中间服务器**。

- **内置 bilibili Index-Translate 通道**：扩展内置一条 B 站官方的免费翻译配置（`index-translate.bilibili.com`），不用填 Key。**只有当你在面板顶栏或设置里选中它时**，你选中的文字才会发送到 bilibili 的服务器并受其隐私政策约束；截图翻译时如果勾了「禁用外置 OCR」，**整张图片**也会发给它。**默认选中的是 Bing 通道**，不换就不走 bilibili。不想用可以删掉这条配置，或永远不选它。

- **关于请求头**：bilibili 通道需要特定的 `User-Agent` 和 `Origin` 才能通过其风控。**这两个头直接写在 bilibili 那条配置的请求模板里**（打开配置就能看到），所以 Chromium 和 Firefox 上行为一致，不依赖任何浏览器专有 API。扩展另外带一条 `declarativeNetRequest` 规则（`lib/ua-rules.json`，**只针对 `index-translate.bilibili.com`**）作为兜底，不影响发往其他任何站点的请求。
- **请求模板变量**：配置模板里可以使用 `{{url}}` 和 `{{title}}`，对应当前页面的地址和标题。它们只在模板里被你写出来时才会随请求发送；模板里不用就不发。
- **OCR（截图识别）**：配置了 OCR 供应商时，剪切板里的截图会发送到你配置的 OCR 接口。勾选「禁用外置 OCR」时，图片直接进入你自己配置的翻译请求。
- **本地存储**：配置、API Key、设置都保存在浏览器本地的 `chrome.storage.local`，不同步到任何账号。注意 API Key 是**明文**保存的——不要把导出的配置文件发给别人。
- **翻译记录**：最近几次翻译的**原文和译文**（默认保留 10 条，可在设置里改成 0 条即完全不记录）同样只存在本地的 `chrome.storage.local`，**不会**写进导出的配置文件，也不上传到任何地方。它在设置页「翻译记录」里可见、可一键清空。
- **不碰代理设置**：扩展不读取、也不修改浏览器的代理设置（权限列表里没有 `proxy`）。请求怎么走完全由你的系统和代理软件决定。
- **界面语言包会联网下载**：设置页可以换界面语言，那些语言包**不在安装包里**，
  选中时才会从本仓库（`raw.githubusercontent.com` / `cdn.jsdelivr.net`）下载一次并缓存在本地。
  下载的是**纯文案 JSON**（键值对，没有可执行代码），只在你主动选语言时发生，不发任何数据出去。
  不换语言就永远不联网。
- **自定义面板 CSS 可能外连**：设置里的「自定义面板样式」是给你自己写 CSS 的，
  如果那里面写了 `@import` 或 `url(...)`，浏览器会去取对应地址 —— 那是你写的，扩展不代劳也不改写。
- **关于「零构建」**：运行时零依赖（扩展直接加载解压文件夹即可跑）；打包脚本可选调用 esbuild 压缩体积，
  压缩不影响功能，也不引入任何运行时依赖。

### 不做的事

- 不包含任何分析、统计、遥测代码
- 不包含远程加载的**代码**（运行时零依赖；打包脚本可选调用 esbuild 压缩体积，那只影响包的大小、不引入运行时依赖）
- 不出售、不共享、不转移任何数据给第三方
- 不上报使用情况、不埋点

### 联系方式

GitHub Issues: <https://github.com/KniphH/RequestTranslate/issues>

---

## English

RequestTranslate is a selection-translation browser extension. **The developer does not collect, store, or transmit any user data to any developer-owned server.**

### How this extension handles data

- **Translation requests**: The text you select (and, for screenshot translation, the image in your clipboard) is sent to **the endpoint of whichever config you have selected** — either an address you filled in yourself (your own model gateway, any OpenAI-compatible service), or the built-in bilibili free channel described below. Requests go directly from the extension to that address; the developer never sees them and no intermediary server is involved.

- **Built-in bilibili Index-Translate channel**: The extension ships one free translation config that
  uses bilibili's public endpoint (`index-translate.bilibili.com`); it needs no API key. It is only
  used if you select it in the panel header or in settings. When it is selected, the text you asked
  to translate is sent to bilibili's servers and is subject to their privacy policy.
  **With "disable external OCR" enabled, the entire screenshot is also sent to it.**
  **The default selection is the Bing channel** — bilibili is never used unless you switch to it.

- **About request headers**: The bilibili channel only passes its abuse checks with a specific
  `User-Agent` and `Origin`. **Both are written directly into that config's request template** (open
  the config and you will see them), so behaviour is identical on Chromium and Firefox and does not
  depend on any browser-specific API. The extension also ships one `declarativeNetRequest` rule
  (`lib/ua-rules.json`, **for `index-translate.bilibili.com` only**) as a fallback; it does not
  affect requests to any other site.
- **Template variables**: Request templates may reference `{{url}}` and `{{title}}` (the current page's URL and title). They are only included in a request if your template references them.
- **OCR**: If you configure an OCR provider, screenshots are sent to that provider's endpoint. With "disable external OCR" enabled, the image goes directly into your own configured translation request.
- **Local storage**: Configuration, API keys and settings are stored locally in the browser's `chrome.storage.local` and never synced to any account. Note that API keys are stored **in plain text** — do not share exported configuration files.
- **Translation history**: The source and translated text of your most recent translations (10 entries by default; set it to 0 to keep none) is also stored only in the local `chrome.storage.local`. It is **not** written into exported configuration files and is never uploaded anywhere. It can be viewed and cleared on the settings page.
- **No proxy access**: The extension never reads or changes your browser's proxy settings (it does not request the `proxy` permission). How requests are routed is entirely up to your system and your proxy client.
- **UI language packs are downloaded**: The settings page lets you switch interface language. Those packs are **not bundled**; the one you pick is downloaded once from this repository (`raw.githubusercontent.com` / `cdn.jsdelivr.net`) and cached locally. They are plain key-value JSON with no executable code, the download only happens when you pick a language, and nothing is sent out. **When it happens**: opening (or focusing) the language dropdown in settings preloads one so the list is ready, and picking a language fetches one too. Nothing else triggers a download — simply opening the settings page without touching that dropdown fetches nothing. If you put an `@import` or `url(...)` in it, your browser will fetch that address — it is your CSS, the extension neither adds nor rewrites it.
- **About "zero build"**: Zero runtime dependencies (load the unpacked folder and it runs). The packaging script may optionally invoke esbuild to shrink the bundle; that changes neither functionality nor runtime dependencies.

### What this extension does not do

- No analytics, statistics or telemetry code
- No remotely hosted code (zero runtime dependencies; the packaging script may optionally call esbuild to shrink the bundle — that only affects package size and adds no runtime dependency)
- No selling, sharing or transferring of data to third parties
- No usage reporting

### Contact

GitHub Issues: <https://github.com/KniphH/RequestTranslate/issues>
