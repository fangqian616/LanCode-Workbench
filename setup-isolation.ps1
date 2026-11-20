param(
    [ValidateSet('Full', 'AclOnly', 'Status', 'Revert')]
    [string]$Mode = 'Status',
    [string[]]$OnlyUsers,
    [switch]$ResetPasswords,
    [switch]$RemoveUsers,
    [switch]$StartTasks
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$usersFile = Join-Path $root 'users.json'
$usersDir = Join-Path $root 'users'
$isoDir = Join-Path $root 'isolation'
$isoUsersDir = Join-Path $isoDir 'users'
$sharedAgyDir = Join-Path $root 'tools\agy-shared'
$sharedAgyExe = Join-Path $sharedAgyDir 'agy.exe'
$isoLauncher = Join-Path $root 'tools\agy-launch.mjs'
$portalMjs = Join-Path $root 'portal.mjs'
$nodeModulesDir = Join-Path $root 'node_modules'

function Find-Exe {
    param([string[]]$Candidates, [string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }
    foreach ($c in $Candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $null
}

$nodeExe = Find-Exe @('C:\Program Files\nodejs\node.exe', 'C:\nvm4w\nodejs\node.exe') 'node'
$srcAgyExe = Find-Exe @($env:AGY_EXE_PATH, (Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe')) 'agy'

$credTxt = Join-Path $isoDir 'credentials.txt'
$credJson = Join-Path $isoDir 'credentials.json'
$portMapFile = Join-Path $isoDir 'port-map.json'
$isoLinksFile = Join-Path $isoDir '室友隔离链接.txt'
$mainLinksFile = Join-Path $root '室友链接.txt'

function Step($m) { Write-Host ('[*] ' + $m) -ForegroundColor Cyan }
function Ok($m) { Write-Host ('[OK] ' + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ('[!] ' + $m) -ForegroundColor Yellow }

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

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

function Get-PrimaryOwnerAccount {
    $fallback = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    try {
        if (Test-Path -LiteralPath $usersFile) {
            $owner = (Get-Acl -LiteralPath $usersFile).Owner
            if ($owner -and $owner -notmatch '^(BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM)$') {
                return $owner
            }
        }
    } catch {}
    return $fallback
}

function Invoke-Icacls([string[]]$IcaclsArgs) {
    $out = & icacls.exe @IcaclsArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ('icacls failed (' + ($IcaclsArgs -join ' ') + '): ' + ($out | Out-String))
    }
}

function Set-CleanAcl([string]$Path, [string[]]$Grants) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $args = New-Object System.Collections.Generic.List[string]
    $args.Add($Path)
    $args.Add('/inheritance:r')
    foreach ($g in $Grants) {
        $args.Add('/grant:r')
        $args.Add($g)
    }
    Invoke-Icacls $args.ToArray()
}

function Set-AdminOnlyAcl([string]$Path, [string]$OwnerAccount, [switch]$IsDirectory) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $flag = if ($IsDirectory) { '(OI)(CI)F' } else { 'F' }
    $grants = @(
        "BUILTIN\Administrators:$flag",
        "NT AUTHORITY\SYSTEM:$flag"
    )
    if ($OwnerAccount -and $OwnerAccount -notmatch '^(BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM)$') {
        $grants += "${OwnerAccount}:$flag"
    }
    Set-CleanAcl -Path $Path -Grants $grants
}

function Set-TraverseOnlyAcl([string]$Path, [string]$OwnerAccount) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $grants = @(
        'BUILTIN\Administrators:(OI)(CI)F',
        'NT AUTHORITY\SYSTEM:(OI)(CI)F'
    )
    if ($OwnerAccount -and $OwnerAccount -notmatch '^(BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM)$') {
        $grants += "${OwnerAccount}:(OI)(CI)F"
    }
    # Omitting (OI)/(CI) grants Read/Traverse ONLY on this folder object, not inherited by child user dirs
    $grants += 'BUILTIN\Users:(RX)'
    Set-CleanAcl -Path $Path -Grants $grants
}

function Set-UserDirAcl([string]$Path, [string]$WinUser, [string]$OwnerAccount = '') {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $acct = "$env:COMPUTERNAME\$WinUser"
    $grants = @(
        'BUILTIN\Administrators:(OI)(CI)F',
        'NT AUTHORITY\SYSTEM:(OI)(CI)F',
        "${acct}:(OI)(CI)M"
    )
    if ($OwnerAccount -and $OwnerAccount -notmatch '^(BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM)$') {
        $grants += "${OwnerAccount}:(OI)(CI)F"
    }
    Set-CleanAcl -Path $Path -Grants $grants
}

function Remove-IsoTasksAndFirewall {
    $tasks = @(Get-ScheduledTask -TaskName 'AGY-Server-User-*' -ErrorAction SilentlyContinue)
    foreach ($t in $tasks) {
        try { Stop-ScheduledTask -TaskName $t.TaskName -ErrorAction SilentlyContinue } catch {}
        Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Ok ('已移除计划任务: ' + $t.TaskName)
    }

    $fwRules = & netsh advfirewall firewall show rule name=all 2>&1 | Select-String 'AGY-Server-User-'
    foreach ($line in $fwRules) {
        if ($line -match 'AGY-Server-User-[A-Za-z0-9_-]+') {
            $rn = $Matches[0]
            & netsh advfirewall firewall delete rule name="$rn" | Out-Null
            Ok ('已移除防火墙规则: ' + $rn)
        }
    }
}

function New-StrongPassword([int]$Length = 20) {
    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
    $lower = 'abcdefghijkmnopqrstuvwxyz'
    $digits = '23456789'
    $sym = '!@#_-'
    $all = $upper + $lower + $digits + $sym
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $chars = New-Object System.Collections.Generic.List[char]
    foreach ($pool in @($upper, $lower, $digits, $sym)) {
        $b = New-Object byte[] 4
        $rng.GetBytes($b)
        $idx = [BitConverter]::ToUInt32($b, 0) % [uint32]$pool.Length
        $chars.Add($pool[$idx])
    }
    while ($chars.Count -lt $Length) {
        $b = New-Object byte[] 4
        $rng.GetBytes($b)
        $idx = [BitConverter]::ToUInt32($b, 0) % [uint32]$all.Length
        $chars.Add($all[$idx])
    }
    for ($i = $chars.Count - 1; $i -gt 0; $i--) {
        $b = New-Object byte[] 4
        $rng.GetBytes($b)
        $j = [int]([BitConverter]::ToUInt32($b, 0) % [uint32]($i + 1))
        $tmp = $chars[$i]; $chars[$i] = $chars[$j]; $chars[$j] = $tmp
    }
    return (-join $chars.ToArray())
}

function Get-SafeWinUsername([string]$Name, [hashtable]$UsedNames) {
    $clean = ($Name.ToLower() -replace '[^a-z0-9_-]', '')
    if (-not $clean) { $clean = 'user' }
    $cand = 'agy-' + $clean
    if ($cand.Length -gt 20) { $cand = $cand.Substring(0, 20) }
    $base = $cand
    $n = 2
    while ($UsedNames.ContainsKey($cand)) {
        $sfx = '-' + $n
        $cand = $base.Substring(0, [Math]::Min($base.Length, 20 - $sfx.Length)) + $sfx
        $n++
    }
    $UsedNames[$cand] = $true
    return $cand
}

function Get-ConfigUsers {
    if (-not (Test-Path -LiteralPath $usersFile)) { throw ('缺少 users.json: ' + $usersFile) }
    $cfg = (Read-Utf8NoBom $usersFile) | ConvertFrom-Json
    $list = @()
    foreach ($u in $cfg.users) {
        if (-not $u -or -not $u.name -or -not $u.token) { continue }
        $uname = ([string]$u.name).Trim().ToLower()
        if ($uname -notmatch '^[a-z0-9][a-z0-9_-]{0,31}$') { continue }
        if ($OnlyUsers -and $OnlyUsers.Count -gt 0) {
            $lowerFilter = @($OnlyUsers | ForEach-Object { $_.ToLower() })
            if ($lowerFilter -notcontains $uname) { continue }
        }
        $list += [pscustomobject]@{ name = $uname; token = [string]$u.token }
    }
    return $list
}

function Get-IPs {
    return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |
        Select-Object -ExpandProperty IPAddress -Unique)
}

function Show-IsolationStatus {
    Write-Host '========== AGY Windows 用户级隔离状态 ==========' -ForegroundColor Cyan
    Write-Host ('管理员权限: ' + $(if (Test-IsAdmin) { '是' } else { '否（修改系统隔离需以管理员运行 Setup-Isolation-Admin.cmd）' }))

    if (Test-Path -LiteralPath $portMapFile) {
        try {
            $pm = (Read-Utf8NoBom $portMapFile) | ConvertFrom-Json
            Write-Host ''
            Write-Host '端口分配映射 (isolation\port-map.json):' -ForegroundColor Cyan
            foreach ($prop in $pm.PSObject.Properties) {
                $v = $prop.Value
                Write-Host ("  - $($prop.Name): winUser=$($v.winUser) portal=$($v.portalPort) relay=$($v.relayPort)")
            }
        } catch { Warn ('读取 port-map.json 失败: ' + $_.Exception.Message) }
    } else {
        Write-Host '端口分配映射: 尚未启用 Full 隔离'
    }

    Write-Host ''
    Write-Host '本地 agy-* Windows 账号:' -ForegroundColor Cyan
    $localUsers = @(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'agy-*' })
    if ($localUsers.Count -eq 0) {
        Write-Host '  （无）'
    } else {
        foreach ($lu in $localUsers) {
            Write-Host ("  - $($lu.Name)  Enabled=$($lu.Enabled)  LastLogon=$($lu.LastLogon)")
        }
    }

    Write-Host ''
    Write-Host '计划任务 (AGY-Server-User-*):' -ForegroundColor Cyan
    $tasks = @(Get-ScheduledTask -TaskName 'AGY-Server-User-*' -ErrorAction SilentlyContinue)
    if ($tasks.Count -eq 0) {
        Write-Host '  （无）'
    } else {
        foreach ($t in $tasks) {
            Write-Host ("  - $($t.TaskName)  State=$($t.State)")
        }
    }

    Write-Host ''
    Write-Host ('目录 ACL (' + $usersDir + '\*):') -ForegroundColor Cyan
    if (Test-Path -LiteralPath $usersDir) {
        foreach ($d in @(Get-ChildItem -LiteralPath $usersDir -Directory -ErrorAction SilentlyContinue)) {
            $acl = Get-Acl -LiteralPath $d.FullName -ErrorAction SilentlyContinue
            if ($acl) {
                $rules = @($acl.Access | ForEach-Object { "$($_.IdentityReference):$($_.FileSystemRights)" }) -join ' | '
                Write-Host ("  - $($d.Name) [InheritedProtected=$($acl.AreAccessRulesProtected)]: $rules")
            }
        }
    }
}

