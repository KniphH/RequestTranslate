# AMO 审核说明（贴进「给审核员的说明」那一栏）

> 用途：AMO 提交页的「备注 / Notes to Reviewer」字段。
> 里面点名 `Unsafe assignment to innerHTML` **可能导致驳回**，所以必须主动解释，
> 而不是等审核员来问。

---

## 中文版（可直接粘贴）

```text
这个扩展的核心功能是「用户自己写 HTTP 请求做划词翻译」，因此有大量结构化
数据需要渲染（配置列表、变量表、历史记录、面板槽位）。我使用 innerHTML 来
构造这些结构，但**所有用户可编辑的数据都经过转义**，理由如下：

1. 用户输入一律走 escapeHtml()（转义 & < >）后才拼进模板。涉及：配置名、
   变量的键与值、翻译历史、目标语言、OCR 供应商名、变量提示文本。

2. 用户唯一能输入「原始标记」的地方是自定义按钮图标（一段 SVG）。它有两层防护：
   - SVG_GUARDS 黑名单：必须以 <svg 开头、以 </svg> 结尾；禁止 <script>、
     <foreignObject>、<iframe>、<image>、<use>、<a>、<style>、<animate>、<set>；
     禁止任何 on* 事件属性；禁止 href / xlink:href。
   - 我用 13 个已知 XSS 载荷实测过（含大小写混淆、< script 空格混淆、未闭合标签），
     全部被拦住。

3. 面板跑在 open Shadow DOM 里，与页面 DOM 隔离；注入的自定义 CSS
   （设置页那个文本框）只作用于面板自己的 shadow root，不触达宿主页面。

4. 静态的 SVG 图标（复制 / 朗读 / 重试 / 眼睛）是仓库里的常量字符串，不含任何
   来自网络或用户的数据。

这个扩展**不加载任何远程代码**，不 eval，不 new Function；所有请求都由用户
在设置页自己填写（发往用户自己配置的接口）。
```

## English version

```text
The core feature of this extension is "selection translation using HTTP requests
that the user writes themselves", so a lot of structured data has to be rendered:
config lists, variable tables, history entries, and panel result slots. I use
innerHTML to build those structures, but EVERY user-editable value is escaped:

1. All user input goes through escapeHtml() (escapes & < >) before being
   interpolated. This covers: config names, variable keys and values, translation
   history, target language, OCR provider names, and variable hint text.

2. The only place a user can supply raw markup is the custom button icon (an SVG
   fragment). It has two layers of protection:
   - SVG_GUARDS allow/deny list: must start with <svg and end with </svg>; rejects
     <script>, <foreignObject>, <iframe>, <image>, <use>, <a>, <style>, <animate>,
     <set>; rejects any on* event attribute; rejects href / xlink:href.
   - I tested it against 13 known XSS payloads (including case-mangled tags,
     "< script" with a space, and unterminated markup). All were blocked.

3. The panel lives in an OPEN SHADOW ROOT, isolated from the page DOM. The custom
   CSS the user can type is injected only into that shadow root and never reaches
   the host page.

4. The static SVG icons (copy / speak / retry / eye) are constant strings from the
   repository. They contain no data from the network or from the user.

This extension loads NO remote code, does not use eval or new Function. All
requests are written by the user in the options page and go only to endpoints the
user configured themselves.
```

---

## 附：27 条警告的逐条归属

审核员如果追问，照这张表答：

| 归属 | 条数 | 性质 |
| --- | --- | --- |
| 静态常量 SVG（图标、内置提示表） | 8 | 仓库里的固定字符串，无外部数据 |
| 模板 + `escapeHtml()` 包裹 | 12 | 用户数据已经转义 |
| 自定义 SVG（走 `SVG_GUARDS`） | 2 | 黑名单 + 13 个载荷实测全拦住 |
| `innerHTML = ''` 清空 | 3 | 清空内容，不注入任何东西 |
| 面板骨架 / 槽位（`lib/panel-core.js`） | 2 | 结构固定，值走转义 |

## 附：权限说明（审核员常问）

