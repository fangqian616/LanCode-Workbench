param(
    [switch]$SkipSyncthing
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Step($m) { Write-Host ('[*] ' + $m) -ForegroundColor Cyan }
function Ok($m) { Write-Host ('[OK] ' + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ('[!] ' + $m) -ForegroundColor Yellow }

function Find-Exe {
    param([string[]]$Candidates, [string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }
    foreach ($c in $Candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $null
}

function Resolve-ProxyArg {
    try {
        $reg = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($reg -and $reg.ProxyEnable -eq 1 -and $reg.ProxyServer) {
            $srv = [string]$reg.ProxyServer
            if ($srv -notmatch '://') { $srv = 'http://' + $srv }
            return $srv
        }
    } catch {}
    foreach ($port in @(10808, 10809, 7890, 7897, 1080, 2080, 8889)) {
        try {
            $c = New-Object System.Net.Sockets.TcpClient
            $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
            if ($ar.AsyncWaitHandle.WaitOne(250, $false)) {
                $c.EndConnect($ar); $c.Close()
                return ('http://127.0.0.1:' + $port)
            }
            $c.Close()
        } catch {}
    }
    return ''
}

Write-Host '========== LanCode Workbench Installer ==========' -ForegroundColor Cyan

# 1) Check Node.js & npm
$node = Find-Exe @('C:\Program Files\nodejs\node.exe', 'C:\nvm4w\nodejs\node.exe') 'node'
if (-not $node) {
    Warn '未检测到 Node.js（请先安装 Node.js >= 20: https://nodejs.org/）'
    exit 1
}
$verOut = (& $node -v 2>&1 | Out-String).Trim()
Ok ('Node.js: ' + $node + ' (' + $verOut + ')')

$npm = Find-Exe @('C:\Program Files\nodejs\npm.cmd', 'C:\nvm4w\nodejs\npm.cmd') 'npm.cmd'
if (-not $npm) { $npm = Find-Exe @() 'npm' }
if (-not $npm) { Warn '未找到 npm'; exit 1 }

# 2) Detect available host Coding CLIs
$agy = Find-Exe @($env:AGY_EXE_PATH, (Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe')) 'agy'
$codexCli = Find-Exe @($env:CODEX_PATH) 'codex'
$claudeCli = Find-Exe @($env:CLAUDE_CODE_EXECUTABLE) 'claude'
$geminiCli = Find-Exe @($env:GEMINI_CLI_PATH) 'gemini'
$opencodeCli = Find-Exe @($env:OPENCODE_EXE_PATH) 'opencode'

if ($codexCli) { Ok ('Codex CLI: ' + $codexCli) } else { Write-Host '[i] Codex 将通过内置 @agentclientprotocol/codex-acp 运行（复用 ~/.codex 登录态或 OPENAI_API_KEY）' -ForegroundColor DarkGray }
if ($claudeCli) { Ok ('Claude CLI: ' + $claudeCli) } else { Write-Host '[i] Claude Code 将通过内置 @agentclientprotocol/claude-agent-acp 运行（复用 ~/.claude 登录态或 ANTHROPIC_API_KEY）' -ForegroundColor DarkGray }
if ($agy) { Ok ('Antigravity CLI: ' + $agy) } else { Write-Host '[i] 未检测到 agy.exe（如不使用 Antigravity 可忽略，或设置 AGY_EXE_PATH）' -ForegroundColor DarkGray }
if ($geminiCli) { Ok ('Gemini CLI: ' + $geminiCli) }
if ($opencodeCli) { Ok ('OpenCode CLI: ' + $opencodeCli) }

# 3) npm install (with auto proxy detection for bundled ACP adapters)
$npmProxy = Resolve-ProxyArg
$prevHttpProxy = $env:HTTP_PROXY
$prevHttpsProxy = $env:HTTPS_PROXY
if ($npmProxy) {
    $env:HTTP_PROXY = $npmProxy
    $env:HTTPS_PROXY = $npmProxy
    Step ('检测到代理 ' + $npmProxy + '，安装多引擎 ACP 适配器 (@agentclientprotocol/codex-acp, @agentclientprotocol/claude-agent-acp, ws)...')
} else {
    Step '安装多引擎 ACP 适配器 (@agentclientprotocol/codex-acp, @agentclientprotocol/claude-agent-acp, ws)...'
}
Push-Location $root
try {
    & $npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
    Ok 'Node 依赖与多引擎 ACP 适配器安装完成'
} finally {
    Pop-Location
    $env:HTTP_PROXY = $prevHttpProxy
    $env:HTTPS_PROXY = $prevHttpsProxy
}

# 4) Bootstrap users.json from users.example.json
$usersFile = Join-Path $root 'users.json'
$exampleFile = Join-Path $root 'users.example.json'
if (-not (Test-Path -LiteralPath $usersFile) -and (Test-Path -LiteralPath $exampleFile)) {
    Step '根据 users.example.json 生成初始 users.json（随机安全 token）...'
    $raw = [IO.File]::ReadAllText($exampleFile, [Text.UTF8Encoding]::new($false)).TrimStart([char]0xFEFF)
    $cfg = $raw | ConvertFrom-Json
    foreach ($u in $cfg.users) {
        if (-not $u.token -or ([string]$u.token) -like 'REPLACE*' -or ([string]$u.token).Length -lt 16) {
            $rnd = New-Object byte[] 18
            [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rnd)
            $u.token = ([BitConverter]::ToString($rnd)).Replace('-', '').ToLower()
        }
    }
    [IO.File]::WriteAllText($usersFile, ($cfg | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Ok '已创建 users.json（可使用 Manage-Users.cmd 添加或删除成员）'
}

# 5) Optional: Download portable Syncthing
$stDir = Join-Path $root 'tools\syncthing'
$stExe = Join-Path $stDir 'syncthing.exe'
$stCfgDir = Join-Path $root 'syncthing\config'
New-Item -ItemType Directory -Force -Path $stDir, $stCfgDir, (Join-Path $root 'logs'), (Join-Path $root 'workspace') | Out-Null

if (-not $SkipSyncthing -and -not (Test-Path -LiteralPath $stExe)) {
    $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
    if (-not $curl) {
        Warn '未找到 curl.exe，跳过 Syncthing 自动下载（可稍后手动放入 tools\syncthing\syncthing.exe）'
    } else {
        $proxy = Resolve-ProxyArg
        $proxyArgs = if ($proxy) { @('--proxy', $proxy) } else { @('--noproxy', '*') }
        if ($proxy) { Step ('检测到本地代理 ' + $proxy + '，从 GitHub Releases 下载便携版 Syncthing...') }
        else { Step '从 GitHub Releases 下载便携版 Syncthing...' }
        try {
            $relJson = (& $curl @proxyArgs -sS -H 'User-Agent: agy-web-workbench' 'https://api.github.com/repos/syncthing/syncthing/releases/latest' | Out-String)
            $rel = $relJson | ConvertFrom-Json
            $asset = $rel.assets | Where-Object { $_.name -like 'syncthing-windows-amd64-*.zip' } | Select-Object -First 1
            if (-not $asset) { throw '未在最新版本中找到 windows-amd64 安装包' }

            $tmpDir = Join-Path $root 'tmp'
            $zipPath = Join-Path $tmpDir 'syncthing.zip'
            $extDir = Join-Path $tmpDir 'st-extract'
            New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
            if (Test-Path -LiteralPath $extDir) { Remove-Item -LiteralPath $extDir -Recurse -Force }
            & $curl @proxyArgs -fL -o $zipPath $asset.browser_download_url
            if ($LASTEXITCODE -ne 0) { throw ('Syncthing 下载失败 (' + $LASTEXITCODE + ')') }

            Expand-Archive -LiteralPath $zipPath -DestinationPath $extDir -Force
            $foundExe = Get-ChildItem -Path $extDir -Filter 'syncthing.exe' -Recurse | Select-Object -First 1
            if (-not $foundExe) { throw '压缩包内未找到 syncthing.exe' }
            Get-ChildItem -LiteralPath $foundExe.Directory.FullName | ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination $stDir -Recurse -Force
            }
            Remove-Item -LiteralPath $zipPath, $extDir -Recurse -Force -ErrorAction SilentlyContinue
            Ok ('Syncthing 已安装: ' + $stExe)
        } catch {
            Warn ('Syncthing 下载未成功（可先跳过，直接用网页工作台上传下载）：' + $_.Exception.Message)
        }
    }
} elseif (Test-Path -LiteralPath $stExe) {
    Ok ('Syncthing 已就绪: ' + $stExe)
}

Write-Host ''
Ok '安装完成！下一步：'
Write-Host '  1) 在本机完成任意一个 CLI 的一次登录（codex login / claude login / agy），或设置对应 API Key 环境变量'
Write-Host '  2) 双击 Start-Server.cmd 启动 LanCode Workbench（内置 Codex / Claude / AGY / Gemini 切换）'
Write-Host '  3) 若需局域网访问，双击一次 Allow-Firewall.cmd 放行端口'
exit 0
