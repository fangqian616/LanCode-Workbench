param(
    [ValidateSet('List', 'Add', 'Remove', 'Rotate', 'Link', 'Refresh')]
    [string]$Action = 'List',
    [string]$Name,
    [string]$Token,
    [switch]$DeleteData,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$usersFile = Join-Path $root 'users.json'
$usersDir = Join-Path $root 'users'
$syncScript = Join-Path $root 'syncthing-sync.ps1'

function Ok($m) { if (-not $Quiet) { Write-Host ('[OK] ' + $m) -ForegroundColor Green } }
function Warn($m) { Write-Host ('[!] ' + $m) -ForegroundColor Yellow }

function Read-Utf8NoBom([string]$Path) {
    $raw = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
    if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
    return $raw
}
function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $norm = ($Text -replace "`r?`n", "`r`n")
    [IO.File]::WriteAllText($Path, $norm, [Text.UTF8Encoding]::new($false))
}
function Write-Utf8Bom([string]$Path, [string]$Text) {
    $norm = ($Text -replace "`r?`n", "`r`n")
    [IO.File]::WriteAllText($Path, $norm, [Text.UTF8Encoding]::new($true))
}

function Load-Cfg {
    return ((Read-Utf8NoBom $usersFile) | ConvertFrom-Json)
}
function Save-Cfg($cfg) {
    Write-Utf8NoBom $usersFile ($cfg | ConvertTo-Json -Depth 8)
}
function Get-PortalPort($cfg) {
    if ($cfg -and $cfg.portalPort) { return [int]$cfg.portalPort }
    return 3088
}
function New-Token {
    $rnd = New-Object byte[] 18
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rnd)
    return (([BitConverter]::ToString($rnd)).Replace('-', '').ToLower())
}
function Get-IPs {
    return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |
        Select-Object -ExpandProperty IPAddress -Unique)
}
function Test-PortalAlive([int]$Port) {
    $portalJs = Join-Path $root 'portal.mjs'
    $proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$portalJs*" } |
        Select-Object -First 1
    if ($proc) { return $true }
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $ar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(500, $false)
        if ($ok) { $c.EndConnect($ar); $c.Close(); return $true }
        $c.Close()
    } catch {}
    return $false
}
function Get-StDeviceIdSafe {
    if (-not (Test-Path -LiteralPath $syncScript)) { return '' }
    $stExe = Join-Path $root 'tools\syncthing\syncthing.exe'
    $stCfg = Join-Path $root 'syncthing\config\config.xml'
    if (-not (Test-Path -LiteralPath $stExe) -or -not (Test-Path -LiteralPath $stCfg)) { return '' }
    try {
        $id = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $syncScript -Action DeviceId 2>$null | Out-String).Trim()
        if ($id -match '^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$') { return $id }
    } catch {}
    return ''
}
function Sync-SyncthingIfRunning {
    if (-not (Test-Path -LiteralPath $syncScript)) { return }
    $stCfgDir = (Join-Path $root 'syncthing\config').ToLower()
    try {
        $running = Get-CimInstance Win32_Process -Filter "Name='syncthing.exe'" -ErrorAction SilentlyContinue |
            Where-Object { ([string]$_.CommandLine).ToLower() -like "*$stCfgDir*" } |
            Select-Object -First 1
        if ($running) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $syncScript -Action SyncFolders | Out-Null
        }
    } catch {}
}
function Restart-Portal([int]$Port) {
    if (Test-PortalAlive $Port) { Ok '已生效（无需重启：工作台会自动热加载新名单）' }
    else { Warn ('注意：端口 ' + $Port + ' 当前未在运行，双击 Start-Server.cmd 启动后生效') }
}

