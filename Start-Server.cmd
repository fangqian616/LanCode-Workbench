@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title AGY Web Workbench Server
echo Starting AGY Web Workbench ...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [ERROR] start failed, exit code %RC%, see logs folder
if "%RC%"=="0" echo [OK] Workbench ready: http://127.0.0.1:3088/
timeout /t 5 >nul
exit /b %RC%
