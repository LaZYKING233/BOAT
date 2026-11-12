#Requires -Version 5.1
<#
.SYNOPSIS
    在【参考机】上启用 OpenSSH Server，只对 Tailscale 网段开放，供远端 VS Code Remote-SSH 使用。

.DESCRIPTION
    - 安装 Windows 自带 OpenSSH Server（可选功能）；失败则回退到 Win32-OpenSSH
    - 备份并写入一份加固的 sshd_config（默认密钥登录，可选保留密码登录作为兜底）
    - 生成/追加 authorized_keys（用户级 .ssh/authorized_keys，并收紧 ACL）
    - 防火墙规则只放行 Tailscale 网卡地址上的端口，不对公网开放
    - 启动 sshd 并设置开机自启，最后打印主机密钥指纹和客户端连接命令

    必须用管理员权限运行；不是管理员时会自动以管理员身份重新启动自己。

.PARAMETER PublicKey
    客户端公钥（ssh-ed25519 AAAA... 或 ssh-rsa AAAA...）。给了就写入 authorized_keys。

.PARAMETER KeepPasswordAuth
    保留密码登录。默认：给了 -PublicKey 就关掉密码登录，没给就保留（避免把自己锁在门外）。

.PARAMETER Port
    sshd 监听端口，默认 22。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File Enable-BoatSshd.ps1 -PublicKey "ssh-ed25519 AAAA... boat"
#>
[CmdletBinding()]
param(
    [string]$PublicKey = '',
    [switch]$KeepPasswordAuth,
    [switch]$SkipCapability,
    [int]$Port = 22
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
$LogFile = Join-Path $env:TEMP 'boat-sshd-setup.log'

function Log {
    param($m, $c = 'Gray')
    $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
    try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
    Write-Host $m -ForegroundColor $c
}
function Step { param($m) Log ''; Log ('>>> ' + $m) Cyan }
function Ok   { param($m) Log ('  [OK] ' + $m) Green }
function Warn { param($m) Log ('  [!]  ' + $m) Yellow }
function Bad  { param($m) Log ('  [X]  ' + $m) Red }

function Invoke-Soft {
    # 原生命令会把警告写到 stderr，在 ErrorActionPreference=Stop 下会被当成终止错误
    param([scriptblock]$Block)
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & $Block 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
        }
        $out = ($lines -join [Environment]::NewLine)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
    return [pscustomobject]@{ Output = $out; Code = $code }
}

trap {
    Log ('未捕获的异常: ' + $_.Exception.Message) Red
    Log ('位置: ' + $_.InvocationInfo.PositionMessage) Red
    exit 1
}

# ---------------------------------------------------------------- 提权

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Log '不是管理员权限，正在请求提权……' Yellow
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath))
    if ($PublicKey) { $argv += @('-PublicKey', ('"{0}"' -f $PublicKey)) }
    if ($KeepPasswordAuth) { $argv += '-KeepPasswordAuth' }
    if ($SkipCapability) { $argv += '-SkipCapability' }
    if ($Port -ne 22) { $argv += @('-Port', $Port) }
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argv
    Log '已弹出 UAC 窗口，请在桌面上点「是」。这个窗口可以关掉了。' Yellow
    exit 0
}

Log '==============================================' White
Log ' BOAT OpenSSH Server 配置' White
Log (' 机器: ' + $env:COMPUTERNAME + '   用户: ' + $identity.Name) DarkGray
Log '==============================================' White

# ---------------------------------------------------------------- 1. 安装

$freeC = 0
try { $freeC = [math]::Round((Get-PSDrive C).Free / 1GB, 2) } catch { }
if ($freeC -gt 0 -and $freeC -lt 1) {
    Warn ('C 盘只剩 ' + $freeC + ' GB —— 实测 0.3 GB 时 OpenSSH 服务会装不全，建议先清空间')
} else {
    Log ('  C 盘可用: ' + $freeC + ' GB')
}

