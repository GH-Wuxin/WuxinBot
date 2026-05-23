@echo off
cd /d "%~dp0"
title QQ AI ChatBot Console
echo Starting QQ AI ChatBot...
echo.
echo Cleaning local ports used by this app...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports=5173..5179 + 8787; foreach($p in $ports){ Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }"
echo.
echo Web console: http://127.0.0.1:5173
echo Keep this window open while using the bot.
echo.
npm run dev
pause
