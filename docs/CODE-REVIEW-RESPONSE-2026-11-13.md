# 代码通读：核实与处置（第十七版回应，2026-11-15）

> 本版是 **kniph 火狐实测报的两个 bug** 的修复记录，加第九版剩余项的收尾。
>
> 基线：HEAD `a94f22b`，工作区干净。
> **全量汇总 2026-11-15 01:12:14**：test-lib 1095 ｜ test-engine 89 ｜ test-strip 19 ｜ e2e-ui 557 ｜ pack-fixture 2 = **1762 项**。

## 一、火狐实测报的两个 bug（都是真问题）

### 1. 「扩展已更新，请刷新页面后重试」刷不掉

#### 根因

**火狐的 MV3 后台是事件页（event page），不是 Chromium 的 service worker。**
事件页空闲约 30 秒就被系统回收，端口随之断开 —— 而旧代码在 `onDisconnect` 里直接
调 `portGone()`，界面就永远挂着那句提示。

**刷新之后事件页又睡回去，所以「刷新也没用」。**

#### 修

断开**不等于**出错。现在分两种：

```
· 空闲断开（busy 为假）→ 静默重连，用户无感
· 忙碌中断开 → 重连；连上了说明只是事件页被回收，
  那条请求已经没了，把忙碌态收回来并提示「请重新翻译一次」；
  连不上才是真错（扩展被禁用 / 卸载），走 portGone
```

另加防重入旗 `reconnecting` —— `handleDisconnect` 里会再调 `connectPort`，不挡会递归。

#### 实测

用 CDP 直接杀掉 service worker 再翻译：

```
第一次:      HTTP 200 · 1.5s · 结果正常
已尝试终止 SW
SW 回收后:   HTTP 200 · 1.1s · 结果正常   ← 没有出现「扩展已更新」
```

### 2. bilibili 在火狐上必定被风控拦

#### 根因

bilibili 需要特定的 `User-Agent` 和 `Origin`。原来**完全靠 `declarativeNetRequest` 补**，
而火狐包里的 DNR 已被剥掉（我上一轮做的），所以火狐上必然缺这两个头。

—— 这条是我上一轮引入的连带损伤：剥 DNR 时只想着「火狐没有这个 API」，
没想到 bilibili 那条配置正依赖它。

#### 修

把这两个头**直接写进配置模板**（文字和图片两处），运行时不需要任何浏览器 API：

```
POST https://index-translate.bilibili.com/v1/chat/completions
Content-Type: application/json
User-Agent: Index-Translate-Client/1.0 SnapCut/1.0
Origin: https://www.bilibili.com
```

DNR 规则保留作兜底（Chromium 上仍是双保险）。

实测 `parseRequest` 解析两个模板，三个头都在。

## 二、PRIVACY 英文段的事实错误（第八、九版都指出过）

英文那条写「Only the text you select … is sent」，与中文的「直传时整张图也发给它」
**直接矛盾**（事实错误，不是措辞差异）。

已补：

- 「With "disable external OCR" enabled for screenshot translation, the entire screenshot is also sent to it」
- 「The default selection is the Bing channel」

同时把中英两条关于 DNR 的说明都改成「头写在模板里，DNR 只是兜底」。

## 三、第九版剩余项（上一批已做）

| 项 | 做法 |
| --- | --- |
| `applyI18n` 二次调用冲掉动态标题 | 加 `opts.onlyMissing`：第一次打 `dataset.i18nDone` 标，第二次只看没打标的 |
| 删除配置只摘 `slotConfigs` | 两份名单都 filter；`ocr.imageConfigId` 悬空时退回第一条能翻图的 |
| `trigger-styles.js` 头注过时 | 还在说「content.js 手抄一份 TRIGGER_CSS」，2026-11-09 就合并了 |
| `DEFAULT_TRIGGER_SIZE = 45` | 与 `DEFAULT_SETTINGS.triggerSize = 28` 不符，改 28 |
| 合并导入同 id 双配置 | 按 name 覆盖却保留文件 id，撞车会产生两条同 id。加 usedIds |

### 主动放弃的一项

第九版提到「`test-lib` 里两个 check 嵌在另一个 check 的 IIFE 实参里」。

我写了个括号深度检测去定位，**报了 56 处，但抽样全是误报** ——
计数把后续平级的 `check(` 也算进了当前 check 的参数范围。

**检测逻辑本身不可靠，我没基于它改代码。** 这条留着。

## 四、验证

```
全量汇总  2026-11-15 01:12:14
  test-lib 1095 ｜ test-engine 89 ｜ test-strip 19 ｜ e2e-ui 557 ｜ pack-fixture 2
  合计 1762 项
```

```
zip 119,277 字节（116.5 KB）
xpi 118,334 字节（115.6 KB）
双包一致：29 个共同文件除 manifest 外逐字节相同（火狐包少 3 个 Chromium 专有文件）
与源码同源：21/21 个 .js 逐文件 md5 一致
```

### 新增 7 条断言

```
bilibili 文字模板自带 UA / 自带 Origin
bilibili 图片模板也自带这两个头
两个模板都能被 parseRequest 解析出三个头
端口断开时先重连（而不是直接 portGone）
重连失败才算真错
断开处理有防重入旗
```

## 五、这一轮的性质

前十六版是 review 驱动（它指、我改）。这一轮是**用户实测驱动** —— 两条都是真 bug，
而且**第二条是我上一轮自己引入的**：剥掉火狐包的 DNR 时，没想到 bilibili 配置正依赖它。

这是我最近几轮反复犯的同一类错：**改 A 的时候没检查 B 是否依赖 A**。
（OCR 顺序那次也是：加 pushOne 没删旧循环。）

## 六、仍未修

| 项 | 状态 |
| --- | --- |
| content 状态行几十处硬编码中文 | 没做，工作量大 |
| `test-lib` 的 check 嵌套 | 检测手段不可靠，主动放弃 |

**未推送。**