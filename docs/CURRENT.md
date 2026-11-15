# 当前状态（单一事实来源）

> 只看这一份。历史叙事已删；决策与踩坑见 [`HISTORY.md`](./HISTORY.md)，待办见 [`TODO.md`](./TODO.md)。
> 最后更新：2026-11-15 深夜，对应 `manifest.json` 的 **1.3.2**。

## 一、怎么验证

```bash
npm run test:lib      # 解析 / 模板 / 适配器 / OCR（约 1156 项）
npm run test:engine   # 本地假服务器，各类响应格式（约 89 项）
npm run test:ui       # 真 Edge 加载扩展，UI 几何与交互（约 558 项）
npm run check          # 两项静态检查
npm test               # 全量：以上 + 打包夹具 + 汇总（**只在打包 / 发版前跑**）
python tools/pack.py --xpi
python tools/verify-pack.py dist/<zip>
python tools/mutation-test.py   # 变异测试：注入 20 个 bug，看断言能不能抓住
```

平时只跑受改动影响的那一层；全量交给 `pack.py`。

## 二、现状

| 项 | 值 |
|---|---|
| 版本 | 1.3.2（`manifest.json`，唯一来源） |
| 包体积 | zip 约 123 KB / xpi 约 122 KB（32 个文件） |
| 断言 | 各层合计约 1835 项（打包时以末尾汇总为准） |
| 语言 | 只内置中文；英文等语言包从仓库下载，**不进包** |
| 双包 | zip / xpi 29 个共同文件逐字节一致，与源码逐文件 md5 对齐 |

## 三、怎么算「达标」

**不拿「还有多少未知 bug」当标准** —— 那是不可知量，取决于未知输入，不取决于代码质量。
只判可判定的：

| 项 | 达标条件 | 现在 |
|---|---|---|
| 已知问题 | 台账清零；每条都能「指一条命令复核」 | ✅ |
| 断言 | 注入 20 个 bug 必须全被抓（`python tools/mutation-test.py`） | ✅ 20 / 20 |
| 数字 | 绑 HEAD、带时间戳、留档，不手写 | ✅ `.test-counts.json` |
| 错误路径 | 用户看得到的错误都按语言显示 | ✅ 16 条 key |
| 包 | 双包一致、与源码同源、篡改报红 | ✅ 实测 |
| 文档 | 现状 + 决策踩坑 + 待办，各一份 | ✅ 本文件 + HISTORY + TODO |

**以上全部达成为 A。**「以后会不会冒新 bug」不参与评分。

## 四、已经做完（用户可感知）

- 面板：↻ 空态不再误读剪切板；切语言后状态行 / 悬停提示跟着变；「重试」与「重新翻译」拆开。
- 火狐：后台回收后自动重连；bilibili 通道把 UA / Origin 写进模板，绕开风控。
- 英文界面：语言代码表说明、OCR 配置标题、新供应商、加一行、收起、值（一行一个）、
  popup 整页都会跟着切；popup 顶部重复入口已删；语言代码表说明可「不再显示」。
- 诊断 / 报错：测试 badge、无内容提示、剪切板错误、Bing 失败、模板解析提示、
  取消 / 发送失败 / 读响应失败——都按语言显示。
- 验证器：同源检查抓旧包与被改的语言包；夹具去掉兜底；白屏检测可证伪；数字绑 HEAD。

## 五、明确不管 / 等信号

| 事项 | 结论 |
|---|---|
| Firefox 长尾（后台回收、放一天卡不卡） | 只靠长期使用暴露，等反馈；bilibili 已验证正常 |
| 视觉（间距 / 对齐 / 暗色） | 已微调多次，且给了自定义 CSS 的权力；有问题再说 |
| 真实接口的限流 / Key 过期 / 代理掐接口 | 属于服务商与用户侧，扩展只保证「如实显示错误」 |
| `store` / `template` / `ocr` 的内置配置文本 | 保持中文：那是给用户编辑的模板，翻了反而不好改 |
| 本地 OCR（Tesseract.js） | 等明确需求（+5.8 MB 与体积原则冲突），见 TODO |

## 六、文档地图

| 文件 | 用途 |
|---|---|
| `CURRENT.md` | 本文件：现状 + 判定标准 |
| `HISTORY.md` | 设计原则、关键决策、踩坑清单 |
| `TODO.md` | 在等信号的事、已否决的事 |
| `tools/mutation-test.py` | 变异测试：一次注入 20 个 bug，验证断言盲区 |
| `DEVELOPMENT.md` | 实现细节、目录结构、测试与开发流程 |
| `BILIBILI-TRANSLATE.md` | 内置 bilibili 通道怎么工作 |
| `CUSTOM-PANEL-*.md` | 面板自定义（折叠 / 悬浮 / 演示） |
| `RELEASE-1.3.2.md` | 这一版的更新说明 |

## 七、发版流程

1. 改 `manifest.json` 的 `version`
2. `python tools/pack.py --xpi`（内部跑全量）
3. `python tools/verify-pack.py dist/<zip>` 与 `.xpi`，都应「全部通过」
4. 推送 git、挂 GitHub Release（附 zip + xpi）
5. 商店：Edge 传 zip、Firefox 传 xpi（需手动登录后台上传）
