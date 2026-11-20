param(
    [switch]$IncludeSyncthing
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$portalJs = Join-Path $root 'portal.mjs'

Write-Host '[*] 停止 stdio-to-ws 中转...'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*stdio-to-ws*' -and $_.CommandLine -like "*$root*" -and $_.CommandLine -notlike '*agy-isolated-launch*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host '[*] 停止 Web 工作台门户 (portal.mjs)...'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$portalJs*" -and $_.CommandLine -notlike '*--iso-user=*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host '[*] 停止本地代理桥接...'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*httpsbridge.py*' -and $_.CommandLine -like "*$root*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$syncPs1 = Join-Path $root 'syncthing-sync.ps1'
if ($IncludeSyncthing -and (Test-Path -LiteralPath $syncPs1)) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $syncPs1 -Action Stop
} else {
    Write-Host '[*] Syncthing 保持后台运行（如需一并停止请加 -IncludeSyncthing）' -ForegroundColor DarkGray
}

Write-Host '[OK] 服务已停止'
Start-Sleep -Seconds 1
