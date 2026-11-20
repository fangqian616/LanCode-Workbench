param(
    [ValidateSet('Start', 'Stop', 'Status', 'SyncFolders', 'Pair', 'Unpair', 'DeviceId')]
    [string]$Action = 'Status',
    [string]$Name,
    [string]$DeviceId,
    [string]$DeviceName
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$exe = Join-Path $root 'tools\syncthing\syncthing.exe'
$cfgDir = Join-Path $root 'syncthing\config'
$cfgXml = Join-Path $cfgDir 'config.xml'
$logsDir = Join-Path $root 'logs'
$usersFile = Join-Path $root 'users.json'
$usersRoot = Join-Path $root 'users'
$guiAddr = '127.0.0.1:8384'

New-Item -ItemType Directory -Force -Path $logsDir, $cfgDir, $usersRoot | Out-Null

function Step($m) { Write-Host ('[*] ' + $m) -ForegroundColor Cyan }
function Ok($m) { Write-Host ('[OK] ' + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ('[!] ' + $m) -ForegroundColor Yellow }

function Read-Utf8NoBom([string]$Path) {
    $raw = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
    if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) {
        $raw = $raw.Substring(1)
    }
    return $raw
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Get-ConfigUsers {
    if (-not (Test-Path -LiteralPath $usersFile)) { return @() }
    $cfg = (Read-Utf8NoBom $usersFile) | ConvertFrom-Json
    $list = @()
    foreach ($u in $cfg.users) {
        if (-not $u -or -not $u.name) { continue }
        $uname = ([string]$u.name).Trim().ToLower()
        if ($uname -notmatch '^[a-z0-9][a-z0-9_-]{0,31}$') { continue }
        $list += [pscustomobject]@{ name = $uname; token = [string]$u.token }
    }
    return $list
}

function Ensure-StConfig {
    if (-not (Test-Path -LiteralPath $exe)) {
        throw ('未找到 Syncthing 可执行文件: ' + $exe + '（可先运行 Install.cmd 自动下载）')
    }
    if (-not (Test-Path -LiteralPath $cfgXml)) {
        Step ('首次初始化 Syncthing 配置: ' + $cfgDir)
        $out = & $exe generate "--home=$cfgDir" --no-port-probing 2>&1
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $cfgXml)) {
            throw ('Syncthing generate 失败: ' + ($out | Out-String))
        }
    }
}

function Get-StApiKey {
    Ensure-StConfig
    [xml]$xml = Read-Utf8NoBom $cfgXml
    $key = [string]$xml.configuration.gui.apikey
    if (-not $key) { throw ('config.xml 中缺少 gui.apikey: ' + $cfgXml) }
    return $key.Trim()
}

function Get-StDeviceIdLocal {
    Ensure-StConfig
    $idOut = (& $exe device-id "--home=$cfgDir" 2>&1 | Out-String).Trim()
    $lines = @($idOut -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$' })
    if ($lines.Count -gt 0) { return $lines[0] }
    return ($idOut -split "`r?`n" | Select-Object -Last 1).Trim()
}

function Invoke-StApi {
    param(
        [string]$Method = 'GET',
        [string]$Path,
        [string]$ApiKey,
        $BodyObj = $null
    )
    $uri = 'http://' + $guiAddr + $Path
    $req = [System.Net.HttpWebRequest]::Create($uri)
    $req.Method = $Method
    $req.Proxy = $null
    $req.Timeout = 10000
    $req.ReadWriteTimeout = 10000
    if ($ApiKey) { $req.Headers.Add('X-API-Key', $ApiKey) }
    if ($null -ne $BodyObj) {
        $json = if ($BodyObj -is [string]) { $BodyObj } else { $BodyObj | ConvertTo-Json -Depth 12 -Compress }
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $req.ContentType = 'application/json; charset=utf-8'
        $req.ContentLength = $bytes.Length
        $stream = $req.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
    }
    try {
        $resp = $req.GetResponse()
        $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
        $txt = $sr.ReadToEnd()
        $sr.Close()
        $resp.Close()
        if ($txt -and ($txt.TrimStart().StartsWith('{') -or $txt.TrimStart().StartsWith('['))) {
            return ($txt | ConvertFrom-Json)
        }
        return $txt
    } catch [System.Net.WebException] {
        $errBody = ''
        if ($_.Exception.Response) {
            try {
                $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream(), [Text.Encoding]::UTF8)
                $errBody = $sr.ReadToEnd()
                $sr.Close()
            } catch {}
        }
        throw ("Syncthing API $Method $Path failed: $($_.Exception.Message) $errBody")
    }
}

