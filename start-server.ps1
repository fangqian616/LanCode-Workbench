param(
    [switch]$NoBrowser,
    [switch]$NoUi
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$logs = Join-Path $root 'logs'
$workspace = Join-Path $root 'workspace'
New-Item -ItemType Directory -Force -Path $logs, $workspace | Out-Null

if (-not $env:USERPROFILE) { $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile') }
if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }
if (-not $env:LOCALAPPDATA) { $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData') }
if (-not $env:APPDATA) { $env:APPDATA = [Environment]::GetFolderPath('ApplicationData') }

function Find-Exe {
    param([string[]]$Candidates, [string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }
    foreach ($c in $Candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $null
}
function Step($m) { Write-Host ('[*] ' + $m) -ForegroundColor Cyan }
function Ok($m) { Write-Host ('[OK] ' + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ('[!] ' + $m) -ForegroundColor Yellow }
function Test-LoopbackPort([int]$Port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $ar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(500, $false)
        if ($ok) { $c.EndConnect($ar); $c.Close(); return $true }
        $c.Close()
    } catch {}
    return $false
}

Write-Host '============ LanCode Workbench 服务端 ============' -ForegroundColor Cyan

$node = Find-Exe @('C:\Program Files\nodejs\node.exe', 'C:\nvm4w\nodejs\node.exe') 'node'
$agy = Find-Exe @($env:AGY_EXE_PATH, (Join-Path $root 'tools\agy-shared\agy.exe'), (Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe')) 'agy'
$codexCli = Find-Exe @($env:CODEX_PATH) 'codex'
$claudeCli = Find-Exe @($env:CLAUDE_CODE_EXECUTABLE) 'claude'
$geminiCli = Find-Exe @($env:GEMINI_CLI_PATH) 'gemini'
$opencodeCli = Find-Exe @($env:OPENCODE_EXE_PATH) 'opencode'

$wsPkg = Join-Path $root 'node_modules\ws\package.json'
$codexAcp = Join-Path $root 'node_modules\@agentclientprotocol\codex-acp\dist\index.js'
$claudeAcp = Join-Path $root 'node_modules\@agentclientprotocol\claude-agent-acp\dist\index.js'
$wsMain = Join-Path $root 'node_modules\@rebornix\stdio-to-ws\dist\main.js'
$launcherMjs = Join-Path $root 'tools\agy-launch.mjs'

if (-not $node) { Warn '未找到 node.exe（请先安装 Node.js >= 20）'; exit 1 }
if (-not (Test-Path -LiteralPath $wsPkg)) { Warn '未安装依赖（请先双击 Install.cmd）'; exit 2 }
Ok ('node  : ' + $node)
if (Test-Path -LiteralPath $codexAcp) { Ok ('Codex ACP : bundled' + $(if ($codexCli) { ' (' + $codexCli + ')' } else { '' })) }
if (Test-Path -LiteralPath $claudeAcp) { Ok ('Claude ACP: bundled' + $(if ($claudeCli) { ' (' + $claudeCli + ')' } else { '' })) }
if ($agy) { Ok ('Antigravity: ' + $agy) }
if ($geminiCli) { Ok ('Gemini CLI : ' + $geminiCli) }
if ($opencodeCli) { Ok ('OpenCode   : ' + $opencodeCli) }

# 读取 users.json 端口配置（若不存在则按 users.example.json 生成）
$usersFile = Join-Path $root 'users.json'
$exampleFile = Join-Path $root 'users.example.json'
if (-not (Test-Path -LiteralPath $usersFile) -and (Test-Path -LiteralPath $exampleFile)) {
    Copy-Item -LiteralPath $exampleFile -Destination $usersFile
}

$portalPort = 3088
$relayPort = 3090
$shareUsers = @()
if (Test-Path -LiteralPath $usersFile) {
    try {
        $rawCfg = [IO.File]::ReadAllText($usersFile, [Text.UTF8Encoding]::new($false)).TrimStart([char]0xFEFF)
        $cfg = $rawCfg | ConvertFrom-Json
        if ($cfg.portalPort) { $portalPort = [int]$cfg.portalPort }
        if ($cfg.relayPort) { $relayPort = [int]$cfg.relayPort }
        $tokenChanged = $false
        foreach ($u in $cfg.users) {
            if (-not $u.name) { continue }
            $name = ([string]$u.name).ToLower()
            New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $root 'users') $name) | Out-Null
            if (-not $u.token -or ([string]$u.token) -like 'REPLACE*' -or ([string]$u.token).Length -lt 16) {
                $rnd = New-Object byte[] 18
                [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rnd)
                $u.token = ([BitConverter]::ToString($rnd)).Replace('-', '').ToLower()
                $tokenChanged = $true
            }
            $shareUsers += $u
        }
        if ($tokenChanged) {
            [IO.File]::WriteAllText($usersFile, ($cfg | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
            Ok '已为新增成员生成随机 token（已写回 users.json）'
        }
    } catch { Warn ('users.json 读取失败: ' + $_.Exception.Message) }
}

# 1) 停掉旧的 stdio-to-ws 中转实例
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*stdio-to-ws*' -and ($_.CommandLine -like "*$root*" -or $_.CommandLine -like "*--port $relayPort*") -and $_.CommandLine -notlike '*agy-isolated-launch*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 2) 默认由 portal.mjs 按会话动态托管多引擎 ACP；仅当 AGY_USE_EXTERNAL_RELAY=1 且存在 agy 时才拉起外置中转
if ($env:AGY_USE_EXTERNAL_RELAY -eq '1' -and $agy -and (Test-Path -LiteralPath $wsMain)) {
    Step ('启动外置 ACP 中转 (ws://127.0.0.1:' + $relayPort + '/) ...')
    $cmdArg = '"' + $node + ' ' + $launcherMjs + ' cli acp"'
    Start-Process -FilePath $node -ArgumentList @($wsMain, $cmdArg, '--port', [string]$relayPort, '--persist', '--grace-period', '-1') `
        -WorkingDirectory $workspace -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logs 'acp-ws.log') -RedirectStandardError (Join-Path $logs 'acp-ws.err')

    $portOk = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        if (Test-LoopbackPort $relayPort) { $portOk = $true; break }
    }
    if ($portOk) { Ok ('外置 ACP 中转已就绪: ws://127.0.0.1:' + $relayPort + '/') } else { Warn ($relayPort.ToString() + ' 端口未起来，请查看 logs\acp-ws.err') }
} else {
    Step 'ACP 模式: 内置按会话多引擎托管 (Codex / Claude / Antigravity / Gemini / OpenCode)'
}

# 3) 启动三栏 Web 工作台与门户 (portal.mjs)
$portalJs = Join-Path $root 'portal.mjs'
if (Test-Path -LiteralPath $portalJs) {
    $portalProc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$portalJs*" -and $_.CommandLine -notlike '*--iso-user=*' } |
        Select-Object -First 1
    $portalUp = ($null -ne $portalProc) -or (Test-LoopbackPort $portalPort)
    if (-not $portalUp) {
        Step ('启动 LanCode Web 工作台 (http://127.0.0.1:' + $portalPort + '/) ...')
        Start-Process -FilePath $node -ArgumentList @($portalJs) -WorkingDirectory $root -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logs 'portal.log') -RedirectStandardError (Join-Path $logs 'portal.err')
        Start-Sleep -Seconds 2
        $portalUp = (Test-LoopbackPort $portalPort)
    }
    if ($portalUp) { Ok ('Web 工作台已就绪: http://127.0.0.1:' + $portalPort + '/') } else { Warn ($portalPort.ToString() + ' 端口未起来，请查看 logs\portal.err') }
}

# 4) 启动 Syncthing 便携版（若已安装）
$syncPs1 = Join-Path $root 'syncthing-sync.ps1'
$stExe = Join-Path $root 'tools\syncthing\syncthing.exe'
$stDeviceId = ''
if ((Test-Path -LiteralPath $syncPs1) -and (Test-Path -LiteralPath $stExe)) {
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $syncPs1 -Action Start
        $stDeviceId = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $syncPs1 -Action DeviceId 2>$null | Out-String).Trim()
    } catch {
        Warn ('Syncthing 启动失败: ' + $_.Exception.Message)
    }
}

# 5) 刷新成员说明与 室友链接.txt
$manageUsersPs1 = Join-Path $root 'manage-users.ps1'
if ((Test-Path -LiteralPath $manageUsersPs1) -and ($shareUsers.Count -gt 0)) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $manageUsersPs1 -Action Refresh -Quiet
}

# 6) 打印成员访问信息
if ($shareUsers.Count -gt 0) {
    $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |
        Select-Object -ExpandProperty IPAddress -Unique)
    Write-Host ''
    Write-Host '===== 成员工作台入口 =====' -ForegroundColor Cyan
    if ($stDeviceId) { Write-Host ('Syncthing PC 设备 ID: ' + $stDeviceId + '  (GUI: http://127.0.0.1:8384/)') -ForegroundColor Cyan }
    foreach ($u in $shareUsers) {
        $name = ([string]$u.name).ToLower()
        Write-Host ('[-] ' + $name) -ForegroundColor Yellow
        foreach ($ip in $ips) { Write-Host ('    Web 工作台: http://' + $ip + ':' + $portalPort + '/?t=' + $u.token) }
        Write-Host ('    acp-ui WS : ' + (($ips | ForEach-Object { 'ws://' + $_ + ':' + $portalPort + '/agent?t=' + $u.token }) -join '  |  '))
        Write-Host ('    工作目录  : ' + (Join-Path (Join-Path $root 'users') $name))
        Write-Host ('    Syncthing : agy-' + $name)
    }
    Write-Host ''
    Write-Host ('链接汇总已写入: ' + (Join-Path $root '室友链接.txt')) -ForegroundColor DarkGray
}

if (-not $NoBrowser -and -not $NoUi -and $shareUsers.Count -gt 0) {
    $first = $shareUsers[0]
    Start-Process ('http://127.0.0.1:' + $portalPort + '/?t=' + $first.token)
}

Write-Host ''
Ok 'LanCode Workbench 服务端已就绪'
exit 0
