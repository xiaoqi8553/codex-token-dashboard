[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runnerPath = Join-Path $PSScriptRoot "run-dashboard-background.ps1"
$extensionPath = Join-Path $projectRoot "extension"
$taskName = "CodexTokenDashboardNotionSync"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

try {
  if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) { throw "找不到后台启动脚本。" }
  if (-not (Test-Path -LiteralPath $extensionPath -PathType Container)) { throw "找不到 Chrome 扩展目录。" }
  if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) { throw "找不到 Windows PowerShell。" }

  $arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}"' -f $runnerPath, $projectRoot
  $action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "登录 Windows 后在后台启动 Codex Token Dashboard，供 Notion 看板自动同步本机数据。" -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName

  $chromeExtensionsUrl = "chrome://extensions"
  try { Start-Process -FilePath "chrome.exe" -ArgumentList $chromeExtensionsUrl } catch { }
  Start-Process -FilePath "explorer.exe" -ArgumentList ('"' + $extensionPath + '"')

  Write-Host ""
  Write-Host "已完成自动同步设置：本机看板会在你登录 Windows 后自动后台运行。" -ForegroundColor Green
  Write-Host "首次使用还要在 Chrome 扩展页开启开发者模式 -> 加载已解压的扩展程序 -> 选择刚打开的 extension 文件夹。" -ForegroundColor Cyan
  Write-Host "加载扩展后，重新打开 Notion 看板一次；以后会自动连接并每 5 秒刷新，不必再启动服务或点击同步。" -ForegroundColor Cyan
  Write-Host "本机日志：$env:LOCALAPPDATA\CodexTokenDashboard\logs" -ForegroundColor DarkGray
  Write-Host ""
} catch {
  Write-Host "Notion 自动同步设置失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "请检查 Node.js 是否可用，以及当前 Windows 用户是否允许创建登录计划任务。" -ForegroundColor Yellow
  exit 1
}
