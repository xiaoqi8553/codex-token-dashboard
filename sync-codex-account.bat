@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "NODE_EXE=node"
if defined CODEX_NODE_EXE set "NODE_EXE=%CODEX_NODE_EXE%"
if "%~1"=="" (
  echo 用法：sync-codex-account.bat 账号名称 [--sync-ccswitch]
  echo 例如：sync-codex-account.bat work --sync-ccswitch
  pause
  exit /b 2
)
"%NODE_EXE%" "%ROOT%scripts\sync-codex-account.js" --account-name "%~1" --json %2 %3 %4
if errorlevel 1 (
  echo.
  echo [ERROR] 账号快照更新失败，请查看上面的错误信息。
)
pause
