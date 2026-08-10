<#
.SYNOPSIS
  Start the local NapCat Shell instance used by Wuxin.
.DESCRIPTION
  Paths are resolved from parameters, environment variables, then the
  project's .env file (in that order). No machine-specific paths are
  hardcoded; see docs/EXTERNAL_INTEGRATION.md.
#>
param(
  [string]$NapCatShellDir = '',
  [string]$UserDataDir = '',
  [string]$LauncherName = ''
)

$root = Split-Path -Parent $PSScriptRoot

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

if (-not $NapCatShellDir) { $NapCatShellDir = Read-EnvValue 'NAPCAT_SHELL_DIR' }
if (-not $UserDataDir) { $UserDataDir = Read-EnvValue 'NAPCAT_USER_DATA_DIR' }
if (-not $LauncherName) { $LauncherName = Read-EnvValue 'NAPCAT_LAUNCHER_NAME' }

if (-not $NapCatShellDir) {
  throw 'NAPCAT_SHELL_DIR is not configured. Pass -NapCatShellDir, set the environment variable, or add it to .env (see docs/EXTERNAL_INTEGRATION.md).'
}
if (-not $UserDataDir) {
  throw 'NAPCAT_USER_DATA_DIR is not configured. Pass -UserDataDir, set the environment variable, or add it to .env.'
}
if (-not $LauncherName) {
  $candidates = @(Get-ChildItem -LiteralPath $NapCatShellDir -Filter 'NapCatWinBootMain*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($candidates.Count -gt 0) { $LauncherName = $candidates[0].Name }
}
if (-not $LauncherName) {
  throw "Cannot find NapCatWinBootMain*.exe under $NapCatShellDir. Set NAPCAT_LAUNCHER_NAME explicitly."
}

$launcher = Join-Path $NapCatShellDir $LauncherName
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "NapCat launcher not found: $launcher"
}

Start-Process -FilePath $launcher `
  -ArgumentList @("--user-data-dir=$UserDataDir") `
  -WindowStyle Hidden -PassThru -WorkingDirectory $NapCatShellDir

Write-Host 'NapCat started, waiting 20s for login...'
Start-Sleep -Seconds 20
netstat -ano | Select-String '3000|3001'
