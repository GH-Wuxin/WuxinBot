<#
.SYNOPSIS
  Restart the Wuxin server using the project's portable Node (v22) when
  available, falling back to the system Node. Keeps log redirection consistent.
#>
$root = Split-Path -Parent $PSScriptRoot
$portableNode = Join-Path $root 'portable-node\node.exe'
$nodeExe = if (Test-Path $portableNode) { $portableNode } else { 'C:\Program Files\nodejs\node.exe' }
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

# Stop any existing Wuxin server process
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'server/index\.ts' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $logDir "wuxin-$stamp.log"
$err = Join-Path $logDir "wuxin-$stamp.err.log"
$loaderUrl = 'file:///' + (($root -replace '\\', '/') + '/node_modules/tsx/dist/loader.mjs')

Start-Process -FilePath $nodeExe `
  -ArgumentList @('--require', (Join-Path $root 'node_modules\tsx\dist\preflight.cjs'), '--import', $loaderUrl, 'server/index.ts') `
  -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput $out -RedirectStandardError $err

Start-Sleep -Seconds 8
Write-Host "Wuxin restarted with $nodeExe"
Write-Host "Log: $out"
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 5
  Write-Host "Health: $($health.status.text) | OneBot: $($health.onebot.connected)"
} catch {
  Write-Host "Health check failed: $($_.Exception.Message)"
}