Step '1/6 安装 OpenSSH Server'
$sshdExe  = 'C:\Windows\System32\OpenSSH\sshd.exe'
$capState = $null
if ($SkipCapability) {
    Warn '按 -SkipCapability 跳过 Windows 可选功能，直接用 Win32-OpenSSH'
} else {
    try {
        $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction Stop | Select-Object -First 1
        $capState = $cap.State
        Log ('  当前状态: ' + $capState)
    } catch { Warn ('查不到可选的 OpenSSH.Server: ' + $_.Exception.Message) }
}

if ($capState -eq 'Installed' -and (Test-Path $sshdExe)) {
    Ok 'OpenSSH Server 已安装'
} else {
    if ($capState -eq 'NotPresent' -or $capState -eq 'InstallPending') {
        Log '  正在安装 Windows 可选功能（可能要 1-3 分钟）……'
        try {
            Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
            Ok '可选功能安装完成'
        } catch { Warn ('可选功能安装失败: ' + $_.Exception.Message) }
    }
    if (-not (Test-Path $sshdExe)) {
        $portable = 'C:\Program Files\OpenSSH\sshd.exe'
        if (Test-Path $portable) {
            $sshdExe = $portable
            Ok '检测到已装的 Win32-OpenSSH，跳过下载'
        }
    }
    if (-not (Test-Path $sshdExe)) {
        Warn '系统里没有 sshd.exe，回退到 Win32-OpenSSH'
        $zip = Join-Path $env:TEMP 'OpenSSH-Win64.zip'
        $url = 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.4.0.0p1-Preview/OpenSSH-Win64.zip'
        Log ('  下载 ' + $url)
        try {
            & curl.exe -L --fail --retry 3 -sS -o $zip $url
            if ($LASTEXITCODE -ne 0) { throw ('curl 退出码 ' + $LASTEXITCODE) }
            $dst = 'C:\Program Files\OpenSSH'
            if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Force -Path $dst | Out-Null }
            Expand-Archive -LiteralPath $zip -DestinationPath $env:TEMP -Force
            Copy-Item (Join-Path $env:TEMP 'OpenSSH-Win64\*') $dst -Recurse -Force
            & (Join-Path $dst 'Install-sshd.ps1')
            $sshdExe = Join-Path $dst 'sshd.exe'
            Ok ('便携版 OpenSSH 安装到 ' + $dst)
        } catch {
            Bad ('回退安装也失败: ' + $_.Exception.Message)
            Log '  手工方案：设置 -> 系统 -> 可选功能 -> 添加功能 -> OpenSSH 服务器' White
            exit 1
        }
    } else {
        Ok 'sshd.exe 已就位'
    }
}

# ---------------------------------------------------------------- 2. 配置

Step '2/6 写入 sshd_config'
$sshDir = 'C:\ProgramData\ssh'
if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Force -Path $sshDir | Out-Null }
$cfg = Join-Path $sshDir 'sshd_config'
if (Test-Path $cfg) {
    $bak = $cfg + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item $cfg $bak -Force
    Ok ('已备份原配置: ' + $bak)
}

$passwordAuth = if ($PublicKey -and -not $KeepPasswordAuth) { 'no' } else { 'yes' }
if ($passwordAuth -eq 'yes') { Warn '密码登录保持开启（没提供公钥，或显式 -KeepPasswordAuth）' }

$config = @"
# BOAT: 由 tools/migrate/ssh/Enable-BoatSshd.ps1 生成
# 重新生成会覆盖本文件；原文件已备份为 sshd_config.bak-*

Port $Port
ListenAddress 0.0.0.0
HostKey __PROGRAMDATA__/ssh/ssh_host_ed25519_key
HostKey __PROGRAMDATA__/ssh/ssh_host_rsa_key
HostKey __PROGRAMDATA__/ssh/ssh_host_ecdsa_key

SyslogFacility LOCAL0
LogLevel VERBOSE
LoginGraceTime 30
MaxAuthTries 4
MaxSessions 10
TCPKeepAlive yes
UseDNS no

PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
PasswordAuthentication $passwordAuth
PermitEmptyPasswords no
KbdInteractiveAuthentication no
PermitRootLogin no

AllowAgentForwarding yes
AllowTcpForwarding yes
PermitTTY yes
X11Forwarding no
PrintMotd no
PrintLastLog no

Subsystem sftp sftp-server.exe
"@
[System.IO.File]::WriteAllText($cfg, $config, (New-Object System.Text.UTF8Encoding($false)))
Ok ('已写入 ' + $cfg + '（密码登录: ' + $passwordAuth + '）')

# ---------------------------------------------------------------- 3. 主机密钥

Step '3/6 主机密钥'
$binDir = Split-Path -Parent $sshdExe
$keygen = Join-Path $binDir 'ssh-keygen.exe'
if (-not (Test-Path $keygen)) { $keygen = 'ssh-keygen.exe' }

foreach ($t in @('ed25519', 'rsa', 'ecdsa')) {
    $kp = Join-Path $sshDir ('ssh_host_' + $t + '_key')
    if (Test-Path $kp) { Ok ('ssh_host_' + $t + '_key 已存在'); continue }
    $r = Invoke-Soft { & $keygen -t $t -f $kp -N '""' -q }
    if (Test-Path $kp) { Ok ('已生成 ssh_host_' + $t + '_key') }
    else { Warn ('生成 ssh_host_' + $t + '_key 失败: ' + $r.Output) }
}
$check = Invoke-Soft { & $sshdExe -t }
if ($check.Code -eq 0) { Ok 'sshd_config 校验通过' }
else { Warn ('sshd_config 校验报错（退出码 ' + $check.Code + '）'); Warn $check.Output }

# ---------------------------------------------------------------- 4. 公钥

Step '4/6 authorized_keys'
$keyDir = Join-Path $env:USERPROFILE '.ssh'
if (-not (Test-Path $keyDir)) { New-Item -ItemType Directory -Force -Path $keyDir | Out-Null }
$authKeys = Join-Path $keyDir 'authorized_keys'

if ($PublicKey) {
    $pub = $PublicKey.Trim()
    $existing = @()
    if (Test-Path $authKeys) { $existing = @(Get-Content -LiteralPath $authKeys) }
    $pubBody = ($pub -split '\s+')[1]
    $dup = $existing | Where-Object { $_.Contains($pubBody) }
    if ($dup) {
        Ok '公钥已存在，跳过'
    } else {
        Add-Content -LiteralPath $authKeys -Value $pub -Encoding ASCII
        Ok ('已追加公钥到 ' + $authKeys)
    }
    & icacls.exe $authKeys /inheritance:r /grant:r ($env:USERNAME + ':(R)') /grant:r 'SYSTEM:(R)' /grant:r 'Administrators:(R)' | Out-Null
    Ok ('已收紧 ' + $authKeys + ' 的 ACL')
} else {
    if (Test-Path $authKeys) { Ok ($authKeys + ' 已存在（未改动）') }
    else {
        Warn '没有提供公钥，先保留密码登录'
        Warn '拿到客户端公钥后重跑: Enable-BoatSshd.ps1 -PublicKey "ssh-ed25519 AAAA..."'
    }
}

# ---------------------------------------------------------------- 5. 防火墙

Step '5/6 防火墙（只放行 Tailscale）'
$tailIp = $null
try {
    $tailIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
               Where-Object { $_.InterfaceAlias -like 'Tailscale*' } |
               Select-Object -First 1).IPAddress
} catch { }

$ruleName = 'BOAT-SSHD-Tailnet-' + $Port
Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

if ($tailIp) {
    New-NetFirewallRule -Name $ruleName -DisplayName ('BOAT OpenSSH ' + $Port + ' (Tailscale only)') -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -LocalAddress $tailIp -Profile Any | Out-Null
    Ok ('已放行 ' + $tailIp + ':' + $Port + '（其它来源不放行）')
} else {
    Warn '没找到 Tailscale 网卡地址，跳过防火墙规则'
    Warn 'Tailscale 起来后重跑本脚本即可'
}

