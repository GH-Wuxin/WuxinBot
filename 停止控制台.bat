@echo off
cd /d "%~dp0"
title Stop QQ AI ChatBot
echo Stopping QQ AI ChatBot...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports=5173..5179 + 8787; foreach($p in $ports){ Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }"
echo Done.
pause
