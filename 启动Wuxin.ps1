# Wuxin launcher
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "Wuxin QQ AI ChatBot"
Write-Host "===================="

if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found. Please install Node.js 20+ from https://nodejs.org"
    Read-Host
    exit 1
}

if (!(Test-Path "node_modules")) {
    Write-Host "Installing dependencies..."
    & npm install
}

Write-Host "Starting backend..."
Start-Process cmd -ArgumentList "/c","npm","run","server" -WindowStyle Minimized
Start-Sleep 3

Write-Host "Starting frontend..."
Start-Process cmd -ArgumentList "/c","npm","run","dev" -WindowStyle Minimized
Start-Sleep 3

Write-Host "Opening http://127.0.0.1:5173"
Start-Process "http://127.0.0.1:5173"
Write-Host "Done. Close this window to stop."
Read-Host
