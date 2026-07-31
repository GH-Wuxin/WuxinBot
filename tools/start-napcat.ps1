$launcher = "REDACTED_WORKSPACE\NapCat.Shell.Windows.OneKey\NapCat.Shell\NapCatWinBootMain.exe"
$injector = "REDACTED_WORKSPACE\NapCat.Shell.Windows.OneKey\NapCat.Shell\NapCatWinBootHook.dll"
$napcatDir = "REDACTED_WORKSPACE\NapCat.Shell.Windows.OneKey\NapCat.Shell"
$qqPath = "D:\AppFile\QQ\QQ.exe"

Start-Process -FilePath $launcher `
  -ArgumentList "`"$qqPath`" `"$injector`" -q REDACTED_QQ_002" `
  -WindowStyle Hidden -PassThru -WorkingDirectory $napcatDir

Write-Host "NapCat started, waiting 20s for login..."
Start-Sleep -Seconds 20
netstat -ano | Select-String "3000|3001"
