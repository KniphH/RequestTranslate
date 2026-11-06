// ── 绿色版火狐：不往外写数据 ──────────────────────────────────────
// profile 用 -profile 锁在文件夹内，但 Firefox 还会在 %APPDATA%\Mozilla\Firefox
// 下建两个**属于用户数据目录而非 profile** 的目录：Crash Reports 与 Pending Pings。
// 这两个位置由 Windows 的 Known Folder API 决定（读注册表），改 APPDATA 环境变量无效。
// 下面这些 pref 是能关掉它们内容的部分；目录本身仍会被 Firefox 创建（已知限制，见 README）。
// ──────────────────────────────────────────────────────────────

user_pref("browser.crashReports.unsubmittedCheck.enabled", false);
user_pref("browser.crashReports.unsubmittedCheck.autoSubmit2", false);
user_pref("breakpad.reportURL", "");
user_pref("browser.tabs.crashReporting.sendReport", false);

user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("toolkit.telemetry.archive.enabled", false);
user_pref("toolkit.telemetry.server", "data:,");
user_pref("browser.ping-centre.telemetry", false);

user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("app.update.service.enabled", false);

user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.defaultbrowser.notificationbar", false);

user_pref("xpinstall.signatures.required", false);

// ── 仅在受限/无 GPU 环境里帮助启动（正常桌面无影响）──────────────────
// 症状：本机在受限执行环境里跑火狐时报
//   GraphicsCriticalError: GPU proc launch error SB::LA::SpawnTarget 0x80070005
// （0x80070005 = 拒绝访问），进程随即退出。这些开关把沙箱与硬件加速降下来。
user_pref("security.sandbox.content.level", 0);
user_pref("security.sandbox.gpu.level", 0);
user_pref("gfx.webrender.all", false);
user_pref("layers.acceleration.disabled", true);
user_pref("gfx.direct2d.disabled", true);
user_pref("webgl.disabled", true);