# ---------------------------------------------------------------- 6. 服务

Step '6/6 启动服务'
$installScript = 'C:\Program Files\OpenSSH\install-sshd.ps1'

$svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
if (-not $svc) {
    if (Test-Path $installScript) { Invoke-Soft { & $installScript } | Out-Null }
    $svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
}
if (-not $svc) { Bad 'sshd 服务不存在，安装没成功'; exit 1 }

function Start-SshdService {
    $cur = Get-Service -Name sshd
    if ($cur.Status -ne 'Running') { Start-Service -Name sshd } else { Restart-Service -Name sshd }
    Start-Sleep -Seconds 2
    return (Get-Service -Name sshd)
}

$started = $false
try { $svc = Start-SshdService; $started = ($svc.Status -eq 'Running') } catch { $started = $false }

if (-not $started) {
    # 实测踩过的坑：Install-sshd.ps1 在一次没跑完的安装里（当时 C 盘只剩 0.3 GB）注册了服务，
    # 但一启动就退出、连 sshd.log 都不写。重跑一次安装脚本就修好了。
    Warn '服务起不来，尝试自动修复：重跑 install-sshd.ps1'
    if (Test-Path $installScript) {
        $rep = Invoke-Soft { & $installScript }
        Log ('  ' + (($rep.Output -split [Environment]::NewLine | Where-Object { $_.Trim() }) -join ' / ')) DarkGray
    }
    try { $svc = Start-SshdService; $started = ($svc.Status -eq 'Running') } catch { $started = $false }
}

# 必须在 install-sshd 之后设置，它会把启动类型重置成"手动"
Set-Service -Name sshd -StartupType Automatic

if ($started) {
    $svc = Get-Service sshd
    Ok ('sshd 状态: ' + $svc.Status + ' / 启动类型: ' + $svc.StartType)
} else {
    Bad '服务启动失败'
    $svcLog = Join-Path $sshDir 'logs\sshd.log'
    if (Test-Path $svcLog) {
        Log '--- sshd.log 尾部 ---' Yellow
        Get-Content -LiteralPath $svcLog -Tail 40 | ForEach-Object { Log ('  ' + $_) DarkGray }
    } else {
        Warn ('没有 ' + $svcLog + '（sshd 在初始化日志之前就退出了）')
    }
    try {
        Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Service Control Manager'; StartTime=(Get-Date).AddMinutes(-5)} -ErrorAction Stop |
            Select-Object -First 3 | ForEach-Object { Log ('  SCM ' + $_.Id + ': ' + (($_.Message -split [Environment]::NewLine)[0])) DarkGray }
    } catch { }
    Warn '常见原因：C 盘空间不足（安装中途失败）、端口被占、host key 权限异常'
    exit 1
}

$listen = @()
try { $listen = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop) } catch { }
if ($listen.Count -gt 0) {
    Ok ('正在监听: ' + (($listen | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort }) -join ', '))
} else {
    Warn ('没看到 ' + $Port + ' 端口监听，检查事件日志: Get-WinEvent -LogName OpenSSH/Operational -MaxEvents 20')
}

# ---------------------------------------------------------------- 指纹

Step '主机密钥指纹（第一次连接时核对）'
try {
    $fp = (Invoke-Soft { & $keygen -lf (Join-Path $sshDir 'ssh_host_ed25519_key.pub') }).Output
    Log ('  ' + ($fp -join ([Environment]::NewLine + '  '))) White
} catch { Warn ('取指纹失败: ' + $_.Exception.Message) }

$hostAddr = if ($tailIp) { $tailIp } else { '<tailscale-ip>' }
Log ''
Log '================ 完成 ================' Green
Log '客户端连接命令：' White
Log ('  ssh ' + $env:USERNAME + '@' + $hostAddr) DarkGray
Log ''
Log ('VS Code: 装 Remote - SSH 扩展 -> Connect to Host -> ' + $hostAddr) White
Log ('日志: ' + $LogFile) DarkGray
Log ''
exit 0