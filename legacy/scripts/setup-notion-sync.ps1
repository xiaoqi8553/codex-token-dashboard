[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runnerPath = Join-Path $PSScriptRoot "run-dashboard-background.ps1"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "CodexTokenDashboardNotionSync"

try {
  if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) { throw "找不到后台启动脚本。" }
  if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) { throw "找不到 Windows PowerShell。" }

  # Remove the experimental scheduled-task entry used by early 0.9.8 installers.
  Unregister-ScheduledTask -TaskName $runValueName -Confirm:$false -ErrorAction SilentlyContinue
  New-Item -Path $runKey -Force | Out-Null
  $startupArguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}"' -f $runnerPath, $projectRoot
  $startupCommand = '"{0}" {1}' -f $powershellPath, $startupArguments
  New-ItemProperty -Path $runKey -Name $runValueName -Value $startupCommand -PropertyType String -Force | Out-Null
  Start-Process -FilePath $powershellPath -ArgumentList $startupArguments -WindowStyle Hidden

  Write-Host ""
  Write-Host "已完成自动同步设置：本机看板会在你登录 Windows 后自动后台运行。" -ForegroundColor Green
  Write-Host "Notion 桌面版不需要安装 Chrome 扩展；重新打开看板后会直接连接本机只读服务。" -ForegroundColor Cyan
  Write-Host "首次连接若出现本地网络访问提示，请选择允许；以后会每 5 秒自动刷新。" -ForegroundColor Cyan
  Write-Host "本机日志：$env:LOCALAPPDATA\CodexTokenDashboard\logs" -ForegroundColor DarkGray
  Write-Host ""
} catch {
  Write-Host "Notion 自动同步设置失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "请检查 Node.js 是否可用，以及当前 Windows 用户是否允许创建登录计划任务。" -ForegroundColor Yellow
  exit 1
}
