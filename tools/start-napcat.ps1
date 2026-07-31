$launcher = "G:\My pack\NapCat.Shell.Windows.OneKey\NapCat.Shell\NapCatWinBootMain.exe"
$injector = "G:\My pack\NapCat.Shell.Windows.OneKey\NapCat.Shell\NapCatWinBootHook.dll"
$napcatDir = "G:\My pack\NapCat.Shell.Windows.OneKey\NapCat.Shell"
$qqPath = "D:\AppFile\QQ\QQ.exe"

Start-Process -FilePath $launcher `
  -ArgumentList "`"$qqPath`" `"$injector`" -q 3861208813" `
  -WindowStyle Hidden -PassThru -WorkingDirectory $napcatDir

Write-Host "NapCat started, waiting 20s for login..."
Start-Sleep -Seconds 20
netstat -ano | Select-String "3000|3001"
