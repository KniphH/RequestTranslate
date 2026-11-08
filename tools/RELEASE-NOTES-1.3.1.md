## 装法

**Edge / Chrome**：下载 `request-translate-1.3.1.zip`，解压成文件夹，`edge://extensions` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选那个文件夹。

**Firefox**：下载 `request-translate-1.3.1.xpi`，`about:debugging#/runtime/this-firefox` →「临时载入附加组件…」→ 选 `.xpi`。

> 两个包内容一致，只有 `manifest.json` 的 `background` 段不同（各自浏览器只认自己那个字段）。

---

## 这版新增：bilibili Index-Translate 免费翻译

内置了一条 B 站官方的翻译服务，**不用填任何 Key**：

```
POST https://index-translate.bilibili.com/v1/chat/completions
{"model": "Index-Translate-35B-A3B", "messages": [...]}
```

标准 OpenAI 兼容接口，官方仓库 <https://github.com/bilibili/Index-Translate>。

**文本和图片都能翻**：它内置视觉编码器，图片翻译不需要先做 OCR —— 在设置里勾上
「禁用外置 OCR（仅模型具有多模态时使用）」就能免费零配置同时用上图片翻译和大模型翻译。

默认选中的仍是 **Bing 翻译**，不主动切换就不会走 B 站。

### 关于那两条请求头

该服务要求请求同时带：

```
User-Agent: Index-Translate-Client/1.0 SnapCut/1.0
Origin:     https://www.bilibili.com
```

缺任何一个都是 **412 风控页**。而浏览器不允许扩展改 `User-Agent`（会静默替换成真实 UA），
所以本版用 `declarativeNetRequest` 的静态规则集补这两个头 —— **规则只匹配
`index-translate.bilibili.com` 这一个域名**，不影响发往任何其他站点的请求。

完整规则在 `lib/ua-rules.json`，`PRIVACY.md` 里也如实写明：选中这条配置时文字会发到 B 站服务器。

---

## 两个修复

**① 面板被网页的 `text-align` 带跑**

某些站点（例如 nhentai）把 `text-align: center` 写在 `html`/`body` 上。它是可继承属性，
**能穿过 shadow DOM** 继承进面板，导致原文区和译文被居中，看起来像本扩展排版坏了。
修复：`.rt-panel` 里显式写回 `text-align: start`。

和之前修的 `scrollbar-color` 是同一类问题 —— 继承属性挡不住，只能显式写回。

**② Edge 商店拒包**

1.3.0 的包在 Edge 商店提交时被整包拒绝：

```
The background.scripts field cannot be used with manifest version 3.
```

原因是 `background` 同时写了 `service_worker`（Chromium 用）和 `scripts`（Firefox 用）。
**浏览器运行时两者都能加载**（各自忽略不认的字段），但**商店校验器不容忍**。

现在出包时按目标裁一次：zip 只留 `service_worker`，xpi 只留 `scripts`。
仓库里的 manifest 保持双字段 —— 本地加载体验不变。

---

## 其它

- 演示 GIF 换新（划词翻译 + 图片直传两条路径，29 秒）
- 文档图片重做（手绘图解 + 真实截图）
- 零依赖零构建不变，包 122.6 KB