| 权限 | 为什么需要 |
| --- | --- |
| `storage` | 存配置、变量、翻译历史。全部在本机 |
| `contextMenus` | 右键菜单：截图翻译 / 剪切板 OCR |
| `scripting` | 用户点「框选截图」时把遮罩注入当前页 |
| `activeTab` | 同上，只作用于用户当前操作的那个标签页 |
| `clipboardRead` | 「翻译剪切板里的截图」读图。**不读文字** |
| `offscreen` | Chromium 专用（读剪切板要有 DOM）。火狐上不使用 |
| `declarativeNetRequest` | **1.3.1 新增**。仅用于给内置的 bilibili 免费翻译补 `User-Agent` / `Origin` 两个请求头（见下方专节）。规则只匹配那一个域名 |
| `<all_urls>` | 用户可能在任意网页上划词；请求要发往用户自己填的任意域名 |

**没有任何权限用于收集数据。** 数据只发往用户在设置页自己配置的接口。

### 1.3.1 新增：`declarativeNetRequest`（重要，请读这一段）

1.3.1 内置了一条 **B 站官方的免费翻译服务**（`index-translate.bilibili.com`，
官方仓库 <https://github.com/bilibili/Index-Translate>，无需 API Key）。

该服务的风控要求请求同时携带：

```
User-Agent: Index-Translate-Client/1.0 SnapCut/1.0
Origin:     https://www.bilibili.com
```

而**浏览器的 `fetch` 不允许扩展修改 `User-Agent`**（它属于禁止修改的请求头，
设置了会被静默丢弃并替换成浏览器真实 UA）。**这不是我们的选择，是浏览器的硬限制** ——
实测：`headers: {"User-Agent": "X-Test/1.0"}` 发出去，服务端收到的是 `Mozilla/5.0 ... Edg/...`。

所以只能用 `declarativeNetRequest` 的 `modifyHeaders` 来补这两个头。规则是**静态规则集**
（`manifest.declarative_net_request.rule_resources` → `lib/ua-rules.json`），全文如下：

```json
[{
  "id": 1, "priority": 1,
  "action": {"type": "modifyHeaders", "requestHeaders": [
    {"header": "user-agent", "operation": "set", "value": "Index-Translate-Client/1.0 SnapCut/1.0"},
    {"header": "origin",     "operation": "set", "value": "https://www.bilibili.com"}
  ]},
  "condition": {
    "requestDomains": ["index-translate.bilibili.com"],
    "resourceTypes": ["xmlhttprequest", "other"]
  }
}]
```

**请重点核对这三点：**

| 审核关注点 | 事实 |
| --- | --- |
| 规则影响范围 | **只匹配 `index-translate.bilibili.com` 一个域名**（`requestDomains`）。发往其他任何站点的请求都不受影响 |
| 它改了什么 | 只改 `user-agent` 和 `origin` 两个请求头，**不读取、不记录、不转发任何响应内容** |
| 有没有绕过鉴权 | **没有**。这个接口本身就是公开的、不要求任何 Key 或令牌（curl 一趟就通，见官方 README「Option 1: Free Online API」）。改这两个头只是为了让请求不被风控页拦掉，不是绕过任何身份验证 |

**用户能不能不用它？** 能，而且这是默认状态：

- 默认选中的配置是 **Bing 翻译**，不走 B 站接口
- 只有用户**主动**在面板顶栏或设置页选中「bilibili Index-Translate」那条时，文字才会发给 B 站
- 用户也可以直接把那条配置删掉

`PRIVACY.md` 第 15 行起已如实写明上述全部内容（含「文字会上传到 bilibili 服务器」）。

**它是不是远程代码？** 不是。`lib/ua-rules.json` 是随包一起分发的静态 JSON，
扩展不下载、也不执行任何远程代码（项目本身零依赖、零构建、无 CDN 引用）。

### `<all_urls>` 的说明补充

1.3.1 起 `host_permissions` 仍是 `<all_urls>`，理由不变：用户可能在任意网页上划词，
请求要发往用户自己填写的任意域名。**新增的 DNR 规则不会扩大它的影响范围** ——
那条规则写死了只匹配一个域名。

### 1.3.1 的其它改动（与权限无关，仅供参考）

- 修了一个**继承属性穿透 shadow DOM** 的排版问题：某些网页（如 nhentai）把
  `text-align: center` 写在 `html`/`body` 上，它会穿过 shadow DOM 继承进面板，
  导致译文被居中。修法是 `.rt-panel` 里显式写回 `text-align: start`。
  这是纯 CSS 修复，不涉及任何权限。
- 文档图片与演示 GIF 更新（仓库内资源，不进包）。
