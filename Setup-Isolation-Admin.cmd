@echo off
setlocal EnableExtensions
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges via UAC...
    if "%~1"=="" (
        powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    ) else (
        powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
    )
    exit /b
)

if not "%~1"=="" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-isolation.ps1" %*
    set "RC=%ERRORLEVEL%"
    echo.
    pause
    exit /b %RC%
)

:menu
cls
echo ========================================================
echo   AGY Web Workbench - Windows User-Level Isolation
echo ========================================================
echo.
echo   [1] Full Isolation (create agy-* users + strict ACL + per-user tasks)
echo   [2] Downgrade: Directory ACL Only (keep main server + Syncthing)
echo   [3] Check Current Isolation Status
echo   [4] Revert Isolation (remove tasks + reset ACLs, keep all user data)
echo   [0] Exit
echo.
set /p "CHOICE=Select option [0-4]: "
if "%CHOICE%"=="1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-isolation.ps1" -Mode Full
    echo.
    pause
    goto :eof
)
if "%CHOICE%"=="2" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-isolation.ps1" -Mode AclOnly
    echo.
    pause
    goto :eof
)
if "%CHOICE%"=="3" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-isolation.ps1" -Mode Status
    echo.
    pause
    goto :menu
)
if "%CHOICE%"=="4" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-isolation.ps1" -Mode Revert
    echo.
    pause
    goto :eof
)
if "%CHOICE%"=="0" exit /b 0
goto :menu
