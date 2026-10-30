@echo off
chcp 65001 >nul
setlocal

set "ROOT=%~dp0"
set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
set "NODE_EXE=%BUNDLED_NODE%"

if not exist "%NODE_EXE%" (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    set "NODE_EXE=%%N"
    goto :node_found
  )
)

:node_found
if not exist "%NODE_EXE%" (
  echo [ERROR] Node.js runtime not found.
  echo Tried bundled runtime:
  echo %BUNDLED_NODE%
  echo.
  echo Install Node.js or run this inside Codex desktop runtime.
  pause
  exit /b 1
)

if not defined PORT set "PORT=8787"
if not defined HOST set "HOST=127.0.0.1"
set "DASHBOARD_AUTO_OPEN=1"

echo Starting Codex Token dashboard...
echo Node: %NODE_EXE%
echo Host: %HOST%
echo Port: %PORT% ^(will try the next two ports if occupied^)
echo.

"%NODE_EXE%" "%ROOT%server.js"

echo.
if errorlevel 1 (
  echo [ERROR] Dashboard stopped because of the error above.
) else (
  echo Dashboard stopped.
)
pause