function Write-UserArtifacts($u, $ips, [string]$stId, [int]$portalPort) {
    $uname = ([string]$u.name).ToLower()
    $dir = Join-Path $usersDir $uname
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    $agentUrls = ($ips | ForEach-Object { 'ws://' + $_ + ':' + $portalPort + '/agent?t=' + $u.token }) -join ' 或 '
    $portalUrls = ($ips | ForEach-Object { 'http://' + $_ + ':' + $portalPort + '/?t=' + $u.token }) -join ' 或 '
    $activityUrls = ($ips | ForEach-Object { 'http://' + $_ + ':' + $portalPort + '/activity?t=' + $u.token }) -join ' 或 '
    $filesUrls = ($ips | ForEach-Object { 'http://' + $_ + ':' + $portalPort + '/files/?t=' + $u.token }) -join ' 或 '
    $folderId = 'agy-' + $uname
    $stIdDisplay = if ($stId) { $stId } else { '（PC 端启动服务后执行 .\syncthing-sync.ps1 -Action DeviceId 查看）' }

    $readme = @'
AGY 共享工作区使用说明（{0}）

你的独立密钥(token)：{3}
（这个 token 只属于你：能进你自己文件夹、能连 agent；不要发给别人，泄露了可让管理员重置）

1) 【最推荐】一体化 Web 工作台（无需安装客户端，直接打开浏览器）：
   - 入口：{2}
   - 左栏：按项目目录管理多对话标签；中栏：直接与 AGY 对话，支持直接拖入整个文件夹、文件或 Ctrl+V 粘贴截图自动上传并引用；右栏：实时目录树、文件活动监控与代码/Markdown/图片/HTML/PDF 预览。

2) 网页传统文件门户 & 活动监控（可选）
   - 经典文件列表（上传/下载/打包 zip）：{7}
   - 文件活动面板（3 秒自动刷新）：{4}

3) Syncthing 双向文件同步（可选，本地改完自动同步）
   - 在你的电脑安装 Syncthing（https://syncthing.net/downloads/ 或 SyncTrayzor）
   - 服务器 PC 的设备 ID：{5}
   - 你的专属共享文件夹 ID：{6}
   - 配对步骤：把你电脑的 Syncthing 设备 ID 发给管理员，管理员执行：
       .\syncthing-sync.ps1 -Action Pair -Name {0} -DeviceId <你的设备ID>
     然后在你电脑的 Syncthing 添加服务器设备 ID 并接收文件夹 {6}（建议选本地一个空文件夹）。
   - 配对后：把文件拖入本地同步目录 = 自动上传；agent 在服务端写完文件 = 自动同步回你电脑。

4) 可选：acp-ui 桌面/手机客户端
   - 下载地址：https://github.com/formulahendry/acp-ui/releases
   - 添加 Agent：类型选 WebSocket，URL 填：
       {1}
   - Working Directory 选你本机的同步文件夹即可，服务端会自动映射到 {8}。

5) 注意
   - 大家共用服务端 agent 账号/额度，请不要跑超长任务。
   - 文件请放自己文件夹内；不要尝试访问别人的目录。
   - token 泄露 = 别人能进你的文件夹，请妥善保管；丢失可让管理员重置。
'@ -f $uname, $agentUrls, $portalUrls, $u.token, $activityUrls, $stIdDisplay, $folderId, $filesUrls, $dir
    Write-Utf8Bom (Join-Path $dir '使用说明.txt') $readme

    $agentCfg = [ordered]@{ agents = [ordered]@{} }
    foreach ($ip in $ips) {
        $agentCfg.agents['AGY ' + $uname + ' (' + $ip + ')'] = @{
            transport = 'websocket'
            url = 'ws://' + $ip + ':' + $portalPort + '/agent?t=' + $u.token
        }
    }
    Write-Utf8NoBom (Join-Path $dir 'acp-ui-agents.json') ($agentCfg | ConvertTo-Json -Depth 6)

    $agentsPath = Join-Path $dir 'AGENTS.md'
    $marker = '<!-- auto-generated-by-agy-server -->'
    $shouldWriteAgents = $true
    if (Test-Path -LiteralPath $agentsPath) {
        $cur = Read-Utf8NoBom $agentsPath
        if (-not $cur.TrimStart().StartsWith($marker)) {
            $shouldWriteAgents = $false
        }
    }
    if ($shouldWriteAgents) {
        $primaryIp = if ($ips.Count -gt 0) { $ips[0] } else { '127.0.0.1' }
        $previewExamples = ($ips | ForEach-Object { "- http://${_}:${portalPort}/preview/<相对路径>?t=$($u.token) （下载把 /preview/ 换成 /download/）" }) -join "`r`n"
        $agentsBody = @"
$marker
# Workspace Rules ($uname)

- 你的工作目录严格限定为 ``$dir``；所有新建、编辑、生成的产物文件都必须保存在此目录及其子目录内，不要写到目录外。
- 当向用户交付、新建或更新了工作区中的文件时，请在回复末尾附上可直接点击的门户预览/下载链接（``<相对路径>`` 使用相对于 ``$dir`` 的正斜杠路径）：
$previewExamples
- 实时文件活动面板：http://${primaryIp}:${portalPort}/activity?t=$($u.token)
"@
        Write-Utf8NoBom $agentsPath $agentsBody
    }
}

