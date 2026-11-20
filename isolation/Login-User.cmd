@echo off
setlocal
cd /d "%~dp0\.."
set "UNAME=%~1"
if "%UNAME%"=="" (
    set /p "UNAME=Enter username (e.g. alice): "
)
if "%UNAME%"=="" (
    echo Username is required.
    pause
    exit /b 1
)
set "NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
for %%P in ("C:\Program Files\nodejs\node.exe" "C:\nvm4w\nodejs\node.exe") do (
    if not defined NODE_EXE if exist "%%~fP" set "NODE_EXE=%%~fP"
)
if not defined NODE_EXE (
    echo node.exe not found in PATH.
    pause
    exit /b 1
)
set "WINUSER=agy-%UNAME%"
set "LAUNCHER=%~dp0..\tools\agy-launch.mjs"
echo.
echo Launching Google OAuth login for Windows user %WINUSER%...
echo Hint: Enter %WINUSER% password from "%~dp0credentials.txt" when prompted.
echo After login succeeds in browser and CLI prompt appears, type /exit or close the window.
echo.
runas /user:%WINUSER% "cmd /k \"\"%NODE_EXE%\" \"%LAUNCHER%\" cli\""
pause