if ($Mode -eq 'Status') {
    Show-IsolationStatus
    exit 0
}

if (-not (Test-IsAdmin)) {
    Warn ('模式 ' + $Mode + ' 需要管理员权限！请双击 ' + (Join-Path $root 'Setup-Isolation-Admin.cmd'))
    exit 1
}

$ownerAccount = Get-PrimaryOwnerAccount
Write-Host ('[*] 主账号参考: ' + $ownerAccount) -ForegroundColor Cyan

if ($Mode -eq 'AclOnly') {
    Step '执行降级方案：清理独立计划任务并启用目录 ACL 保护（主服务与 Syncthing 由主账号运行）...'
    Remove-IsoTasksAndFirewall
    $users = Get-ConfigUsers
    New-Item -ItemType Directory -Force -Path $usersDir | Out-Null
    Set-AdminOnlyAcl -Path $usersFile -OwnerAccount $ownerAccount
    Set-AdminOnlyAcl -Path $mainLinksFile -OwnerAccount $ownerAccount
    Set-AdminOnlyAcl -Path $usersDir -OwnerAccount $ownerAccount -IsDirectory
    foreach ($privDir in @((Join-Path $root 'logs'), (Join-Path $root 'workspace'), (Join-Path $root 'syncthing'))) {
        if (Test-Path -LiteralPath $privDir) {
            Set-AdminOnlyAcl -Path $privDir -OwnerAccount $ownerAccount -IsDirectory
        }
    }
    foreach ($rxReset in @($portalMjs, $nodeModulesDir, (Join-Path $root 'tools'))) {
        if (Test-Path -LiteralPath $rxReset) {
            try { Invoke-Icacls @($rxReset, '/reset') } catch {}
        }
    }
    foreach ($u in $users) {
        $dir = Join-Path $usersDir $u.name
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Set-AdminOnlyAcl -Path $dir -OwnerAccount $ownerAccount -IsDirectory
        Ok ('已启用目录 ACL 保护（仅管理员/SYSTEM/主账号可读写）: ' + $dir)
    }
    Ok '降级方案完成：其他本地 Windows 账号已无法读取 users\* 与 users.json，且不影响主服务和 Syncthing。'
    exit 0
}

