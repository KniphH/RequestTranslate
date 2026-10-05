# 火狐（Firefox）移植改动清单

> 目标：**同一份代码、同一个 zip** 同时喂 Edge/Chrome 和 Firefox。
> 前提：不引入构建步骤、不引 polyfill（保持零依赖零构建）。
> 现状：`1.1.0` 在火狐上**跑不起来**（后台不启动 + Promise 全废）。

---

## 总览

| 项 | 规模 |
| --- | --- |
| 涉及文件 | 8 个（含新增 1 个） |
| 需改的 `chrome.*` 调用点 | **约 45 处** |
| 分文件 | background 18 / content 9 / lib·network 8 / lib·store 5 / popup 4 / options 1 / offscreen 1 |
| 构建链 | **不动**（`pack.py` 白名单里 `lib/` 是整目录收，新文件自动进包） |
| 版本号 | 建议 **1.2.0**（新增一个平台） |

---

## 改动 1｜新增 `lib/ext.js` —— 唯一的 API 入口

**为什么**：火狐的 `chrome.*` 命名空间**只支持回调、不返回 Promise**，Promise 只在 `browser.*` 上。
项目里写了 `await chrome.storage.local.get(...)`，到火狐全变 `undefined`。

```js
/**
 * 扩展 API 的唯一入口。
 *
 * 火狐的 `chrome.*` 只给回调（不返回 Promise），Promise 只在 `browser.*` 上 —— 所以
 * 火狐走 browser、Chromium 走 chrome，两边都是 Promise。
 * 不用 `browser` 是否存在来判断引擎：Chromium 从 Chrome 148 / Edge 136 起也有
 * `browser` 了，那样会认错（而且不能拿它当最低版本线，等于要求用户升级到 2026 年中的浏览器）。
 */
export const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

/** 真·Gecko（Firefox）。用扩展协议头判断，比 UA 稳。 */
export const isGecko = ext.runtime.getURL('').startsWith('moz-extension://');
```

**风险**：低。`ext` 就是个别名，Chromium 上行为与现在完全一致。

---

## 改动 2｜`manifest.json`

```json
"background": {
  "service_worker": "background.js",
  "scripts": ["background.js"],
  "type": "module"
},
"browser_specific_settings": {
  "gecko": {
    "id": "request-translate@<你的域名或任意邮箱格式>",
    "strict_min_version": "140.0",
    "data_collection_permissions": { "required": ["websiteContent"] }
  }
}
```

三件事，逐条说明：

1. **`scripts` 必须加**。火狐**不支持 `background.service_worker`**（MDN 兼容数据明确标 false），
   它的 MV3 后台是「事件页」（有 DOM、会被卸载）。Firefox 121+ / Chrome 121+ 起，两边都会
   **忽略自己不认的那个键** → 一份 manifest 通吃。
2. **`gecko.id`**：MV3 签名**必需**，AMO **不会**替你生成。格式是邮箱样子的串，不必是真邮箱
   （`strict_min_version` 用点号写 `"140.0"`，写 `"140"` 过不了 linter 的版本正则）。
3. **`data_collection_permissions`**：2025-11-03 起**新扩展强制**，不采集也要写。我们的扩展把
   用户选中的**网页文字/截图发给用户自己配的接口** —— 按政策的定义（「在扩展或本地浏览器之外被处理」）
   这算传输，**必须声明 `websiteContent`**，勾 `none` 属虚假声明会被拒。
   设 `strict_min_version: "140.0"` 是为了白拿火狐**内置**的同意界面；低于 140 就得自己做一个
   「装完立刻弹出、不可忽略」的同意流程，不值得。

**保留不动的键**：`minimum_chrome_version`、`permissions` 里的 `offscreen` —— 火狐不认识，
只会让 AMO linter 报**警告**（不是错误）。真实的警告内容等跑完 `web-ext lint` 再核。

---

## 改动 3｜全局替换 `chrome.` → `ext.`（约 45 处）

| 文件 | 处数 | 说明 |
| --- | --- | --- |
| `background.js` | 18 | 加 `import { ext, isGecko }` |
| `content.js` | 9 | **不能 import**，得手抄一份（见改动 6） |
| `lib/network.js` | 8 | **proxy 那 8 处例外，见改动 4** |
| `lib/store.js` | 5 | 加 import |
| `popup.js` | 4 | 加 import |
| `options.js` | 1 | 加 import |
| `offscreen.js` | 1 | 加 import；火狐上这文件根本不会被加载 |
| `lib/trigger-styles.js` | 0 | 只有一句注释提到 `chrome.*`，不用动 |

**没问题的 API**（已核 BCD，火狐全支持，不用改逻辑）：
`storage` / `runtime` 消息与事件页 / `contextMenus` / `tabs.getZoom` / `tabs.onZoomChange` /
`scripting.executeScript`（FF102+）/ `action` / `_locales` / `host_permissions`（FF109+）。

**唯一要小心的写法**：`chrome.runtime.onMessage` 的监听器**不能**用「返回 Promise」来异步应答
（火狐支持、Chromium 不支持）。项目现在用的是 `sendResponse` + `return true`，**这条是对的，别动**。

---

## 改动 4｜`lib/network.js` 的 proxy：**刻意不改**

