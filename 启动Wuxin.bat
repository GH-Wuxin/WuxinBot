@echo off
cd /d "%~dp0"
title Wuxin QQ AI ChatBot

:: portable-node check
set "NODE=node"
if exist "%~dp0portable-node\node.exe" (
    set "NODE=%~dp0portable-node\node.exe"
    set "NPM=%~dp0portable-node\npm.cmd"
    set "PATH=%~dp0portable-node;%PATH%"
) else (
    where node >nul 2>nul
    if errorlevel 1 (
        echo [X] Node.js not found. Please install Node.js 20+ from https://nodejs.org
        echo     Or download the full release package which includes Node.js.
        pause
        exit /b 1
    )
    set "NPM=npm"
)

:: install deps if missing
if not exist "%~dp0node_modules" (
    echo [*] Installing dependencies...
    call %NPM% install
)

:: build frontend if dist missing
if not exist "%~dp0dist" (
    echo [*] Building frontend...
    call %NPM% run build
)

:: clean ports
echo [*] Cleaning ports...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports=5173..5179 + 8787; foreach($p in $ports){ Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }"

:: start
title Wuxin
echo [*] Starting Wuxin...
echo     Console: http://127.0.0.1:5173
echo.
start http://127.0.0.1:5173
call %NPM% run dev
pause