function Test-StAlive([string]$ApiKey) {
    try {
        $res = Invoke-StApi -Method 'GET' -Path '/rest/system/ping' -ApiKey $ApiKey
        return ($res -and $res.ping -eq 'pong')
    } catch {
        return $false
    }
}

function Get-ManagedStProcesses {
    $normCfg = $cfgDir.ToLower()
    $normExe = $exe.ToLower()
    return @(Get-CimInstance Win32_Process -Filter "Name='syncthing.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $cmd = ([string]$_.CommandLine).ToLower()
        $ep = ([string]$_.ExecutablePath).ToLower()
        ($cmd -like "*$normCfg*") -or ($ep -eq $normExe)
    })
}

function Start-StService {
    $apiKey = Get-StApiKey
    if (Test-StAlive $apiKey) {
        Ok ('Syncthing 已在运行 (GUI: http://' + $guiAddr + '/)')
        return $apiKey
    }

    Step ('启动 Syncthing 便携版 (GUI: http://' + $guiAddr + '/) ...')
    $stLog = Join-Path $logsDir 'syncthing.log'
    $cmdLine = "`"$exe`" serve --home=`"$cfgDir`" --no-browser --gui-address=http://$guiAddr --log-file=`"$stLog`""
    $spawned = $false
    try {
        $startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
        $startup.ShowWindow = 0
        $wmiRes = ([wmiclass]'Win32_Process').Create($cmdLine, $root, $startup)
        if ($wmiRes -and $wmiRes.ReturnValue -eq 0) {
            $spawned = $true
        }
    } catch {
        $spawned = $false
    }

    if (-not $spawned) {
        $proxyNames = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')
        $savedProxy = @{}
        foreach ($pn in $proxyNames) {
            if (Test-Path "Env:$pn") {
                $savedProxy[$pn] = (Get-Item "Env:$pn").Value
                Remove-Item "Env:$pn" -ErrorAction SilentlyContinue
            }
        }
        try {
            Start-Process -FilePath $exe `
                -ArgumentList @('serve', "--home=$cfgDir", '--no-browser', "--gui-address=http://$guiAddr", "--log-file=$stLog") `
                -WorkingDirectory $root `
                -WindowStyle Hidden `
                -RedirectStandardError (Join-Path $logsDir 'syncthing.err') | Out-Null
        } finally {
            foreach ($pn in $savedProxy.Keys) {
                Set-Item "Env:$pn" -Value $savedProxy[$pn]
            }
        }
    }

    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 750
        if (Test-StAlive $apiKey) { $ready = $true; break }
    }
    if (-not $ready) {
        throw ('Syncthing 启动超时，请查看 ' + (Join-Path $logsDir 'syncthing.err'))
    }
    Ok ('Syncthing 已就绪: http://' + $guiAddr + '/')
    return $apiKey
}

