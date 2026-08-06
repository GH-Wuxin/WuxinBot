$launcher = "REDACTED_WORKSPACE\NapCat.Shell.Windows.OneKey\NapCat.44498.Shell\NapCatWinBootMain-patched.exe"
$napcatDir = "REDACTED_WORKSPACE\NapCat.Shell.Windows.OneKey\NapCat.44498.Shell"

Start-Process -FilePath $launcher `
  -ArgumentList @('--user-data-dir=REDACTED_NAPCAT_DIR') `
  -WindowStyle Hidden -PassThru -WorkingDirectory $napcatDir

Write-Host "NapCat started, waiting 20s for login..."
Start-Sleep -Seconds 20
netstat -ano | Select-String "3000|3001"