if ($Mode -eq 'Revert') {
    Step '正在回滚用户级隔离（保留所有成员目录文件）...'
    Remove-IsoTasksAndFirewall

    foreach ($p in @($usersFile, $mainLinksFile, $portalMjs, $nodeModulesDir, (Join-Path $root 'tools'), (Join-Path $root 'logs'), (Join-Path $root 'workspace'), (Join-Path $root 'syncthing'), $usersDir, $isoDir, $isoUsersDir)) {
        if (Test-Path -LiteralPath $p) {
            try { Invoke-Icacls @($p, '/reset') } catch { Warn ('重置 ACL 失败: ' + $p + ' -> ' + $_.Exception.Message) }
        }
    }
    if (Test-Path -LiteralPath $usersDir) {
        foreach ($d in @(Get-ChildItem -LiteralPath $usersDir -Directory -ErrorAction SilentlyContinue)) {
            try {
                Invoke-Icacls @($d.FullName, '/reset')
                Ok ('已恢复默认继承 ACL: ' + $d.FullName)
            } catch {
                Warn ('恢复 ACL 失败: ' + $d.FullName + ' -> ' + $_.Exception.Message)
            }
        }
    }

    if ($RemoveUsers) {
        $localUsers = @(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'agy-*' })
        foreach ($lu in $localUsers) {
            Remove-LocalUser -Name $lu.Name -ErrorAction SilentlyContinue
            Ok ('已删除本地 Windows 账号: ' + $lu.Name)
        }
    } else {
        Write-Host '[*] 保留了本地 Windows 账号（如需同时删除，请附加 -RemoveUsers 参数）' -ForegroundColor DarkGray
    }

    Ok '隔离回滚完成（所有用户文件已完整保留）。'
    exit 0
}