`lib/network.js` 里 8 处 `chrome.proxy.*` 全部**保持原样**。原因：

- 火狐的 proxy API 是**另一套设计**（MDN：两个 API 不兼容），而且**只在 `browser.` 命名空间下暴露**
  → 火狐里 `chrome.proxy` 就是 `undefined`。
- 现有探测 `canControlProxy()`（判 `chrome.proxy && chrome.proxy.settings`）**恰好会返回 false**
  → 「临时直连」自动降级成不可用。**这个降级是正确且安全的，不用改。**

**要做的只有一件事**：在 `canControlProxy()` 上加注释，写明「火狐故意走这条路降级，不是漏改」，
免得以后有人顺手把它改成 `ext.proxy` 反而把火狐弄挂。

---

## 改动 5｜`offscreen` 降级（⚠ 你说先留个坑，这条待定）

`chrome.offscreen` 火狐**没有**（BCD 里连 `api/offscreen.json` 这个文件都不存在）。
它只被用在**「翻译剪切板截图」**这一条路上，且被三个函数包住了，改动面可控：

```
background.js: ensureOffscreen() → askOffscreen() → readClipboardImage()
```

- **最小处理（建议至少做到）**：`isGecko` 时直接返回
  `{ ok: false, reason: 'unavailable' }`，让上层给用户一句**看得见**的说明（比如「火狐下请到设置页
  用截图 OCR」），**而不是抛未捕获异常**。符合「不做隐式行为」的原则。
- **完整方案（待定）**：火狐后台是事件页、**有 DOM**，理论上能直接读；但 `navigator.clipboard.read()`
  在被隐藏的页面里能不能拿到数据，**必须真机验**，现在不敢写死。
  另一条路是开一个被聚焦的临时小窗读（能成，但会闪一下）。
- 顺带：设置页的「OCR 测试」读剪切板那条路**不走 offscreen**（options 页面自己是可见页面），
  火狐下应当仍然可用 —— 待验。

---

## 改动 6｜`content.js` 手抄 `ext` + 逐字比对测试

content script 不能 `import`，所以 `content.js` 顶部要手抄一份 `ext` / `isGecko`（只抄这两行，
不引 `lib/ext.js`），并**照现有第 17 节的规矩配逐字比对测试**（`test-lib.mjs` 用 `fs` 读两个文件的
原文比对）。注意比对拿的是**文件原文**，别在 content.js 里写成变形版。

---

## 改动 7｜测试与检查器

- `tools/check-globals.mjs` 的 `DEFAULT_TARGETS` **加 `lib/ext.js`**（不加就漏检）。
- `tools/test-lib.mjs` 新增：
  1. `lib/ext.js` 里 `ext` 的探测写法正确（有 `browser` 时走 `browser`）；
  2. `content.js` 手抄的 `ext` / `isGecko` 与 `lib/ext.js` 逐字一致；
  3. `manifest.json` 的 `background` **同时**有 `service_worker` 和 `scripts`，且指向同一文件；
  4. `manifest.json` 有 `browser_specific_settings.gecko.id` 和 `data_collection_permissions`；
  5. `lib/network.js` 里仍然是 `chrome.proxy`（防止有人「顺手修好」）。
- **e2e（Edge 真机 250 项）必须仍然全绿** —— 移植不允许动到 Chromium 侧行为。

---

## 改动 8｜打包与发布

- **`tools/pack.py` 不用改**：新文件在 `lib/` 里，`DIRS` 整目录收；`ROOT_FILES` 不动。
- **一个 zip 两边通用**：`browser_specific_settings` 被 Chromium 忽略，`scripts` 被 Chromium 121+
  忽略 → 同一份 zip 既能传 Partner Center 也能传 AMO。**这是这次方案最大的好处。**
- 版本号建议 **1.2.0**；README 安装节补第三行（AMO / xpi）。
- AMO 首次提交需要：Mozilla 账号、扩展 ID（改动 2 里那个）、隐私政策 URL（已有 `PRIVACY.md`，
  但 AMO 要的是一个 **URL**，可能要挂到 GitHub README 上）。

---

## 待办与待验（真机才能定）

| # | 待验 | 影响 |
| --- | --- | --- |
| 1 | 本机**没装 Firefox**，要先装 | 没有真机就没法做你要求的「改完必验」 |
| 2 | `web-ext lint` 对 `minimum_chrome_version` / `offscreen` 权限的具体报法 | 若报 error 就得在打包时按目标裁 manifest |
| 3 | 火狐事件页里 `navigator.clipboard` 是否可用 | 决定改动 5 走哪条路 |
| 4 | 用户撤销 host 权限后的表现 | 要不要加「权限没给」的提示 |
| 5 | `data_collection_permissions` 的分类是否被审核认可 | 选错会被拒 |

---

## 建议的推进顺序

1. 改动 1、3、6、7（地基 + 替换 + 测试）→ 跑 `npm test`，Edge 侧必须 808 项全绿
2. 改动 2、4（manifest + proxy 注释）→ 装 Firefox，`web-ext lint` + `web-ext run` 实测
3. 改动 5（offscreen 降级）→ 视真机结果定方案
4. 改动 8（升版本、打包、补 README），两个商店分别提交
