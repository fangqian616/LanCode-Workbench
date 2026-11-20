@echo off
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"
if "%~1"=="" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0syncthing-sync.ps1" -Action Status
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0syncthing-sync.ps1" %*
)
echo.
pause
