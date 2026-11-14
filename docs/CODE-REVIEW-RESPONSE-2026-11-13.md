# 代码通读：核实与处置（第九版回应 · 全项目通读，2026-11-14）

> 按 kniph 要求「通读整个项目直到没问题为止」，本轮**逐层验证**并修掉通读发现的问题。
>
> 基线：`manifest.json` 1.3.2，`STORAGE_VERSION = 13`。
> **`npm test` 全量通过**：静态 2 + test-lib 1043 + test-engine 89 + test-strip 19 + e2e-ui 557 = **1710 项**。
> **打包验证通过**：21 个 js 语法、双包逐字节一致（32 文件）、幂等；118,296 字节（115.5 KB）。

## 一、通读方法与范围

不是「再看一遍代码」，而是**七类交叉验证**：

| 层 | 手段 | 结果 |
| --- | --- | --- |
| 结构 | 157 个文件全量清点（52,857 行），剔除非运行时目录 | 见 §2 |
| 引用完整性 | manifest 15 项引用 → 逐个查文件存在 | **全通过** |
| 文案一致性 | 265 个 key × zh/en 双向对照 | **全通过** |
| 设置项覆盖 | 20 个 `DEFAULT_SETTINGS` 键 → 是否有 UI 入口 | **全通过** |
| 契约一致性 | engine 与 adapters 的返回形状逐字段比对 | **全通过**（19 字段） |
| 资源泄漏 | 27 处 addEventListener / 4 处 setTimeout 的清理配对 | **全通过** |
| 运行时行为 | 浏览器真跑：设置页 / popup / 划词 / 单槽 / 多槽 | **全通过** |

## 二、通读发现并修掉的问题

### P0 · popup 的目标语言下拉整个是空的（实测 0 项）

`popup.html` 里没有 `#lang` 元素、`popup.js` 里没有任何填充逻辑 —— **上一轮事故把它整块带走了**。

修：

- HTML 加 `<select id="lang" class="lang-sel">`，CSS 按内容定宽（5.5em ~ 7.5em），不跟配置下拉抢地方
- JS 加 `langNameOf()`（读 `settings.targetNames`，popup 没有 `T()` 所以直接问 `chrome.i18n`）
- 填充 + change 写回 `settings.targetLang`

实测：**31 项，当前 ZH-HANS，顶栏溢出 0px**。

### P1 · popup 的 `run()` 无 try/finally、`onDelta` 无守卫

`runRequest` 抛异常时 `goBtn` 永久禁用；连点两次时旧那轮的 delta 仍会写界面。

修：加 `runSeq`（旧轮作废，含 `onDelta` 内部）+ 整段包 `try/finally`。

### P2 · 文档数字与说明过时

- `docs/DEVELOPMENT.md`：1699 → **1710**、1029 → **1043**、555 → **557**
- `README.md`：Firefox 那段说清「**必须用 xpi 解压后那份 `manifest.json`**」——
  仓库这份只有 `service_worker`（Chromium 形态），火狐不认

### P3 · 工具目录清理

删掉通读中发现的临时文件：`tools/_testlib_mine.mjs`（272 KB 备份残留）、`tools/_k.mjs`、`tools/_fixre.mjs`。
`lib/panel-styles.js` 是**刻意保留**的退役说明（`export {}`），不删。

## 三、检查过但**判定为不需要改**的

| 现象 | 判定 |
| --- | --- |
| 空 catch 26 处 | 都有前置注释说明理由（端口断开 / canvas 失败 / 选区读不到），是**刻意的兜底**，不是漏写 |
| `applyTheme` 3 份、`esc` 3 份、`formatBytes` 2 份 | 上下文不同（content 作用于 shadow DOM、options/popup 作用于页面），收编收益低于风险 |
| `addEventListener` 27 处但 `removeEventListener` 只 2 处 | content script 与页面同生命周期；真正会重复触发的（`startShot`）**有** `finish()` 清理 |
| `extract.js` / `request-parser.js` 无直接 import | 被 `engine.js` / `ocr.js` **间接**引用，链路完整 |
| `from < 9` 缺失 | v8→v9 无数据变更，跳过不是 bug |
| `rt-get-zoom` / `ocr-error` content 发了但 bg 没 handler | 前者走 `onMessage` 不走 port；后者源码里明确注释「已废弃」 |