function Write-RoommateSummary($cfg, $ips, [string]$stId, [int]$portalPort) {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('AGY Web Workbench 成员入口 · ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    if ($stId) { $lines.Add('Syncthing PC 设备 ID: ' + $stId) }
    $lines.Add('')
    foreach ($u in $cfg.users) {
        if (-not $u -or -not $u.name -or -not $u.token) { continue }
        $uname = ([string]$u.name).ToLower()
        $udir = Join-Path $usersDir $uname
        $lines.Add('### ' + $uname)
        foreach ($ip in $ips) {
            $lines.Add('  工作台: http://' + $ip + ':' + $portalPort + '/?t=' + $u.token)
            $lines.Add('  活动页: http://' + $ip + ':' + $portalPort + '/activity?t=' + $u.token)
        }
        $lines.Add('  agent : ' + (($ips | ForEach-Object { 'ws://' + $_ + ':' + $portalPort + '/agent?t=' + $u.token }) -join ' | '))
        $lines.Add('  目录  : ' + $udir)
        $lines.Add('  Syncthing 文件夹 ID: agy-' + $uname)
        $lines.Add('')
    }
    Write-Utf8Bom (Join-Path $root '室友链接.txt') ($lines -join "`r`n")
}

function Show-User($u, [int]$portalPort) {
    $ips = Get-IPs
    $uname = ([string]$u.name).ToLower()
    $udir = Join-Path $usersDir $uname
    Write-Host ''
    Write-Host ('== ' + $uname + ' ==') -ForegroundColor Cyan
    Write-Host ('  token   : ' + $u.token)
    Write-Host ('  工作目录: ' + $udir)
    Write-Host ('  Syncthing Folder ID: agy-' + $uname)
    foreach ($ip in $ips) { Write-Host ('  Web 工作台: http://' + $ip + ':' + $portalPort + '/?t=' + $u.token) }
    foreach ($ip in $ips) { Write-Host ('  agent WS  : ws://' + $ip + ':' + $portalPort + '/agent?t=' + $u.token) }
}

if (-not $Quiet) { Write-Host '========== 成员管理 ==========' -ForegroundColor Cyan }
if (-not (Test-Path -LiteralPath $usersFile)) { Warn ('缺少 users.json: ' + $usersFile); exit 1 }
$cfg = Load-Cfg
$portalPort = Get-PortalPort $cfg

switch ($Action) {
    'List' {
        if (-not $cfg.users -or $cfg.users.Count -eq 0) { Write-Host '（还没有成员）'; exit 0 }
        Write-Host ('成员数: ' + $cfg.users.Count)
        $stId = Get-StDeviceIdSafe
        if ($stId) { Write-Host ('Syncthing PC 设备 ID: ' + $stId) -ForegroundColor Cyan }
        foreach ($u in $cfg.users) { Show-User $u $portalPort }
        Write-Host ''
        Write-Host '常用命令：' -ForegroundColor DarkGray
        Write-Host '  .\manage-users.ps1 -Action Add -Name lisi          # 加成员（自动生成独立密钥）' -ForegroundColor DarkGray
        Write-Host '  .\manage-users.ps1 -Action Rotate -Name lisi       # 重置密钥（旧链接立即失效）' -ForegroundColor DarkGray
        Write-Host '  .\manage-users.ps1 -Action Remove -Name lisi       # 移除成员（默认保留文件夹数据）' -ForegroundColor DarkGray
        Write-Host '  .\manage-users.ps1 -Action Remove -Name lisi -DeleteData  # 移除并删除其文件夹' -ForegroundColor DarkGray
        Write-Host '  .\manage-users.ps1 -Action Link -Name lisi         # 只看某人的链接' -ForegroundColor DarkGray
        Write-Host '  .\manage-users.ps1 -Action Refresh                 # 重新生成所有说明与 AGENTS.md' -ForegroundColor DarkGray
        exit 0
    }
    'Refresh' {
        $ips = Get-IPs
        $stId = Get-StDeviceIdSafe
        foreach ($u in $cfg.users) {
            if (-not $u -or -not $u.name -or -not $u.token) { continue }
            Write-UserArtifacts $u $ips $stId $portalPort
        }
        Write-RoommateSummary $cfg $ips $stId $portalPort
        Ok '已刷新所有成员的使用说明、AGENTS.md、acp-ui-agents.json 与室友链接.txt'
        exit 0
    }
    'Add' {
        if (-not $Name) { Warn '-Add 需要 -Name（建议拼音/英文小写，如 alice）'; exit 1 }
        $name = $Name.ToLower()
        if ($name -notmatch '^[a-z0-9][a-z0-9_-]{0,31}$') { Warn '名字只能用 小写字母/数字/-/_，长度 1-32'; exit 1 }
        if ($cfg.users | Where-Object { $_.name -eq $name }) { Warn ('成员已存在: ' + $name); exit 2 }
        $tk = if ($Token) { $Token } else { New-Token }
        if ($tk -notmatch '^[A-Za-z0-9_\-]{8,}$') { Warn 'token 至少 8 位，只能用字母/数字/-/_'; exit 1 }
        if ($cfg.users | Where-Object { $_.token -eq $tk }) { Warn 'token 与已有成员重复'; exit 2 }
        $newUser = [pscustomobject]@{ name = $name; token = $tk }
        $cfg.users = @($cfg.users) + $newUser
        Save-Cfg $cfg
        $ips = Get-IPs
        $stId = Get-StDeviceIdSafe
        Write-UserArtifacts $newUser $ips $stId $portalPort
        Write-RoommateSummary $cfg $ips $stId $portalPort
        Sync-SyncthingIfRunning
        Restart-Portal $portalPort
        Ok ('已添加成员: ' + $name)
        Show-User $newUser $portalPort
        exit 0
    }
    'Remove' {
        if (-not $Name) { Warn '-Remove 需要 -Name'; exit 1 }
        $name = $Name.ToLower()
        $target = $cfg.users | Where-Object { $_.name -eq $name }
        if (-not $target) { Warn ('没有这个成员: ' + $name); exit 2 }
        $cfg.users = @($cfg.users | Where-Object { $_.name -ne $name })
        Save-Cfg $cfg
        Write-RoommateSummary $cfg (Get-IPs) (Get-StDeviceIdSafe) $portalPort
        if ($DeleteData) {
            $dir = Join-Path $usersDir $name
            if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
            Ok ('已移除成员并删除文件夹: ' + $name)
        } else {
            Ok ('已移除成员: ' + $name + '（文件夹保留在 users\' + $name + '，加回时数据还在）')
        }
        Restart-Portal $portalPort
        exit 0
    }
    'Rotate' {
        if (-not $Name) { Warn '-Rotate 需要 -Name'; exit 1 }
        $name = $Name.ToLower()
        $u = $cfg.users | Where-Object { $_.name -eq $name }
        if (-not $u) { Warn ('没有这个成员: ' + $name); exit 2 }
        $u.token = New-Token
        Save-Cfg $cfg
        $ips = Get-IPs
        $stId = Get-StDeviceIdSafe
        Write-UserArtifacts $u $ips $stId $portalPort
        Write-RoommateSummary $cfg $ips $stId $portalPort
        Restart-Portal $portalPort
        Ok ('已重置 ' + $name + ' 的密钥（旧的门户/agent 链接立即失效）')
        Show-User $u $portalPort
        exit 0
    }
    'Link' {
        if (-not $Name) { Warn '-Link 需要 -Name'; exit 1 }
        $name = $Name.ToLower()
        $u = $cfg.users | Where-Object { $_.name -eq $name }
        if (-not $u) { Warn ('没有这个成员: ' + $name); exit 2 }
        Show-User $u $portalPort
        exit 0
    }
}
