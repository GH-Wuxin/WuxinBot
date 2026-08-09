<#
.SYNOPSIS
  Wuxin / NapCat / yumu-image guardian. Checks health every N seconds and
  restarts whichever service is missing. Run manually or via Task Scheduler.
.DESCRIPTION
  External deployment paths are resolved from parameters, environment
  variables, then the project's .env file. No machine-specific paths are
  hardcoded; see docs/EXTERNAL_INTEGRATION.md.
#>
param(
  [int]$IntervalSeconds = 30,
  [string]$YumuNode = '',
  [string]$YumuDir = '',
  [string]$NapCatShellDir = '',
  [string]$NapCatUserDataDir = ''
)

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'wuxin-guard.log'

function Read-EnvValue([string]$Name) {
  $fromEnv = Get-Item "Env:$Name" -ErrorAction SilentlyContinue
  if ($fromEnv -and $fromEnv.Value) { return $fromEnv.Value }
  $envFile = Join-Path $root '.env'
  if (Test-Path -LiteralPath $envFile) {
    $line = Get-Content -LiteralPath $envFile | Where-Object {
      $_ -match "^\s*$([regex]::Escape($Name))\s*="
    } | Select-Object -First 1
    if ($line) {
      $value = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
      if ($value) { return $value }
    }
  }
  return ''
}

if (-not $YumuNode) { $YumuNode = Read-EnvValue 'YUMU_NODE' }
if (-not $YumuDir) { $YumuDir = Read-EnvValue 'YUMU_DIR' }
if (-not $NapCatShellDir) { $NapCatShellDir = Read-EnvValue 'NAPCAT_SHELL_DIR' }
if (-not $NapCatUserDataDir) { $NapCatUserDataDir = Read-EnvValue 'NAPCAT_USER_DATA_DIR' }

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

Write-Log "guard started (interval ${IntervalSeconds}s)"

while ($true) {
  # Wuxin: process + health
  $wuxin = Get-NodeProcess 'server/index\.ts'
  $health = $null
  try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 5 } catch { }
  if (-not $wuxin -and -not $health) {
    Write-Log 'Wuxin is down, restarting...'
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

  # NapCat: OneBot WS port
  if (-not (Test-PortListen 3001)) {
    Write-Log 'NapCat OneBot WS (3001) is down, restarting via start-napcat.ps1'
    try {
      & (Join-Path $PSScriptRoot 'start-napcat.ps1') -NapCatShellDir $NapCatShellDir -UserDataDir $NapCatUserDataDir
      Write-Log 'NapCat restart initiated'
    } catch {
      Write-Log "NapCat restart failed: $($_.Exception.Message)"
    }
  }

  # yumu-image renderer
  if (-not (Get-NodeProcess 'yumu-image.*main\.js')) {
    if (-not $YumuNode -or -not $YumuDir) {
      Write-Log 'yumu-image is down but YUMU_NODE/YUMU_DIR are not configured; skipping restart'
    } else {
      Write-Log 'yumu-image is down, restarting...'
      Start-Process -FilePath $YumuNode -ArgumentList 'main.js' -WorkingDirectory $YumuDir -WindowStyle Hidden
      Write-Log 'yumu-image restart initiated'
    }
  }

  Start-Sleep -Seconds $IntervalSeconds
}