# ---- Mode: Full ----
Step '开始配置 Windows 用户级完整隔离（幂等可重入）...'
$users = Get-ConfigUsers
if ($users.Count -eq 0) { Warn 'users.json 中没有有效成员'; exit 1 }
if (-not $nodeExe) { throw '找不到 node.exe' }

New-Item -ItemType Directory -Force -Path $isoDir, $isoUsersDir, $sharedAgyDir, $usersDir | Out-Null

if ($srcAgyExe -and (Test-Path -LiteralPath $srcAgyExe)) {
    $needCopy = $true
    if (Test-Path -LiteralPath $sharedAgyExe) {
        $sItem = Get-Item -LiteralPath $srcAgyExe
        $dItem = Get-Item -LiteralPath $sharedAgyExe
        if ($sItem.Length -eq $dItem.Length -and $sItem.LastWriteTimeUtc -eq $dItem.LastWriteTimeUtc) {
            $needCopy = $false
        }
    }
    if ($needCopy) {
        Step ('同步共享 agy.exe 到 ' + $sharedAgyExe)
        Copy-Item -LiteralPath $srcAgyExe -Destination $sharedAgyExe -Force
    }
} elseif (-not (Test-Path -LiteralPath $sharedAgyExe)) {
    throw '未找到 agy.exe，请先安装官方 agy CLI 或设置 AGY_EXE_PATH'
}

