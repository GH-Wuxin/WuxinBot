@echo off
taskkill /FI "WINDOWTITLE eq Wuxin-*" /F 2>nul
taskkill /FI "IMAGENAME eq node.exe" /F 2>nul
echo Stopped.
pause
