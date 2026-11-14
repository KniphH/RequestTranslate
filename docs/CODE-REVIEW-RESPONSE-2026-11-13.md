# 代码通读：核实与处置（第十一版回应，2026-11-14）

> 第六版的三个 P0 上一轮已修；本轮把 **P1 全部修完**。
>
> 基线：`manifest.json` 1.3.2，HEAD `e32320a`。
> **`npm test` 全量通过**：1073 + 89 + 19 + 557。
> 打包：118,584 字节（115.8 KB），`verify-pack` 全部通过（含同源校验）。

## 一、P1 五项，全部落地

### 1. 占位文案不显示（最影响观感）

第六版抓得准：CSS 是 `.rt-out.empty::before { content: attr(data-placeholder) }`，
而 `enterBusy` 先 `remove("empty")` 再写 `dataset.placeholder` → **占位符永远不显示**。

受影响的三处提示：

- 「等待结果…」（`enterBusy`）
- 「点 ↻ 翻译」（`showNoCachedResult`）
- 「出错了」（`showFailure`）

只有 `start` 那条路径顺序是对的，所以之前偶尔能看到 —— 掩盖了这个 bug。

修：写 placeholder 和加 `empty` 必须成对。三处都改了。

### 2. `runTest` 重入窗口 —— 我上一版的说法是错的

上一版回应我写「已修」，实际**只修了 `runOcrTest`**，`runTest` 原封不动：

```js
if (btn.disabled) return;   // 检查
collectEditor();
await persist(false);       // ← 这期间按钮还能点
btn.disabled = true;        // ← 太晚
```

第六版说「与『已修』的说法相反」，这句我认。修：禁用提到最前 + `try/finally`。

### 3. `frame-bridge.js:83` 空引用崩溃

iframe 在消息发出后被移除（或来自 srcdoc 中转）时，`querySelectorAll` 找不到 → `fr` 为 `null`
→ `fr.left` 抛 `TypeError` → **整条桥接链从这层断掉**，上面几层全收不到选区。

修：`if (!fr) return;`

### 4. CSS 变量名拼错（静默失效）

```
.rt-slot-h     color: var(--rt-fg-dim)   ← 定义的是 --rt-text-dim
.rt-slot-name  color: var(--rt-fg)       ← 定义的是 --rt-text
```

拼错**不会报错**，只是失效成继承色 —— 槽位头的灰、配置名的正常色都没生效。

顺带扫了全部 CSS 变量：**用了但没定义且无 JS 来源的，0 个**。

### 5. `done`/`fatal` 的 `if (!sl)` 不再无条件 `leaveBusy()`

一条流被删槽/挤出时，其它在飞槽会一起失去 busy 保护（`portGone` 不触发、防连点失效）。
改成 `if (allSettled()) leaveBusy();`。

## 二、新增 8 条防回归断言

```
占位文案的 CSS 依赖 .empty
enterBusy 写 placeholder 后立刻加 empty
showNoCachedResult 同样成对
if (!sl) 分支不再无条件 leaveBusy（要 allSettled）
frame-bridge 找不到 iframe 时提前 return
runTest 禁用按钮在 await 之前
runTest 有 finally 保证按钮恢复
panel-core 里没有拼错的 --rt-fg / --rt-fg-dim
```

**第 6 条写的时候自己坑了一次**：断言里搜 `await persist` 的位置，
结果匹配到了**注释里的**「以前禁用写在 `await persist()` 之后」那句话 ——
第一次跑就红了，而代码是对的。改成**先剥注释再比对**才准。

## 三、验证

```
check-globals  22 文件
check-dom      通过
test-lib       1073 / 0   （+8 条）
test-engine      89 / 0
test-strip       19 / 0
e2e-ui          557 / 0
verify-pack     全部通过（含「与源码同源」5 个标记）
```

```
zip：118,584 字节（115.8 KB）
xpi：118,575 字节（115.8 KB）
```

## 四、仍欠着的

| 项 | 原因 |
| --- | --- |
| ② `cfgSeq`/`langSeq` 作废不回滚 | 作废分支只 `return`，而 `currentConfigId`/`slots` 在 await 前已改。要回滚得先快照，属结构性改动 |
| ⑥ `cacheKey` 不是真指纹 | 「长度 + 末 64 字符」，极端情况下同图不同位置会误判。改真哈希要引 crypto |
| ⑦ `TRIGGER_CSS` 死代码 / 孤儿注释 | 纯清理，P2 一批做 |
| 数字与口径自检 | 第六版建议让脚本打印并对账（项数/字段数/key 覆盖），尚未做 |
| `loadPack` 不过 `validatePack` | 我仍认为不必要（唯一写入口已校验），但第六版归为「论证不全」，保留分歧 |

## 五、对第六版的判断

这一轮它指出的 **5 项 P1 全部成立**，没有一条是误报。特别是：

- **占位文案**：这是用户每天都看得到的东西，而我的测试全绿 —— 因为断言只看 `textContent`，
  而占位符是 CSS `::before` 渲染的，取不到
- **`runTest` 我说已修**：这条最该被指出，我把两个函数的修复混为一谈了

它提的"验证工具自身也要被验"这个视角，是这六版里最有价值的一条。
上一轮我据此加了「产物与源码同源」检查，这一轮又用它自检了「断言是否被注释骗过」。

**未推送。** 工作区干净。