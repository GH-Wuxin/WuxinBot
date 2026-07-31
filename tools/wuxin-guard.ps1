<#
.SYNOPSIS
  Wuxin / NapCat / yumu-image guardian. Checks health every N seconds and
  restarts whichever service is missing. Run manually or via Task Scheduler.
#>
param(
  [int]$IntervalSeconds = 30
)

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'wuxin-guard.log'

function Write-Log([string]$message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
  Add-Content -Path $log -Value $line
  Write-Host $line
}

function Get-NodeProcess([string]$pattern) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $pattern } |
    Select-Object -First 1
}

function Test-PortListen([int]$port) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

$loaderUrl = 'file:///' + (($root -replace '\\', '/') + '/node_modules/tsx/dist/loader.mjs')
$portableNode = Join-Path $root 'portable-node\node.exe'
$nodeExe = if (Test-Path $portableNode) { $portableNode } else { 'C:\Program Files\nodejs\node.exe' }
$yumuNode = 'REDACTED_BOTS_ROOT\runtime\node-v22.23.1-win-x64\node-v22.23.1-win-x64\node.exe'
$yumuDir = 'REDACTED_BOTS_ROOT\sources\yumu-image'

Write-Log "guard started (interval ${IntervalSeconds}s)"

while ($true) {
  # ── Wuxin: process + health ──
  $wuxin = Get-NodeProcess 'server/index\.ts'
  $health = $null
  try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 5 } catch { }
  if (-not $wuxin -and -not $health) {
    Write-Log 'Wuxin is down, restarting…'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $out = Join-Path $logDir "wuxin-guard-$stamp.log"
    $err = Join-Path $logDir "wuxin-guard-$stamp.err.log"
    Start-Process -FilePath $nodeExe `
      -ArgumentList @('--require', (Join-Path $root 'node_modules\tsx\dist\preflight.cjs'), '--import', $loaderUrl, 'server/index.ts') `
      -WorkingDirectory $root -WindowStyle Hidden `
      -RedirectStandardOutput $out -RedirectStandardError $err
    Write-Log 'Wuxin restart initiated'
  } elseif ($wuxin -and -not $health) {
    Write-Log 'Wuxin process exists but /api/health failed; left running (transient check)'
  }

  # ── NapCat: OneBot WS port ──
  if (-not (Test-PortListen 3001)) {
    Write-Log 'NapCat OneBot WS (3001) is down, restarting via start-napcat.ps1'
    try {
      & (Join-Path $PSScriptRoot 'start-napcat.ps1')
      Write-Log 'NapCat restart initiated'
    } catch {
      Write-Log "NapCat restart failed: $($_.Exception.Message)"
    }
  }

  # ── yumu-image renderer ──
  if (-not (Get-NodeProcess 'yumu-image.*main\.js')) {
    Write-Log 'yumu-image is down, restarting…'
    Start-Process -FilePath $yumuNode -ArgumentList 'main.js' -WorkingDirectory $yumuDir -WindowStyle Hidden
    Write-Log 'yumu-image restart initiated'
  }

  Start-Sleep -Seconds $IntervalSeconds
}