## 四、逐项验证结果

### 引用完整性

```
manifest 15 项引用全部存在
  background.service_worker / content_scripts.js[3] / icons[5]
  action.default_popup / options_ui.page / dnr.rule_resources
```

### 文案一致性

```
代码里用到 265 个 key
zh 缺: 无        en 缺: 无
英文包 365/365 覆盖，无空值
数据属性：data-i18n 118 / data-i18n-html 12 / data-i18n-ph 5 / data-i18n-title 9
同时带 data-i18n 和 data-i18n-html 的元素: 0（不冲突）
```

### 契约一致性

```
engine.runRequest    19 字段
adapters.emptyResult 19 字段 —— 逐字段一致（field 名与顺序都相同）
ocr.runOcr           返回 { text, ms, status, raw, request, warnings, from }
                     —— 独立子系统，消费者只用 text/ms，不构成契约违反
```

### 订阅清理

```
startShot: window.addEventListener(keydown/contextmenu)
           → finish() 里成对 removeEventListener ✓
ResizeObserver 2 处，都 observe 面板本身（随面板销毁）
setInterval 0 处
```

### 运行时真跑

```
设置页     配置 8 / 页签 4 / 语言表 31 行
popup      配置下拉 8 / 语言下拉 31 / 顶栏溢出 0px
划词       小圆点 28px（正确）
单槽翻译   HTTP 200 · 1.3s · 拿到译文
多槽对比   2 槽各拿自己的译文（译文-1 / 译文-2）
           请求正好 2 次、状态「2 条都拿到了译文」、灯 rt-dot ok
页面错误   无
```

## 五、打包验证

```
剥注释：674,873 → 411,636 字节（省 39.0%）
esbuild：316,903 → 207,973 字节（省 108,930）
zip：32 个文件，118,296 字节（115.5 KB），魔数 PK ✓
xpi：32 个文件，118,287 字节（115.5 KB），魔数 PK ✓

verify-pack：
  语法：21 个 js 全过 node --check
  行号：20 个文件被压缩过（符合预期）
  幂等：25 个文本文件「再剥一次毫无变化」
  background：service_worker + type:module（.zip 形态正确）
  双包一致：与 .xpi 除 manifest 外逐字节相同（32 个文件）
  全部通过 ✓
```

## 六、诚实的边界

「直到没问题」我能保证的范围：

- **静态层**：语法、引用、文案、契约、订阅清理 —— 全过
- **行为层**：单元 1043 + 引擎 89 + 剥注释 19 + UI 557 —— 全过
- **运行时层**：浏览器真跑 5 条主链路 —— 全过
- **打包层**：语法、幂等、双包一致 —— 全过

**测不到的两类**：

1. **纯视觉问题**（间距、对齐、暗色对比）—— 只能你亲眼看
2. **真实第三方接口**（Bing / DeepL / 各家模型）—— 测试用假接口，真接口的边界情况（限流、鉴权过期、非常规响应）测不到

## 七、当前提交

```
65a9c23  通读收尾：文档数字与 Firefox 说明
b8f8bb5  通读：补回 popup 的目标语言下拉 + 连点防护
64eb950  补回行为断言：18 条真跑生产函数
745a8b4  review 回归 4/4：语言代码表
b9191d2  review 回归 3/4：设置页保存链与并发
0ecfa2f  review 回归 2/4：面板竞态
596f36c  review 回归 1/4：i18n 注入面加固
7e40718  通读加固：i18n 校验、响应体上限、并发去重、打包隔离
```

**未推送。** 工作区干净（`git status` 无改动）。