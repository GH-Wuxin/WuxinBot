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

:: single-instance guard
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=[IO.Path]::GetFullPath('%~dp0').TrimEnd('\'); $running=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1; if($running){ exit 10 }"
if errorlevel 10 (
    echo [i] Wuxin is already running. No second instance was started.
    start "" http://127.0.0.1:5173
    exit /b 0
)

:: start
title Wuxin
echo [*] Starting Wuxin...
echo     Console: http://127.0.0.1:5173
echo.
start http://127.0.0.1:5173
call %NPM% run dev
pause