Set-AdminOnlyAcl -Path $usersFile -OwnerAccount $ownerAccount
Set-AdminOnlyAcl -Path $mainLinksFile -OwnerAccount $ownerAccount
foreach ($privDir in @((Join-Path $root 'logs'), (Join-Path $root 'workspace'), (Join-Path $root 'syncthing'))) {
    if (Test-Path -LiteralPath $privDir) {
        Set-AdminOnlyAcl -Path $privDir -OwnerAccount $ownerAccount -IsDirectory
    }
}
Set-TraverseOnlyAcl -Path $usersDir -OwnerAccount $ownerAccount
Set-TraverseOnlyAcl -Path $isoDir -OwnerAccount $ownerAccount
Set-TraverseOnlyAcl -Path $isoUsersDir -OwnerAccount $ownerAccount

foreach ($rxItem in @(
    @{ Path = $portalMjs; Dir = $false },
    @{ Path = (Join-Path $root 'public'); Dir = $true },
    @{ Path = (Join-Path $root 'tools'); Dir = $true },
    @{ Path = $nodeModulesDir; Dir = $true }
)) {
    if (Test-Path -LiteralPath $rxItem.Path) {
        $f = if ($rxItem.Dir) { '(OI)(CI)RX' } else { 'RX' }
        $fAdmin = if ($rxItem.Dir) { '(OI)(CI)F' } else { 'F' }
        $grants = @("BUILTIN\Administrators:$fAdmin", "NT AUTHORITY\SYSTEM:$fAdmin", "BUILTIN\Users:$f")
        if ($ownerAccount -and $ownerAccount -notmatch '^(BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM)$') {
            $grants += "${ownerAccount}:$fAdmin"
        }
        Set-CleanAcl -Path $rxItem.Path -Grants $grants
    }
}

$portMap = [ordered]@{}
$usedPorts = New-Object System.Collections.Generic.HashSet[int]
if (Test-Path -LiteralPath $portMapFile) {
    try {
        $oldPm = (Read-Utf8NoBom $portMapFile) | ConvertFrom-Json
        foreach ($prop in $oldPm.PSObject.Properties) {
            $portMap[$prop.Name] = $prop.Value
            [void]$usedPorts.Add([int]$prop.Value.portalPort)
            [void]$usedPorts.Add([int]$prop.Value.relayPort)
        }
    } catch {}
}

$credMap = @{}
if (Test-Path -LiteralPath $credJson) {
    try {
        $oldCred = (Read-Utf8NoBom $credJson) | ConvertFrom-Json
        foreach ($prop in $oldCred.PSObject.Properties) {
            $credMap[$prop.Name] = [string]$prop.Value
        }
    } catch {}
}

$usedWinNames = @{}
foreach ($k in $portMap.Keys) {
    if ($portMap[$k].winUser) { $usedWinNames[[string]$portMap[$k].winUser] = $true }
}

