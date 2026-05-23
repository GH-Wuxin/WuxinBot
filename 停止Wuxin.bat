@echo off
echo Stopping Wuxin...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports=5173..5179 + 8787; foreach($p in $ports){ Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }"
echo Wuxin stopped.
pause
