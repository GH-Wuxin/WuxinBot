param(
  [string]$NapCatDir = $env:NAPCAT_DIR,
  [string]$QQ = "",
  [int]$HttpPort = 3000,
  [int]$WsPort = 3001
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($NapCatDir)) {
  $NapCatDir = Read-Host "Input NapCat Shell directory"
}

if ([string]::IsNullOrWhiteSpace($QQ)) {
  $QQ = Read-Host "Input target bot QQ number"
}

$configDir = Join-Path $NapCatDir "config"
$configPath = Join-Path $NapCatDir "config\onebot11_$QQ.json"
if (!(Test-Path -LiteralPath $configPath)) {
  Write-Host "Cannot find config for QQ: $QQ"
  Write-Host "Expected file: $configPath"
  Write-Host ""
  Write-Host "Available OneBot config files:"
  if (Test-Path -LiteralPath $configDir) {
    Get-ChildItem -LiteralPath $configDir -Filter "onebot11_*.json" | ForEach-Object {
      Write-Host " - $($_.Name)"
    }
  } else {
    Write-Host " - config directory not found: $configDir"
  }
  Write-Host ""
  Write-Host "This usually means the target QQ has not logged into this NapCat instance yet."
  exit 1
}

$backupPath = "$configPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item -LiteralPath $configPath -Destination $backupPath -Force

$json = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $json.network) {
  $json | Add-Member -NotePropertyName network -NotePropertyValue ([pscustomobject]@{})
}

$json.network.httpServers = @(
  [pscustomobject]@{
    enable = $true
    name = "local-http"
    host = "127.0.0.1"
    port = $HttpPort
    token = ""
    messagePostFormat = "array"
    debug = $false
  }
)

$json.network.websocketServers = @(
  [pscustomobject]@{
    enable = $true
    name = "local-ws"
    host = "127.0.0.1"
    port = $WsPort
    token = ""
    messagePostFormat = "array"
    debug = $false
  }
)

$json | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding UTF8

Write-Host "Updated: $configPath"
Write-Host "Backup:  $backupPath"
Write-Host ""
Write-Host "Use these in QQ AI ChatBot:"
Write-Host "HTTP: http://127.0.0.1:$HttpPort"
Write-Host "WS:   ws://127.0.0.1:$WsPort"
Write-Host ""
Write-Host "Restart NapCat for this QQ account after changing the config."