$nextPort = 3100
$ips = Get-IPs
$credLines = New-Object System.Collections.Generic.List[string]
$credLines.Add('# AGY Windows 隔离账号凭据（仅管理员可读） · ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$credLines.Add('')

$linkLines = New-Object System.Collections.Generic.List[string]
$linkLines.Add('# AGY 用户级隔离访问链接 · ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$linkLines.Add('# 注意：每个用户拥有独立的 Portal 端口与 Windows 本地账号，首次使用前需登录一次 Google。')
$linkLines.Add('')

$loginCmdPath = Join-Path $isoDir 'Login-User.cmd'

foreach ($u in $users) {
    $uname = $u.name
    if ($portMap.Contains($uname)) {
        $winUser = [string]$portMap[$uname].winUser
        $portalPort = [int]$portMap[$uname].portalPort
        $relayPort = [int]$portMap[$uname].relayPort
    } else {
        $winUser = Get-SafeWinUsername $uname $usedWinNames
        while ($usedPorts.Contains($nextPort) -or $usedPorts.Contains($nextPort + 1)) {
            $nextPort += 2
        }
        $portalPort = $nextPort
        $relayPort = $nextPort + 1
        [void]$usedPorts.Add($portalPort)
        [void]$usedPorts.Add($relayPort)
        $portMap[$uname] = [pscustomobject]@{
            winUser = $winUser
            portalPort = $portalPort
            relayPort = $relayPort
        }
    }

    $existingWinUser = Get-LocalUser -Name $winUser -ErrorAction SilentlyContinue
    $plainPass = if ($credMap.ContainsKey($winUser)) { $credMap[$winUser] } else { '' }

    if (-not $existingWinUser) {
        if (-not $plainPass) { $plainPass = New-StrongPassword }
        $sec = ConvertTo-SecureString $plainPass -AsPlainText -Force
        New-LocalUser -Name $winUser -Password $sec -FullName ('AGY Isolated ' + $uname) -Description ('AGY isolated service user for ' + $uname) -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
        try { Add-LocalGroupMember -Group 'Users' -Member $winUser -ErrorAction SilentlyContinue } catch {}
        Ok ('已创建本地用户: ' + $winUser)
    } else {
        if ($ResetPasswords -or -not $plainPass) {
            $plainPass = New-StrongPassword
            $sec = ConvertTo-SecureString $plainPass -AsPlainText -Force
            Set-LocalUser -Name $winUser -Password $sec -PasswordNeverExpires $true -UserMayChangePassword $false
            Ok ('已重置本地用户密码: ' + $winUser)
        } else {
            Ok ('本地用户已存在（保留密码）: ' + $winUser)
        }
    }
    $credMap[$winUser] = $plainPass

    $userDataDir = Join-Path $usersDir $uname
    New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
    Set-UserDirAcl -Path $userDataDir -WinUser $winUser -OwnerAccount $ownerAccount
    Ok ("已设置目录严格 ACL ($winUser + $ownerAccount + Administrators + SYSTEM): $userDataDir")

    $uIsoDir = Join-Path $isoUsersDir $uname
    $uIsoLogs = Join-Path $uIsoDir 'logs'
    New-Item -ItemType Directory -Force -Path $uIsoDir, $uIsoLogs | Out-Null

    $uCfgFile = Join-Path $uIsoDir 'users.json'
    $singleCfg = [ordered]@{
        portalPort = $portalPort
        relayPort = $relayPort
        users = @([ordered]@{ name = $uname; token = $u.token })
    }
    Write-Utf8NoBom $uCfgFile ($singleCfg | ConvertTo-Json -Depth 6)

    $runnerPs1 = Join-Path $uIsoDir 'run-user-server.ps1'
    $runnerBody = @"
`$ErrorActionPreference = 'Continue'
`$uname = '$uname'
`$userDir = '$userDataDir'
`$isoDir = '$uIsoDir'
`$logDir = '$uIsoLogs'
`$portalPort = $portalPort
`$relayPort = $relayPort
`$node = '$nodeExe'
`$wsMain = '$root\node_modules\@rebornix\stdio-to-ws\dist\main.js'
`$launcher = '$isoLauncher'
`$portalJs = '$portalMjs'

New-Item -ItemType Directory -Force -Path `$logDir | Out-Null
if (-not `$env:USERPROFILE) { `$env:USERPROFILE = [Environment]::GetFolderPath('UserProfile') }
if (-not `$env:HOME) { `$env:HOME = `$env:USERPROFILE }
if (-not `$env:LOCALAPPDATA) { `$env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData') }
if (-not `$env:APPDATA) { `$env:APPDATA = [Environment]::GetFolderPath('ApplicationData') }
`$env:AGY_EXE_PATH = '$sharedAgyExe'
`$env:AGY_CFG_FILE = '$uCfgFile'
`$env:AGY_ONLY_USER = '$uname'
`$env:AGY_PORTAL_PORT = [string]`$portalPort
`$env:AGY_RELAY_PORT = [string]`$relayPort
`$env:AGY_LOG_DIR = `$logDir

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { `$_.CommandLine -like "*--port `$relayPort*" -or `$_.CommandLine -like "*--iso-user=`$uname*" } |
    ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 600

`$cmdArg = '"' + `$node + ' ' + `$launcher + ' cli acp"'
Start-Process -FilePath `$node -ArgumentList @(`$wsMain, `$cmdArg, '--port', [string]`$relayPort, '--persist', '--grace-period', '-1') `
    -WorkingDirectory `$userDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path `$logDir 'acp-ws.log') `
    -RedirectStandardError (Join-Path `$logDir 'acp-ws.err')

Start-Process -FilePath `$node -ArgumentList @(`$portalJs, "--iso-user=`$uname") `
    -WorkingDirectory `$userDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path `$logDir 'portal.log') `
    -RedirectStandardError (Join-Path `$logDir 'portal.err')
"@
    Write-Utf8Bom $runnerPs1 $runnerBody
    Set-UserDirAcl -Path $uIsoDir -WinUser $winUser

    $taskName = 'AGY-Server-User-' + $uname
    $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runnerPs1`"" `
        -WorkingDirectory $userDataDir
    $taskTrigger = New-ScheduledTaskTrigger -AtStartup
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Days 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings `
        -User "$env:COMPUTERNAME\$winUser" -Password $plainPass -Force | Out-Null
    Ok ("已注册计划任务: $taskName (用户=$winUser, Portal=:$portalPort, Relay=127.0.0.1:$relayPort)")

    $fwName = 'AGY-Server-User-' + $uname
    & netsh advfirewall firewall delete rule name="$fwName" | Out-Null
    & netsh advfirewall firewall add rule name="$fwName" dir=in action=allow protocol=TCP localport=$portalPort profile=any | Out-Null

    if ($StartTasks) {
        Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }

    $credLines.Add("[$uname] winUser=$winUser | password=$plainPass | portalPort=$portalPort | relayPort=$relayPort")
    $linkLines.Add("### $uname (Windows 账号: $winUser | Portal 端口: $portalPort)")
    foreach ($ip in $ips) {
        $linkLines.Add("  工作台: http://${ip}:${portalPort}/?t=$($u.token)")
        $linkLines.Add("  agent : ws://${ip}:${portalPort}/agent?t=$($u.token)")
    }
    $linkLines.Add("  首次登录 Google 命令: `"$loginCmdPath`" $uname")
    $linkLines.Add('')
}

Write-Utf8NoBom $portMapFile ($portMap | ConvertTo-Json -Depth 6)
Set-AdminOnlyAcl -Path $portMapFile -OwnerAccount $ownerAccount

$credObj = [ordered]@{}
foreach ($k in $credMap.Keys) { $credObj[$k] = $credMap[$k] }
Write-Utf8NoBom $credJson ($credObj | ConvertTo-Json -Depth 4)
Set-AdminOnlyAcl -Path $credJson -OwnerAccount $ownerAccount

Write-Utf8Bom $credTxt ($credLines -join "`r`n")
Set-AdminOnlyAcl -Path $credTxt -OwnerAccount $ownerAccount

Write-Utf8Bom $isoLinksFile ($linkLines -join "`r`n")
Set-AdminOnlyAcl -Path $isoLinksFile -OwnerAccount $ownerAccount

Write-Host ''
Ok 'Windows 用户级隔离配置完成！'
Write-Host ('[*] 账号密码已保存到（仅管理员可读）: ' + $credTxt) -ForegroundColor Cyan
Write-Host ('[*] 独立访问链接已保存到: ' + $isoLinksFile) -ForegroundColor Cyan
Write-Host ''
Write-Host '下一步操作（每个新增成员只需做一次）：' -ForegroundColor Yellow
Write-Host '  为每个用户运行一次 Google 授权登录（凭据管理器按 Windows 用户隔离）：' -ForegroundColor Yellow
foreach ($u in $users) {
    Write-Host ("    `"$loginCmdPath`" $($u.name)") -ForegroundColor White
}
Write-Host '  登录完成后启动对应计划任务：' -ForegroundColor Yellow
foreach ($u in $users) {
    Write-Host ("    Start-ScheduledTask -TaskName `"AGY-Server-User-$($u.name)`"") -ForegroundColor White
}
exit 0
