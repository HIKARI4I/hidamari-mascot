@echo off
rem Hidamari Mascot: stop the running app (only the one started from this folder)
set "MASCOT_DIR=%~dp0"
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($env:MASCOT_DIR + '*') } | Stop-Process -Force"
