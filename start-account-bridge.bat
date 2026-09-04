@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)

node scripts\account-bridge.js --open
set "BRIDGE_EXIT=%ERRORLEVEL%"
echo.
if not "%BRIDGE_EXIT%"=="0" echo 本机助手异常结束，请查看上方提示。
pause
exit /b %BRIDGE_EXIT%
