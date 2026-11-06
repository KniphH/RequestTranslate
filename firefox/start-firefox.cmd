@echo off
rem == 绿色版火狐启动器（备选）=============================================
rem 首选是 启动火狐.vbs：它无窗口，而且能等火狐退出后再清一次外面的残留。
rem 这个 .cmd 是给「组策略禁用了 VBScript」之类的环境兜底的 —— 代价是
rem 会有一个黑窗口挂到火狐关闭为止（start /wait 需要它）。
rem 两版的清理逻辑相同，坑的说明见 .vbs 顶部注释。
rem ======================================================================
setlocal
set "HERE=%~dp0"

rem 有真实 Firefox 就不清（避免误删它的书签密码）
if exist "%APPDATA%\Mozilla\Firefox\profiles.ini" goto skipclean
rd /s /q "%APPDATA%\Mozilla" 2>nul
rd /s /q "%LOCALAPPDATA%\Mozilla" 2>nul
:skipclean

set "TEMP=%HERE%profile\Temp"
set "TMP=%HERE%profile\Temp"
set "MOZ_CRASHREPORTER_DISABLE=1"
set "MOZ_CRASHREPORTER_NO_REPORT=1"
if not exist "%TEMP%" mkdir "%TEMP%"

start "" /wait "%HERE%app\firefox.exe" -profile "%HERE%profile" -no-remote

rem 退出后再清一次
if exist "%APPDATA%\Mozilla\Firefox\profiles.ini" goto end
rd /s /q "%APPDATA%\Mozilla" 2>nul
rd /s /q "%LOCALAPPDATA%\Mozilla" 2>nul
:end
exit /b
