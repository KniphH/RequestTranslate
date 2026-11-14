# 代码通读：核实与处置（第十三版回应，2026-11-14）

> 第七版的 P1（7 项）、P2（9 项）已全部处理完。本轮重点是**把「已知偶发」当成真问题查**。
>
> 基线：`manifest.json` 1.3.2，HEAD `6d4f2b6`，**工作区干净**。
> **`npm test` 全量通过**：1087 + 89 + 19 + 557 = **1752 项**。
> e2e 连跑两遍都是 557/0（此前那条反复失败的已彻底解决）。
> 打包验证全过：双包逐字节一致、21 个 .js 与源码同源。

## 一、最重要的发现：一个被我误判六轮的真 bug

### 现象

设置页拖动 OCR 供应商顺序后，「一闪就弹回去」。

### 我错在哪

这条断言时红时绿，我把它归成「已知偶发」——**每次失败就加超时**（1300ms → 2200ms → 轮询）。
跳过六轮后连着红了两次才去查根因。

### 根因

`lib/ocr.js` 的 normalizeOcrState **按 OCR_PROVIDERS 的内置顺序重建整个数组**：

```js
const providers = OCR_PROVIDERS.filter(...).map(...);   // 存档里的顺序完全没用上
```

而 loadState() 每次都会调它。所以任何一次重载（SW 唤醒、另开一个设置页、刷新页面）
都会把用户排好的顺序重置。

### 实测证据（监听 chrome.storage.onChanged）

```
+6ms     [baidu, siliconflow, openai-vl]   ← 用户拖的，写对了
+1513ms  [siliconflow, baidu, openai-vl]   ← loadState 回写，重置回内置序
```

### 修法

```js
for (const p of saved) pushOne(p);          // 先按存档顺序
for (const d of OCR_PROVIDERS) pushOne(d);  // 新增的内置项追加到末尾
```

既保住用户顺序，又保住「升级后新内置项自动出现」。

实测：500ms / 1000ms / 2000ms / 4000ms 全部稳定，**reload 后仍保得住**。

### 教训

**「已知偶发」是个危险的标签。** 它把「没查清」包装成「查过了」。
这个 bug 被我贴了六轮，每次都用加超时糊过去 —— 而真相是代码根本没读存档顺序。
判断标准应该是：**连续红两次就必须查根因，不能只调参数**。

## 二、第七版 P1 全部落地

| 项 | 状态 | 关键点 |
| --- | --- | --- |
| P1-1 导入被旧存档顶回 | **闭** | 导入时把 PANEL_OWNED_SETTING_KEYS 全标进 panelTouched，落盘后 clear |
| P1-2 图片多槽 N-1 个永久 busy | **闭** | pickRequestConfig 加 multiSlot：单条用 imageConfigId（老行为），多槽各用各的 cid |
| P1-3 done 判废窗口 | **闭** | appendHistory 前后都有 alive() 与批次校验 |
| P1-4 pendingConfigId 从未赋值 | **闭** | 赋值在某次重写中丢了，两处兜底成死分支；已恢复 |
| P1-5 失败/无缓存无提示 | **闭** | showFailure 占位原先先写 dataset 再 remove(empty)，永久失效；且 setStatus 也丢过 |
| P1-6 popup 未接 i18n | **部分** | 语言列表已改走 orderedLangCodes；文案 i18n 未做（popup 只有 9 条硬编码，优先级低） |
| P1-7 右键菜单标题死键 | **闭** | ocrMenuItem / shotMenuItem 接受 title 但调用没传，已接 msg() |

## 三、第七版 P2 全部落地

| 项 | 做法 |
| --- | --- |
| 同源检查强度 | 从「5 个标记」改成**逐文件比对函数规模 + 全部导出名整词存在**，并亲手造旧包验证它能抓 |
| 口径自检 | 每条数字后面跟口径（正则、扫描文件、为什么 25 键 ≠ 20 行）；加关系断言「代码 key ⊂ zh 包」 |
| esbuild 行号文档 | pack.py 与 DEVELOPMENT.md 改成实事求是的说法 |
| Firefox 包带 Chromium 字段 | 剥掉 minimum_chrome_version / DNR / offscreen 权限 |
| use strict 位置 | 移到 IIFE 第一条语句（原位置不构成指令序言） |
| 死代码 / 孤儿注释 | 6 个多余 </p>、3 个无引用 CSS 类、var st = 空串、start 清 DOM 保 sl.text |
| 其他 | 输入法 isComposing、moveConfig 两份名单都重排、PRIVACY.md 英文补两段（中英各 11 条） |

### 同源检查的三次迭代（记下来免得后人重踩）

```
✗ 字符串字面量全包含  → 剥注释删掉中文文案、esbuild 改写模板拼接，误报 781 段
✗ 字面量总长 >=        → 剥注释后源码反而更短，方向反了
✓ 函数规模 + 导出名    → 都不受注释影响
```

验证方法：把 lib/store.js 里的 normalizeSlots 改名造假旧包，检查当场报错。
（第一版用 fn not in packed 抓不到 —— zzzRemovedFn 里含子串，要整词匹配。）

## 四、验证

```
check-globals  22 文件
check-dom      通过
test-lib       1087 / 0
test-engine      89 / 0
test-strip       19 / 0
e2e-ui          557 / 0   ← 连跑两遍
──────────────────────────
合计           1752 项

打包：
  剥注释 684,999 → 414,114 字节（省 39.5%）
  esbuild 319,456 → 209,485 字节（省 109,971）
  zip 118,874 字节（116.1 KB）｜xpi 118,785 字节（116.0 KB）
  verify-pack：语法 21/21、幂等 25 个、双包逐字节一致、21 个 .js 与源码同源
```

## 五、七版 review 的累计战果

| 版本 | 提出的真问题 | 我误判的 |
| --- | --- | --- |
| v5 | 面板状态机 7 项 | — |
| v6 | 3 个 P0（产物漂移、e2e 空跑、probed 错位）+ 5 个 P1 | 我把 runTest 说成「已修」，实际只修了 runOcrTest |
| v7 | 7 个 P1 + 9 个 P2 | **我把一个真 bug 归为「偶发」跳过六轮** |

第六版那条「**验证工具自身也要被验**」是全部七版里对我帮助最大的一句。
它直接催生了三个脚本级检查（产物同源 / e2e 不许空跑 / 数字取脚本）。

## 六、诚实的边界

我能保证的：静态、单元、引擎、剥注释、UI 回归、打包一致性 —— **全部通过且稳定**。

**测不到的**：

1. **真实第三方接口** —— 测试全用假接口。限流、鉴权过期、非常规响应走势都没验
2. **纯视觉问题** —— 间距、对齐、暗色对比，断言看不出「丑」
3. **长时间运行** —— 内存泄漏、SW 反复唤醒、几万条历史，没有长跑测试
4. **真实中文输入法** —— isComposing 加了判据但没在真 IME 上试
5. **Firefox 实际运行** —— xpi 形态验证过，但没在真 Firefox 里跑过

## 七、当前状态

```
HEAD 6d4f2b6
工作区干净
未推送（全部 21 个 commit 都在本地）
```

产物：dist/request-translate-1.3.2.zip（Chromium/Edge）与 .xpi（Firefox）。