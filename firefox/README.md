# RequestTranslate 便携火狐（绿色版）

Firefox **159.0.1** 的免安装版，专门用来调试本扩展的火狐移植。
整个浏览器连同用户数据都在这一个文件夹里，不在外面留东西。

---

## 怎么启动

双击 **`启动火狐.vbs`**。

首次启动会直接开窗口，没有导入向导、不询问默认浏览器、不弹欢迎页（`profile/user.js` 里关掉了）。

> 如果双击 `.vbs` 没反应（某些组策略会禁用 VBScript），改用 **`start-firefox.cmd`** ——
> 功能一样，代价是会挂一个黑窗口直到火狐关闭。

## 文件夹结构

```
firefox/
  app/                  Firefox 程序本体（374 MB，从官方 MSI 解出来的）
  profile/              用户数据全在这儿
    user.js             预置设置：关遥测/上报/自动更新/首启打扰，见下
    prefs.js            火狐自己写的当前设置
    cache2/ Temp/ ...   缓存、临时文件
  启动火狐.vbs           主启动器（无窗口 + 进出各清一次残留）
  start-firefox.cmd      备选启动器（给禁用 VBScript 的环境）
  ANALYSIS.md            火狐移植可行性分析报告
  README.md              本文件
```

## ⚠️ 一个必须知道的坑：Firefox 会在外面建三个空目录

**即使 profile 已经锁在文件夹内**，Firefox 每次启动都还会在系统里建出：

```
%APPDATA%\Mozilla\Firefox\Crash Reports
%APPDATA%\Mozilla\Firefox\Pending Pings
%LOCALAPPDATA%\Mozilla\Firefox
```

这几个位置来自 Windows 的 **Known Folder API**（读注册表），所以下面这些办法**全部无效**（都实测过）：

| 试过的办法 | 结果 |
| --- | --- |
| `-profile` 指向文件夹内 | 只改 profile，**不改用户数据目录**，目录照样建 |
| 改 `APPDATA` / `LOCALAPPDATA` 环境变量 | Known Folder API **不读环境变量**，无效 |
| `MOZ_CRASHREPORTER_DISABLE=1` | 它禁的是**上报**，不是建目录 |
| 把 `crashreporter.exe` / `crashhelper.exe` 改名 | **不是它们建的**，无效 |
| `profile/user.js` 里关遥测 | 内容不写了，但目录**还是建** |

**好消息**：这三个目录是**空的**（0 个文件）—— 遥测和崩溃上报确实被 `user.js` 关掉了。

**所以启动器不跟它对抗，改成两头各清一次**：

- 启动前：先清掉上次可能残留的
- 火狐退出后：再清一次

结果就是**外面什么都不会留下**。这也是这个启动器必须是 `.vbs` 的原因 ——
需要在火狐退出后执行动作，就得「等它结束」，而 `.cmd` 的 `start /wait` 会挂一个黑窗口。

### 安全闸

启动器在动手清理前会检查 `%APPDATA%\Mozilla\Firefox\profiles.ini`。
**如果这台机器上装过真正的 Firefox**，它会弹窗告知并**完全不动那个目录**，
避免误删你已有的书签和密码。便携版本身照常启动。

## 预置设置（`profile/user.js`）

每次启动都会重新应用，所以改了这里就等于改了默认值：

- **关掉对外上报**：遥测、崩溃上报、`Pending Pings`、ping-centre
- **关掉自动更新**：绿色版不该在文件夹外下载东西
- **关掉首次运行打扰**：默认浏览器询问、欢迎页、导入向导
- `xpinstall.signatures.required = false` —— 方便本地测扩展。
  **注意**：Release 版会忽略这一条，只有 Developer Edition / Nightly / ESR 才认。
  在这台 Release 版上装未签名扩展请用下面的 `about:debugging` 方式。

## 怎么加载本扩展调试

1. 启动火狐，地址栏输入 `about:debugging#/runtime/this-firefox`
2. 点 **「临时载入附加组件」**
3. 选仓库根目录的 `manifest.json`

> **注意**：当前的 `manifest.json` 还是 Chromium 取向的（`background.service_worker`），
> 火狐**不认**这个键，后台起不来。要真正跑起来需要先做移植改动 ——
> 结论与步骤见 **`ANALYSIS.md`**。

改完代码后：在 `about:debugging` 里点该扩展的 **「重新载入」**，再刷新测试页面。

---

## 验待验 #1：火狐的 `chrome.*` 到底返不返回 Promise

`ANALYSIS.md` 里最要紧的那条待验 —— 它决定移植方案里 23 处 `await chrome.*` 要不要全改。
脚本在 `_probe/`，是一个最小扩展。

**步骤（约 1 分钟）**：

1. 双击 **`启动火狐.vbs`**
2. 地址栏输入 `about:debugging#/runtime/this-firefox` 回车
3. 点 **「临时载入附加组件…」**，选 `firefox/_probe/manifest.json`
4. 约 1 秒后自动弹出一个深色页面，标题是 **RT Firefox Probe —— 结果**
5. 把那一整块文本复制回给助手

**这个探测扩展顺带还回答两件事**：

- **`background.scripts` 能不能被火狐接受** —— 能加载起来就说明能，这是「一份 manifest 通吃」的前提（待验 #2）
- **`chrome.offscreen` 在火狐里是什么形态**（预期 `undefined`），决定 background.js 里那个分支怎么写

扩展只在临时载入期间存在，**火狐一关就没了**，不往你机器上写任何东西。
它的 manifest 用的是 `background.scripts`（不是 `service_worker`），因为火狐不认后者 —— 这正是它能跑起来的原因。

### 结果怎么读

关注这几行：

```
chrome.storage.local.get() 返回 Promise：是 / 否    ← 最关键
chrome.tabs.query() 返回 Promise：是 / 否
chrome.runtime.getPlatformInfo() 返回 Promise：是 / 否
chrome.offscreen 存在：undefined                    ← 预期 undefined
browser 命名空间：object                            ← 预期存在
```

如果**全是「是」**，移植量会小很多：23 处 `await` 一行都不用动，`lib/ext.js` 也不必存在，主要工作只剩 manifest 和 offscreen 两处。

## 怎么升级 Firefox

现在是 159.0.1。升级步骤（保持「不写注册表」）：

```bash
# 1. 下载新版 MSI
#    https://ftp.mozilla.org/pub/firefox/releases/<版本>/win64/en-US/
#    文件名形如 "Firefox Setup 159.0.1.msi"

# 2. 解包（需要 7-Zip；官网 https://www.7-zip.org/a/7za920.zip 里的 7za.exe 是独立单文件）
7za.exe x "Firefox Setup <版本>.msi" -oapp -y

# 3. MSI 里的程序在 core\ 下，提上来，删掉 setup.exe
cd app && mv core/* . && rmdir core && rm setup.exe
```

**profile 不用动**，升级后设置和扩展都还在。

## 关于调试窗口的位置

如果把火狐当测试浏览器用，注意本机是双屏：

- 主屏 `\.\DISPLAY1`：`0,0`，1707×960
- **副屏 `\.\DISPLAY4`：`-933,-287`，933×1493（竖屏，在主屏左边）**

火狐首次启动的窗口位置由系统决定，可能开在主屏。拖到副屏后位置会被记在
`profile/xulstore.json` 里，以后就在那边开。