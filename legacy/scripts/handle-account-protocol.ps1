[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$ProtocolUri
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$logPath = Join-Path $env:TEMP "codex-account-protocol.log"

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

  throw "未找到 Node.js 18 或更高版本"
}

function Parse-ProtocolQuery([System.Uri]$Uri) {
  $result = @{}
  foreach ($part in $Uri.Query.TrimStart("?").Split("&", [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $pair = $part.Split("=", 2)
    $name = [System.Uri]::UnescapeDataString($pair[0])
    if ($result.ContainsKey($name)) {
      throw "协议参数重复"
    }
    $result[$name] = if ($pair.Count -eq 2) { [System.Uri]::UnescapeDataString($pair[1]) } else { "" }
  }
  return $result
}

try {
  $uri = [System.Uri]$ProtocolUri
  if ($uri.Scheme -cne "codex-token-dashboard" -or $uri.Host -cne "snapshot" -or $uri.AbsolutePath -ne "/") {
    throw "账号快照协议地址无效"
  }

  $query = Parse-ProtocolQuery $uri
  if ($query.Keys.Count -ne 2 -or -not $query.ContainsKey("key") -or -not $query.ContainsKey("port")) {
    throw "账号快照协议参数无效"
  }
  $pairingKey = [string]$query["key"]
  if ($pairingKey -cnotmatch "^[A-HJ-NP-Z2-9]{8}$") {
    throw "账号快照配对密钥无效"
  }
  $port = 0
  if (-not [int]::TryParse([string]$query["port"], [ref]$port) -or $port -lt 43127 -or $port -gt 43175) {
    throw "账号快照端口无效"
  }

  $bridgeScript = Join-Path $PSScriptRoot "account-bridge.js"
  if (-not (Test-Path -LiteralPath $bridgeScript -PathType Leaf)) {
    throw "缺少本机账号助手脚本"
  }
  $nodeExecutable = Find-NodeExecutable
  & $nodeExecutable $bridgeScript "--port" ([string]$port) "--pairing-key" $pairingKey
  if ($LASTEXITCODE -ne 0) {
    throw "本机账号助手异常退出，退出码：$LASTEXITCODE"
  }
} catch {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $logPath -Value "[$timestamp] $($_.Exception.Message)" -Encoding UTF8
  exit 1
}
