[CmdletBinding()]
param(
  [switch]$NoOpen,
  [ValidateRange(1024, 65535)]
  [int]$Port = 43127
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$bridgeScript = Join-Path $PSScriptRoot "account-bridge.js"
$logPath = Join-Path $env:TEMP "codex-account-bridge-launch.log"
$exitCode = 0

try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  & "$env:SystemRoot\System32\chcp.com" 65001 | Out-Null
  $Host.UI.RawUI.WindowTitle = "Codex Account Snapshot Bridge"
} catch {
  # Encoding and title setup are cosmetic; launcher diagnostics still remain usable.
}

function Find-NodeExecutable {
  $command = Get-Command "node.exe" -ErrorAction SilentlyContinue
  if ($null -ne $command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
    return $command.Source
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $candidate
    }
  }

  throw "未找到 Node.js 18 或更高版本。请安装 Node.js 后重新双击启动器。"
}

Write-Host ""
Write-Host "正在启动 Codex 账号快照本机助手..." -ForegroundColor Cyan

try {
  if (-not (Test-Path -LiteralPath $bridgeScript -PathType Leaf)) {
    throw "缺少本机助手脚本：$bridgeScript"
  }

  $nodeExecutable = Find-NodeExecutable
  Write-Host "Node.js：$nodeExecutable" -ForegroundColor DarkGray
  Write-Host "网页打开后只需点击“保存当前账号”，请在保存完成前保留此窗口。" -ForegroundColor Gray
  Write-Host ""

  $arguments = @($bridgeScript, "--port", [string]$Port)
  if (-not $NoOpen) {
    $arguments += "--open"
  }

  Push-Location $projectRoot
  try {
    & $nodeExecutable @arguments
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  if ($exitCode -ne 0) {
    throw "本机助手异常退出，退出码：$exitCode"
  }

  Write-Host "本次账号快照操作已结束。" -ForegroundColor Green
} catch {
  $exitCode = 1
  $message = $_.Exception.Message
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $logPath -Value "[$timestamp] $message" -Encoding UTF8
  Write-Host ""
  Write-Host "本机助手启动失败：$message" -ForegroundColor Red
  Write-Host "错误日志：$logPath" -ForegroundColor Yellow
}

Write-Host ""
[void](Read-Host "按 Enter 键关闭此窗口")
exit $exitCode
