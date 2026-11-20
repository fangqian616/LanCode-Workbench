@echo off
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
echo Adding firewall rules for AGY Web Workbench (TCP 3088) and Syncthing (22000/21027)...
netsh advfirewall firewall delete rule name="AGY-Workbench-3088" >nul 2>&1
netsh advfirewall firewall add rule name="AGY-Workbench-3088" dir=in action=allow protocol=TCP localport=3088 profile=any

netsh advfirewall firewall delete rule name="AGY-Syncthing-TCP-22000" >nul 2>&1
netsh advfirewall firewall add rule name="AGY-Syncthing-TCP-22000" dir=in action=allow protocol=TCP localport=22000 profile=any

netsh advfirewall firewall delete rule name="AGY-Syncthing-UDP-22000" >nul 2>&1
netsh advfirewall firewall add rule name="AGY-Syncthing-UDP-22000" dir=in action=allow protocol=UDP localport=22000 profile=any

netsh advfirewall firewall delete rule name="AGY-Syncthing-Discovery-21027" >nul 2>&1
netsh advfirewall firewall add rule name="AGY-Syncthing-Discovery-21027" dir=in action=allow protocol=UDP localport=21027 profile=any

echo.
echo Done. LAN/Tailscale clients can now connect:
echo   Web Workbench : http://THIS-PC-IP:3088/?t=TOKEN
echo   acp-ui WS     : ws://THIS-PC-IP:3088/agent?t=TOKEN
echo   Syncthing     : TCP/UDP 22000 + UDP 21027
echo.
echo Note: relay port 3090 stays loopback-only behind the portal token proxy.
pause
