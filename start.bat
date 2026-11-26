@echo off
rem Hidamari Mascot launcher: double-click to start
cd /d "%~dp0"

set NEED_INSTALL=0
if not exist "node_modules\electron\dist\electron.exe" set NEED_INSTALL=1
if not exist "node_modules\koffi" set NEED_INSTALL=1
if "%NEED_INSTALL%"=="1" (
  echo Installing. Please wait...
  call npm install
  if errorlevel 1 (
    echo Install failed. Check that Node.js is installed.
    pause
    exit /b 1
  )
)

rem Stop a running copy first, so the newest files are always used
set "MASCOT_DIR=%~dp0"
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($env:MASCOT_DIR + '*') } | Stop-Process -Force" >nul 2>&1
timeout /t 1 /nobreak >nul

start "" "node_modules\electron\dist\electron.exe" .
