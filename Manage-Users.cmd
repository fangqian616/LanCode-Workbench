@echo off
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-users.ps1" %*
echo.
pause
