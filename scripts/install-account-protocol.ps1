[CmdletBinding()]
param(
  [switch]$NoOpen
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$handlerPath = Join-Path $PSScriptRoot "handle-account-protocol.ps1"
$protocolRoot = "HKCU:\Software\Classes\codex-token-dashboard"
$commandKey = Join-Path $protocolRoot "shell\open\command"
$siteUrl = "https://xiaoqi8553.github.io/codex-token-dashboard/?accountBridge=1"

try {
  if (-not (Test-Path -LiteralPath $handlerPath -PathType Leaf)) {
    throw "缺少协议处理器：$handlerPath"
  }
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) {
    throw "未找到 Windows PowerShell"
  }

  New-Item -Path $protocolRoot -Force | Out-Null
  Set-Item -Path $protocolRoot -Value "Codex Token Dashboard Account Snapshot"
  New-ItemProperty -Path $protocolRoot -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
  New-Item -Path $commandKey -Force | Out-Null
  $command = '"{0}" -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}" "%1"' -f $powershell, $handlerPath
  Set-Item -Path $commandKey -Value $command

  Write-Host ""
  Write-Host "网页一键保存组件已安装。" -ForegroundColor Green
  Write-Host "以后无需启动 BAT，直接在网页点击“保存当前账号”即可。" -ForegroundColor Cyan
  Write-Host "安装位置：当前 Windows 用户（无需管理员权限）" -ForegroundColor DarkGray
  Write-Host ""
  if (-not $NoOpen) {
    Start-Process $siteUrl
  }
} catch {
  Write-Host ""
  Write-Host "安装失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host ""
  [void](Read-Host "按 Enter 键关闭此窗口")
  exit 1
}
