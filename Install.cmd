@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul 2>&1
title AGY Web Workbench - Install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [ERROR] Install failed with exit code %RC%.
if "%RC%"=="0" echo [OK] Install finished. Run Start-Server.cmd to start.
pause
exit /b %RC%
