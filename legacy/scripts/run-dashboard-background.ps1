[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$serverPath = Join-Path $resolvedRoot "server.js"
$logRoot = Join-Path $env:LOCALAPPDATA "CodexTokenDashboard\logs"
$stdoutPath = Join-Path $logRoot "notion-sync.out.log"
$stderrPath = Join-Path $logRoot "notion-sync.err.log"
$startupLog = Join-Path $logRoot "notion-sync-startup.log"

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
function Write-StartupLog([string]$Message) {
  Add-Content -LiteralPath $startupLog -Value ("{0:u} {1}" -f [DateTime]::Now, $Message) -Encoding UTF8
}

try {
  if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    throw "找不到本机看板服务：$serverPath"
  }

  foreach ($port in 8787..8789) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/config" -TimeoutSec 2
      if ($health.ok) {
        Write-StartupLog "Dashboard service is already running on port $port."
        exit 0
      }
    } catch {
      # Continue to the next candidate port; the service may still be starting.
    }
  }

  $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    $nodePath = $bundledNode
  } else {
    $nodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command "node" -ErrorAction SilentlyContinue }
    if (-not $nodeCommand) { throw "未找到 Node.js。请安装 Node.js，或在 Codex 桌面环境中运行本安装程序。" }
    $nodePath = $nodeCommand.Source
  }

  $env:HOST = "127.0.0.1"
  $env:PORT = "8787"
  $env:DASHBOARD_AUTO_OPEN = "0"
  Start-Process -FilePath $nodePath `
    -ArgumentList @('"' + $serverPath + '"') `
    -WorkingDirectory $resolvedRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath
  Write-StartupLog "Started Dashboard service in background with $nodePath."
} catch {
  Write-StartupLog ("Startup failed: " + $_.Exception.Message)
  throw
}