function Stop-StService {
    $procs = Get-ManagedStProcesses
    if ($procs.Count -eq 0) {
        Write-Host '[*] Syncthing 未在运行'
        return
    }
    Step ('停止 Syncthing (' + $procs.Count + ' 个进程)...')
    try {
        $apiKey = Get-StApiKey
        if (Test-StAlive $apiKey) {
            Invoke-StApi -Method 'POST' -Path '/rest/system/shutdown' -ApiKey $apiKey -BodyObj @{} | Out-Null
            for ($i = 0; $i -lt 10; $i++) {
                Start-Sleep -Milliseconds 300
                if ((Get-ManagedStProcesses).Count -eq 0) { break }
            }
        }
    } catch {}

    $rem = Get-ManagedStProcesses
    if ($rem.Count -gt 0) {
        $pids = @($rem | ForEach-Object { $_.ProcessId })
        $parents = @($rem | Where-Object { $pids -notcontains $_.ParentProcessId })
        $children = @($rem | Where-Object { $pids -contains $_.ParentProcessId })
        foreach ($p in @($parents + $children)) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
    Ok 'Syncthing 已停止'
}

function Sync-UserFolders([string]$ApiKey) {
    $users = Get-ConfigUsers
    $status = Invoke-StApi -Method 'GET' -Path '/rest/system/status' -ApiKey $ApiKey
    $myId = [string]$status.myID
    $existing = @(Invoke-StApi -Method 'GET' -Path '/rest/config/folders' -ApiKey $ApiKey)
    $defaultFolder = $null
    try {
        $defaultFolder = Invoke-StApi -Method 'GET' -Path '/rest/config/defaults/folder' -ApiKey $ApiKey
    } catch {}

    $byId = @{}
    foreach ($f in $existing) {
        if ($f -and $f.id) { $byId[[string]$f.id] = $f }
    }

    foreach ($u in $users) {
        $uname = $u.name
        $folderId = 'agy-' + $uname
        $dir = Join-Path $usersRoot $uname
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }

        $stIgnore = Join-Path $dir '.stignore'
        try {
            if (-not (Test-Path -LiteralPath $stIgnore)) {
                $ignoreBody = @(
                    '(?d).DS_Store',
                    '(?d)Thumbs.db',
                    '(?d)desktop.ini',
                    'node_modules',
                    '.git'
                ) -join "`r`n"
                Write-Utf8NoBom $stIgnore ($ignoreBody + "`r`n")
            }
        } catch {}

        if (-not $byId.ContainsKey($folderId)) {
            $folderObj = if ($defaultFolder) {
                ($defaultFolder | ConvertTo-Json -Depth 12 -Compress | ConvertFrom-Json)
            } else {
                [pscustomobject]@{}
            }
            $folderObj | Add-Member -MemberType NoteProperty -Name 'id' -Value $folderId -Force
            $folderObj | Add-Member -MemberType NoteProperty -Name 'label' -Value ('AGY ' + $uname) -Force
            $folderObj | Add-Member -MemberType NoteProperty -Name 'path' -Value $dir -Force
            $folderObj | Add-Member -MemberType NoteProperty -Name 'type' -Value 'sendreceive' -Force
            $folderObj | Add-Member -MemberType NoteProperty -Name 'fsWatcherEnabled' -Value $true -Force
            $folderObj | Add-Member -MemberType NoteProperty -Name 'fsWatcherDelayS' -Value 2 -Force
            $folderObj | Add-Member -MemberType NoteProperty -Name 'rescanIntervalS' -Value 300 -Force
            $folderObj | Add-Member -MemberType NoteProperty -Name 'paused' -Value $false -Force
            $folderObj | Add-Member -MemberType NoteProperty -Name 'devices' -Value @([pscustomobject]@{ deviceID = $myId }) -Force

            Invoke-StApi -Method 'POST' -Path '/rest/config/folders' -ApiKey $ApiKey -BodyObj $folderObj | Out-Null
            Ok ('已创建 Syncthing 文件夹: ' + $folderId + ' -> ' + $dir)
        } else {
            $cur = $byId[$folderId]
            if (([string]$cur.path).TrimEnd('\') -ne $dir.TrimEnd('\')) {
                $cur.path = $dir
                Invoke-StApi -Method 'PUT' -Path ('/rest/config/folders/' + [Uri]::EscapeDataString($folderId)) -ApiKey $ApiKey -BodyObj $cur | Out-Null
                Ok ('已更新 Syncthing 文件夹路径: ' + $folderId + ' -> ' + $dir)
            }
        }
    }
}

function Show-StStatus {
    Ensure-StConfig
    $apiKey = Get-StApiKey
    $alive = Test-StAlive $apiKey
    $myId = Get-StDeviceIdLocal

    Write-Host '========== Syncthing 双向同步状态 ==========' -ForegroundColor Cyan
    Write-Host ('运行状态 : ' + $(if ($alive) { '运行中' } else { '未运行' }))
    Write-Host ('管理界面 : http://' + $guiAddr + '/')
    Write-Host ('配置目录 : ' + $cfgDir)
    Write-Host ('本机设备ID: ' + $myId)

    if (-not $alive) {
        Warn 'Syncthing 未运行，可执行 .\syncthing-sync.ps1 -Action Start 启动'
        return
    }

    $devices = @(Invoke-StApi -Method 'GET' -Path '/rest/config/devices' -ApiKey $apiKey)
    $devMap = @{}
    foreach ($d in $devices) {
        if ($d -and $d.deviceID) { $devMap[[string]$d.deviceID] = [string]$d.name }
    }

    $folders = @(Invoke-StApi -Method 'GET' -Path '/rest/config/folders' -ApiKey $apiKey)
    Write-Host ''
    Write-Host ('共享文件夹 (' + $folders.Count + '):') -ForegroundColor Cyan
    foreach ($f in $folders) {
        $peerNames = @()
        foreach ($fd in @($f.devices)) {
            $did = [string]$fd.deviceID
            if ($did -eq $myId) { continue }
            $dname = if ($devMap.ContainsKey($did) -and $devMap[$did]) { $devMap[$did] } else { 'peer' }
            $peerNames += ($dname + ' (' + $did.Substring(0, [Math]::Min(7, $did.Length)) + '...)')
        }
        $peerStr = if ($peerNames.Count -gt 0) { $peerNames -join ', ' } else { '仅本机（尚未配对成员设备）' }
        Write-Host ('  - ' + $f.id + '  [' + $f.path + ']  ->  ' + $peerStr)
    }
}

switch ($Action) {
    'DeviceId' {
        $id = Get-StDeviceIdLocal
        Write-Output $id
        exit 0
    }
    'Start' {
        $apiKey = Start-StService
        Sync-UserFolders $apiKey
        $id = Get-StDeviceIdLocal
        Write-Host ('[*] 本机 Syncthing 设备 ID: ' + $id) -ForegroundColor Cyan
        exit 0
    }
    'Stop' {
        Stop-StService
        exit 0
    }
    'SyncFolders' {
        $apiKey = Start-StService
        Sync-UserFolders $apiKey
        Ok '已同步所有 users.json 成员的 Syncthing 文件夹配置'
        exit 0
    }
    'Pair' {
        if (-not $Name -or -not $DeviceId) {
            Warn '用法: .\syncthing-sync.ps1 -Action Pair -Name <用户名> -DeviceId <成员设备ID> [-DeviceName <备注>]'
            exit 1
        }
        $uname = $Name.Trim().ToLower()
        $users = Get-ConfigUsers
        if (-not ($users | Where-Object { $_.name -eq $uname })) {
            Warn ('users.json 中不存在成员: ' + $uname)
            exit 2
        }
        $did = $DeviceId.Trim().ToUpper()
        $apiKey = Start-StService
        Sync-UserFolders $apiKey
        $status = Invoke-StApi -Method 'GET' -Path '/rest/system/status' -ApiKey $apiKey
        $myId = [string]$status.myID
        if ($did -eq $myId) {
            Warn '不能配对本机自己的设备 ID'
            exit 1
        }

        $dlabel = if ($DeviceName) { $DeviceName } else { 'agy-' + $uname + '-client' }
        $devDefault = $null
        try { $devDefault = Invoke-StApi -Method 'GET' -Path '/rest/config/defaults/device' -ApiKey $apiKey } catch {}
        $devObj = if ($devDefault) { ($devDefault | ConvertTo-Json -Depth 10 -Compress | ConvertFrom-Json) } else { [pscustomobject]@{} }
        $devObj | Add-Member -MemberType NoteProperty -Name 'deviceID' -Value $did -Force
        $devObj | Add-Member -MemberType NoteProperty -Name 'name' -Value $dlabel -Force
        $devObj | Add-Member -MemberType NoteProperty -Name 'addresses' -Value @('dynamic') -Force
        $devObj | Add-Member -MemberType NoteProperty -Name 'autoAcceptFolders' -Value $false -Force
        Invoke-StApi -Method 'PUT' -Path ('/rest/config/devices/' + [Uri]::EscapeDataString($did)) -ApiKey $apiKey -BodyObj $devObj | Out-Null

        $folderId = 'agy-' + $uname
        $folder = Invoke-StApi -Method 'GET' -Path ('/rest/config/folders/' + [Uri]::EscapeDataString($folderId)) -ApiKey $apiKey
        $devList = @()
        $hasPeer = $false
        foreach ($fd in @($folder.devices)) {
            if ($fd -and $fd.deviceID) {
                $devList += $fd
                if ([string]$fd.deviceID -eq $did) { $hasPeer = $true }
            }
        }
        if (-not $hasPeer) {
            $devList += [pscustomobject]@{ deviceID = $did }
            $folder | Add-Member -MemberType NoteProperty -Name 'devices' -Value @($devList) -Force
            Invoke-StApi -Method 'PUT' -Path ('/rest/config/folders/' + [Uri]::EscapeDataString($folderId)) -ApiKey $apiKey -BodyObj $folder | Out-Null
        }

        Ok ("已将设备 $did ($dlabel) 配对到文件夹 $folderId（仅此目录，与其他成员隔离）")
        Write-Host ('[*] 请让成员在他的 Syncthing 中添加本机设备 ID: ' + $myId + '，并接收文件夹 ID: ' + $folderId) -ForegroundColor Cyan
        exit 0
    }
    'Unpair' {
        if (-not $Name -or -not $DeviceId) {
            Warn '用法: .\syncthing-sync.ps1 -Action Unpair -Name <用户名> -DeviceId <成员设备ID>'
            exit 1
        }
        $uname = $Name.Trim().ToLower()
        $did = $DeviceId.Trim().ToUpper()
        $apiKey = Get-StApiKey
        if (-not (Test-StAlive $apiKey)) {
            Warn 'Syncthing 未运行，无法取消配对'
            exit 1
        }
        $folderId = 'agy-' + $uname
        $folder = Invoke-StApi -Method 'GET' -Path ('/rest/config/folders/' + [Uri]::EscapeDataString($folderId)) -ApiKey $apiKey
        $kept = @($folder.devices | Where-Object { $_ -and ([string]$_.deviceID -ne $did) })
        $folder | Add-Member -MemberType NoteProperty -Name 'devices' -Value @($kept) -Force
        Invoke-StApi -Method 'PUT' -Path ('/rest/config/folders/' + [Uri]::EscapeDataString($folderId)) -ApiKey $apiKey -BodyObj $folder | Out-Null

        $allFolders = @(Invoke-StApi -Method 'GET' -Path '/rest/config/folders' -ApiKey $apiKey)
        $stillUsed = $false
        foreach ($f in $allFolders) {
            foreach ($fd in @($f.devices)) {
                if ($fd -and ([string]$fd.deviceID -eq $did)) { $stillUsed = $true; break }
            }
            if ($stillUsed) { break }
        }
        if (-not $stillUsed) {
            try { Invoke-StApi -Method 'DELETE' -Path ('/rest/config/devices/' + [Uri]::EscapeDataString($did)) -ApiKey $apiKey | Out-Null } catch {}
        }
        Ok ("已从文件夹 $folderId 移除设备 $did")
        exit 0
    }
    'Status' {
        Show-StStatus
        exit 0
    }
}
