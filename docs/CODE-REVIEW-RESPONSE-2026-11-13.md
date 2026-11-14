# 代码通读：核实与处置（第八版回应，2026-11-14）

> 上一轮我弄丢了一整批已完成的改动。本轮按 `git commit` 逐批固化重做，**全部回归**。
>
> 基线：`manifest.json` 1.3.2，`STORAGE_VERSION = 13`。
> **`npm test` 全量通过**：静态 2 + test-lib **1061** + test-engine 89 + test-strip 19 + e2e-ui **557**。

## 一、先把事故交代清楚

上一轮为定位一批 e2e 失败，我反复做了 `git stash push -u` → `pop` → `git checkout -- <file>`，
**把整批改好的东西覆盖掉了，且没有备份**。丢的包括：

- `content.js`：面板可见门禁、连拨守卫、多槽串台守卫、hidePanel 三件套、iframe 坐标
- `options.js`：`inline()`、`probed`、`langFiles`、`saveSeq`、重入闸、toggleSlot 合并、导入边界、**语言代码表 UI**
- `test-lib`：全部 i18n 行为断言

而 13 条 e2e 失败的真凶，最后定位到**我自己**改的那一行：

```js
if (retryBtn) retryBtn.disabled = false;   // 失败也能点 —— 那正是它的用途
```

它让失败态的「重试」永远可点，而 e2e 有一整套断言依赖「忙碌时重试被挡」。
失败信息（`textHits 33 → 33`、第二槽 body 为空）完全看不出是按钮 disabled 引起的。

**这轮的做法**：每完成一批立刻 `git commit`，不再在工作区反复试错。

## 二、五批回归（都可单独 revert）

| commit | 内容 |
| --- | --- |
| `7e40718` | 通读加固：i18n 校验、响应体上限、并发去重、打包隔离 |
| `596f36c` | i18n 注入面：`inline()` 白名单 + 语言包探测链 |
| `0ecfa2f` | 面板竞态：可见门禁 / 连拨守卫 / 多槽串台 / iframe 坐标 |
| `b9191d2` | 设置页：saveSeq / 重入闸 / toggle 合并 / 导入边界 |
| `745a8b4` | **语言代码表**（code ↔ {{target}} 可改可排可加行） |
| `64eb950` | 18 条行为断言 |

## 三、逐项对照 review 的结清判据

### P0

| 项 | 状态 | 证据 |
| --- | --- | --- |
| i18n 注入链（渲染侧） | **闭** | `inline()` 接两处动态 hint 出口；`blockHtml` 内 12 处 `escapeHtml(T(...))` |
| i18n 注入链（下载侧） | **闭** | `validatePack` 白名单 + 四上限；`fetchAny` 512 KB 上限，流式读超限即 cancel |
| `langFiles` 零声明 | **闭** | 补回 `const langFiles = {}`，实测语言下拉能列出 `en` |
| 模板字符串多余 `}` | **闭** | 包裹时写出 7 处字面 `}`，已全部修回 |
| `esc()` 引号 | **闭** | 五个字符全转，3 条断言 |
| `downloadPack` 字段 | **闭** | `(lang, file)` 用 `meta.file`；`verifyIndex` 同编码 |

### P1

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 面板可见门禁 | **闭** | `panelClosedByUser` 标志（**不用 `show` 判** —— 那会挡掉截图流程，实测 13 条） |
| `saveSeq` 假闭环 | **闭** | 比对挪到 `await` 之后（之前全同步，恒真） |
| `runOcrTest` 重入闸 | **闭** | 禁用提前 + `try/finally` |
| `renderSlotResult` 缺 leaveBusy | **闭** | `allSettled()` 才 `leaveBusy()` |
| 多槽串台 | **闭** | `renderResult` / `showFailure` 各加 `slots.length <= 1` |
| 连拨竞态 | **闭** | 拆成 `cfgSeq` / `langSeq` 两个独立守卫 |
| `runCtrls` key 口径 | **未闭，撤回修法** | 改成 `wantId` 会让回包 `configId` 对不上面板的槽，整批收不到结果（实测）。要治得连面板槽模型一起改 |
| `--target firefox` 与 verify-pack 冲突 | **半闭** | 输出名加了 `-firefox`，但 `verify-pack` 仍按后缀判形态 —— 需要让它认识 `-firefox.zip` |

### 功能（不是加固）

| 项 | 状态 |
| --- | --- |
| **语言代码表** | **闭** —— 27→31 行，可改名 / 排序 / 加行 / 恢复内置；下拉只显示名字；「其他（自己填）」和「它的名字」已删 |
| 地区变体进主表 | **闭** —— `LANG_REGION_VARIANTS` 并入 `LANGS`，故意不给内置名（留空 = `{{target}}` 用代码） |

## 四、18 条行为断言（review §4.1 门禁 1）

全部 `new Function` 抠真函数跑，不是源码正则、不是测试内复刻：

```
validatePack    8 条  真实包 PASS / 恶意包 REJECT / 白名单放行
sanitizeInline  5 条  保留标签 / 剥属性 / 转义非白名单
inline()        2 条  有 RTI18n 走白名单；没有则降级 escapeHtml
esc()           3 条  & / 双引号 / 单引号
```

## 五、验证

```
check-globals  22 文件
check-dom      通过
test-lib       1061 / 0
test-engine      89 / 0
test-strip       19 / 0
e2e-ui          557 / 0
──────────────────────────
合计           1728 项
```

`npm test` 组合命令跑过两次：首跑 1 条已知偶发（拖动落盘的 debounce 竞态），重跑 0 失败。

**未打包、未推送。**

## 六、还欠着的

1. `runCtrls` key 口径错配 —— 已退回 `cid` 并在断言里钉住现状，治它要改面板槽模型
2. `verify-pack` 不认识 `-firefox.zip` —— 需要按 `-firefox` 后缀判形态
3. `popup.js` 的 `onDelta` 无 `runSeq` 守卫（`run()` 本身已有 `try/finally`）
4. `lastFrameSel` 的 iframe 卸载分支未处理（低风险）