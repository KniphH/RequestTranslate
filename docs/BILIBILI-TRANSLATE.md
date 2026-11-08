# bilibili Index-Translate（内置免费翻译）

> 2026-11-08 · **已接入，开箱即用**。无需 Key，标准 OpenAI 兼容接口。
> 官方仓库：<https://github.com/bilibili/Index-Translate>

---

## 接口

```
POST https://index-translate.bilibili.com/v1/chat/completions
```

| 项 | 值 |
| --- | --- |
| 模型 | `Index-Translate-35B-A3B`（另有 `-9B` / `-2B`） |
| 鉴权 | **无**（不用 key、不用 token） |
| 格式 | OpenAI 兼容（后端 vLLM 0.23.0） |
| 流式 | ✅ 支持 `stream: true` |
| 多模态 | ✅ 支持 `image_url`（内置视觉编码器，**不需要 OCR**） |

## 风控：必须同时带两个头

这是接这个接口最关键的一条，**两个头缺一不可**（逐项实测）：

| 组合 | 结果 |
| --- | --- |
| `User-Agent: Index-Translate-Client/1.0 SnapCut/1.0` + `Origin: https://www.bilibili.com` | ✅ **200** |
| 只带 UA | ❌ 412 |
| UA + `Referer` | ❌ 412 |
| UA + `Sec-Fetch-*` | ❌ 412 |
| 什么都不带（浏览器默认 UA） | ❌ 412 |

412 那页是 `security.bilibili.com` 的风控页（`错误号: 412`，带验证码脚本），
**不是 JSON** —— 引擎会把它当纯文本渲染出来，看起来像「完成」但其实没译文。

## 为什么扩展自己改不了 UA

`User-Agent` 在浏览器**禁止修改的请求头**列表里。实测在扩展的 service worker 里：

```js
headers: { 'User-Agent': 'X-Test/1.0' }   // 我们设的
// 回显服务收到的：
// "Mozilla/5.0 ... HeadlessChrome/150 ... Edg/150"   ← 被替换了
// 而同一次请求的 X-Custom: abc 正常生效
```

`fetch` 改不了，但 **`declarativeNetRequest` 能改**（实测：加规则前发浏览器 UA，
加规则后发 `DNR-TEST-UA/1.0`）。

## 实现：静态 DNR 规则集

`manifest.json`：

```json
"declarative_net_request": {
  "rule_resources": [{ "id": "ua-rules", "enabled": true, "path": "lib/ua-rules.json" }]
}
```

`lib/ua-rules.json`：

```json
[{"id": 1, "priority": 1,
  "action": {"type": "modifyHeaders", "requestHeaders": [
    {"header": "user-agent", "operation": "set", "value": "Index-Translate-Client/1.0 SnapCut/1.0"},
    {"header": "origin",     "operation": "set", "value": "https://www.bilibili.com"}
  ]},
  "condition": {"requestDomains": ["index-translate.bilibili.com"],
                "resourceTypes": ["xmlhttprequest", "other"]}}]
```

**只针对这一个域名**，不影响发往其他任何站点的请求。

### 踩过的坑：运行时注册不生效

一开始写成 `background.js` 顶层调 `updateSessionRules()` —— **完全不执行**。
MV3 的 service worker 是懒启动的，没有事件唤醒时顶层代码不会跑：
`getSessionRules()` 返回空数组，且没有任何 console 日志。
（同环境手动调 `updateSessionRules()` 能成功，所以不是权限问题。）

**改用静态规则集**（`rule_resources`），扩展加载即注册，不依赖唤醒。
实测 `getEnabledRulesets()` 返回 `["ua-rules"]`。

## 内置的配置

`lib/store.js` 的 `DEFAULT_CONFIGS` 里加了 `builtin-bilibili`，插在 Bing 之后。
它带**两个模板**：

| 字段 | 用途 |
| --- | --- |
| `request` | 纯文本翻译 |
| `imageRequest` | 多模态图片翻译（`image_url` + `text`） |

第二个模板让「设置 → 禁用外置 OCR（仅模型具有多模态时使用）」变得有用：
**不开 OCR 也能翻图**，因为模型自己看得懂图里的字。

- **默认选中的仍是 Bing**（`activeConfigId` 不变），不换就不会走 bilibili。
- 文字和图片只在**选中这条配置时**才发给 bilibili —— 见 `PRIVACY.md`。

## 实测数据

| 测试 | 结果 |
| --- | --- |
| 文本：`The quick brown fox jumps over the lazy dog.` | `敏捷的棕色狐狸跳过了懒惰的狗。` |
| 文本：`Machine translation has improved...` | `过去十年间，机器翻译取得了长足的进步。` |
| 图片：含 `Machine Learning Basics` 的 PNG | `机器学习基础` + `神经网络从数据中学习。` |
| 扩展内端到端（流式） | `HTTP 200 · 0.6s`，SSE 8 分片，首字 0.42s |
| 连续 6 次非流式 | 6 成功 / 0 失败 |

**偶发断连**：连续快速请求时出现过 `RemoteDisconnected`（3 次里 2 次）。
加 1 次重试后 8/8 全过 —— 建议主请求后面挂一条**同样的**后备请求。

## 官方怎么说的

README 里给了免费 API 的 curl，但也明说：

> Browser extensions require a local bridge proxy due to CORS/WAF headers and thinking tag suppression

官方的推荐是跑本地代理（`python inference/llm/call_api.py --serve`，监听 `127.0.0.1:8080`）。
**本扩展没有走那条路** —— kniph 2026-11-08 定：要开箱即用，不做本地代理。
所以这里用 DNR 直接补齐那两个头。

## ⚠️ 风险（用之前要知道）

1. **它是公益性质的免费接口**，不是有 SLA 的商业 API。没有配额说明，
   随时可能改地址、加鉴权或限流。**挂了就更新配置，别当唯一依赖。**
2. **文字（和图片）会发给 bilibili 的服务器**。翻译敏感内容前自己权衡。
3. **DNR 改写 UA/Origin 是在补官方要求的那两个头**，不是绕过鉴权（接口本来就不要 key）。
   但如果 B 站改了风控策略，这套也会失效 —— 到那时改 `lib/ua-rules.json` 就行。

## 接口地址变了怎么办

这个地址是**从 SnapCut 的二进制里挖出来的**（该功能不在它的开源仓库里，
.NET 单文件的字符串是 UTF-16，纯 ASCII 搜不到）。将来地址变了，可以照同样套路再挖一次；
也可以直接看官方仓库 README 的 curl 示例。
