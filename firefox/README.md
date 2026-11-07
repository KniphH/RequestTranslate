# RequestTranslate 火狐调试环境

**火狐本体不在这个目录里**（原因见下），这里只留三样东西：

| 路径 | 是什么 |
| --- | --- |
| `_probe/` | API 行为探测扩展 —— 验「chrome.* 返不返回 Promise」那个待验用 |
| `ANALYSIS.md` | 火狐移植分析报告 |
| `README.md` | 本文件 |

---

## 火狐在哪、怎么启动

```
C:\rtff\
```

**双击 `C:\rtff\启动火狐.vbs` 启动**（无窗口，且进出各清一次系统里的残留）。

```
C:\rtff\
  app/                 Firefox 159.0.1 程序
  profile/             用户数据（user.js 预置设置）
  启动火狐.vbs          主启动器
  start-firefox.cmd     备选（给禁用 VBScript 的环境）
```

---

## ⚠️ 为什么火狐不能放在项目目录里

**路径一长，Firefox 就起不来**（2026-11-07 实测）：

| 路径 | 字符数 | 结果 |
| --- | --- | --- |
| `C:\rtff\app\firefox.exe` | **23** | ✅ 正常：10 个进程、窗口开出来 |
| `C:\Users\Administrator\WorkBuddy\rt-firefox\app\firefox.exe` | **59** | ❌ 崩 |

崩溃时 Windows 弹：

```
firefox.exe - 应用程序错误
0x00007FF717900CD2 指令引用了 0x0000000000000000 内存。该内存不能为 read。
```

Firefox 自己的 stderr 是：

```
[Parent 47696, IPC I/O Parent] WARNING: Failed to launch gpu subprocess
  @SB::LA::SpawnTarget (Error:-2147024891)
  file checkouts\gecko\ipc\glue\GeckoChildProcessHost.cpp:993
```

`-2147024891` = `0x80070005` = **拒绝访问** —— Firefox 的沙箱创建 GPU 子进程失败，
随后空指针崩溃。

### 已确认的与未确认的

- **路径长度**：已确认。同一个 exe、同一台机器，23 字符能跑、59 字符必崩。
- **中文**：本项目目录名「翻译插件」也含中文，但**没能单独验证**它的影响 ——
  因为没法把项目路径变短来隔离这两个变量。
- 稳妥做法是**两个都避开**：短 + 纯英文。`C:\rtff` 两个条件都满足。

### 走过的弯路（别再重复）

我一开始把崩溃归因于「执行环境受限」，后来又怪到「解包损坏」，两次都不对：

- 用 `7za` 解 MSI / NSIS 解出来的文件，与官方安装器解出来的**逐字节一致**
  （76 文件、374 MB 都对得上）—— 解包没问题。
  `omni.ja` 用 Python `zipfile` 和 7za 都打不开，那是 **Firefox 的特殊布局**
  （中央目录在文件开头），不是损坏。
- 真正的原因是路径；换到短路径后**立刻就正常了**。

---

## 怎么用它验待验 #1

1. 双击 `C:\rtff\启动火狐.vbs`
2. 地址栏输入 `about:debugging#/runtime/this-firefox`
3. 点 **临时载入附加组件…**，选本目录的 `_probe\manifest.json`
4. 约 1 秒后自动弹出一个深色结果页，把那块文本贴回来
