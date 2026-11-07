# AMO 提交清单（直接照抄）

> 2026-11-08。开发者中心已登录、页面停在「提交您的第一个附加组件」。

## 一、上传哪个文件

```
C:\Users\Administrator\WorkBuddy\翻译插件\dist\request-translate-1.3.0.xpi
```

33 个文件，123,535 字节。**不要**上传 `.zip` —— 内容一模一样，但 AMO 认 `.xpi` 更顺。

## 二、第一个岔路：选哪个

提交后第一屏会让你选分发方式，**选「On your own」（自行分发 / unlisted）**：

| 选项 | 中文界面可能叫 | 选它吗 |
| --- | --- | --- |
| **On your own** | 自行分发 / 在我的网站上 | ✅ **选这个** |
| On this site | 在 AMO 上列出 | ❌ 会进人工审核、公开列出 |

理由：只想拿签名做自托管。选「On this site」会走完整人工审核流程，慢得多，
而且会在 AMO 商店里公开出现（我们还没准备好商店素材）。

## 三、要填的字段

| 字段 | 填什么 |
| --- | --- |
| Name | `RequestTranslate` |
| Summary 摘要 | `用你自己的 HTTP 请求划词翻译。粘贴 curl 或原始报文，除占位符外不改写任何字节。` |
| Category | `Productivity`（生产力） |
| Privacy policy | 见下面「隐私政策链接」 |
| Support email | 你的邮箱 |
| License | MIT（已有 `LICENSE`） |

英文摘要（AMO 默认语言是 en，建议同时填）：

```
Selection translation using your own HTTP requests. Paste a curl command or a raw
request — nothing is rewritten except the placeholders.
```

## 四、隐私政策链接（必须是个 URL）

AMO 要 URL，不要文件内容。仓库里已有 `PRIVACY.md`，用 GitHub 的渲染直链：

```
https://github.com/KniphH/RequestTranslate/blob/main/PRIVACY.md
```

## 五、数据收集声明 —— 这是最容易踩雷的一栏

清单里已经写了（`browser_specific_settings.gecko.data_collection_permissions`）：

```json
"data_collection_permissions": { "required": ["websiteContent"] }
```

**为什么必须是 websiteContent、不能勾 none**：

本扩展会把用户选中的**网页文字**发给「用户自己配置的接口」。按 Mozilla 的定义，
只要数据在「扩展或本地浏览器之外」被处理，就算传输。勾 `none` 属于虚假声明，**会被拒**。

如果界面让选，照这个来：

| 选项 | 选吗 |
| --- | --- |
| 网站内容（websiteContent） | ✅ |
| 身份信息 / 个人通讯 / 健康 / 财务 / 位置 / 浏览历史 / 搜索记录 | ❌ 都不涉及 |

## 六、代码是否「压缩/混淆」

**答「否」**。实测包内代码只是剥掉了注释，没有 minify：

```
content.js     3022 行，平均行长 22 字符
options.js     3571 行，平均行长 24 字符
```

压缩过的代码会有极长的单行（几千字符）。我们最长 261 字符，正常代码。

## 七、提交后会怎样

1. **自动校验**（几十分钟到 24 小时），没有人工审核
2. 过了之后，开发者中心里会出现「下载签名的附加组件」按钮
3. **下载那个签名版 `.xpi`** —— 它比原来的大（Mozilla 往里塞了签名块）
4. 把签名版挂到 GitHub Releases

## 八、用户怎么装（写进 README 用）

```
1. 下载 request-translate-<版本>.xpi
2. 打开火狐，地址栏输入 about:addons
3. 点右上角齿轮 →「从文件安装附加组件…」→ 选中下载的 .xpi
4. 确认安装
```

或者直接把 `.xpi` **拖进火狐窗口**也行。

## 九、提交前自查

- [x] `gecko.id` 有：`requesttranslate@kniph.github.io`
- [x] `strict_min_version` 140.0（火狐 140+ 才认数据收集声明）
- [x] `web-ext lint` 0 error（33 条 warning 都是预期内的）
- [x] 双语 `_locales`（en / zh_CN）
- [x] `LICENSE`（MIT）+ `PRIVACY.md` 都在包里
- [ ] 隐私政策已推到 GitHub 的 main 分支并且能打开

## 十、之后：免网页签名（可选）

开发者中心 →「管理 API 密钥」生成 JWT，然后：

```bash
web-ext sign --api-key=<key> --api-secret=<secret> \
  --source-dir=C:/rtsrc --channel=unlisted
```

以后发版一条命令，不用点网页。
