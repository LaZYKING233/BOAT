#Requires -Version 5.1
<#
.SYNOPSIS
    在【小电脑】上生成 SSH 密钥，并写好 ~/.ssh/config 里的 boat 别名。

.DESCRIPTION
    跑完会打印一行公钥，把它贴回参考机（或者直接运行参考机上的
    Enable-BoatSshd.ps1 -PublicKey "..."）即可完成免密登录。

.PARAMETER HostName
    参考机的地址。用 Tailscale IP（100.x.y.z）或 MagicDNS 名（如 lazy.tail3e77b4.ts.net）。

.PARAMETER User
    参考机上的 Windows 用户名，默认 admin。

.PARAMETER Alias
    ~/.ssh/config 里的别名，默认 boat。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File New-BoatClientKey.ps1 -HostName 100.92.185.68
#>
[CmdletBinding()]
param(
    [string]$HostName = '',
    [string]$User = 'admin',
    [string]$Alias = 'boat',
    [int]$Port = 22,
    [switch]$Test
)

$ErrorActionPreference = 'Stop'

function Ok   { param($m) Write-Host ('  [OK] ' + $m) -ForegroundColor Green }
function Warn { param($m) Write-Host ('  [!]  ' + $m) -ForegroundColor Yellow }
function Bad  { param($m) Write-Host ('  [X]  ' + $m) -ForegroundColor Red }

if (-not $HostName) {
    $HostName = Read-Host '参考机地址（Tailscale IP 或 MagicDNS 名）'
    if (-not $HostName) { Bad '必须给地址'; exit 1 }
}

$sshDir  = Join-Path $env:USERPROFILE '.ssh'
$keyPath = Join-Path $sshDir ('boat_ed25519')
if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Force -Path $sshDir | Out-Null }

Write-Host ''
Write-Host '>>> 1/3 生成密钥' -ForegroundColor Cyan
if (Test-Path $keyPath) {
    Ok ('已有密钥: ' + $keyPath)
} else {
    & ssh-keygen.exe -t ed25519 -f $keyPath -N '""' -C ('boat@' + $env:COMPUTERNAME)
    if ($LASTEXITCODE -ne 0) { Bad 'ssh-keygen 失败'; exit 1 }
    Ok ('已生成: ' + $keyPath)
}

Write-Host ''
Write-Host '>>> 2/3 写 ~/.ssh/config' -ForegroundColor Cyan
$configPath = Join-Path $sshDir 'config'
$block = @(
    ('Host ' + $Alias),
    ('    HostName ' + $HostName),
    ('    User ' + $User),
    ('    Port ' + $Port),
    ('    IdentityFile ' + ($keyPath -replace '\\', '/')),
    ('    IdentitiesOnly yes'),
    ('    ServerAliveInterval 30'),
    ('    ServerAliveCountMax 4')
) -join [Environment]::NewLine

$config = if (Test-Path $configPath) { Get-Content -LiteralPath $configPath -Raw } else { '' }
if ($config -match ('(?m)^Host\s+' + [regex]::Escape($Alias) + '\s*$')) {
    # 备份后移除旧块，再追加新块
    $lines = $config -split '\r?\n'
    $out = New-Object System.Collections.ArrayList
    $skip = $false
    foreach ($l in $lines) {
        if ($l -match ('^Host\s+')) { $skip = ($l.Trim() -eq ('Host ' + $Alias)) }
        if (-not $skip) { [void]$out.Add($l) }
    }
    $config = ($out -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine
    Ok ('已替换 config 里旧的 Host ' + $Alias + ' 块')
}
[System.IO.File]::WriteAllText($configPath, ($config + [Environment]::NewLine + $block + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
Ok ('已写入 ' + $configPath + '  ->  Host ' + $Alias)

Write-Host ''
Write-Host '>>> 3/3 你的公钥（贴回参考机）' -ForegroundColor Cyan
$pub = (Get-Content -LiteralPath ($keyPath + '.pub') -Raw).Trim()
Write-Host ''
Write-Host $pub -ForegroundColor White
Write-Host ''
Ok ('以后直接: ssh ' + $Alias)

if ($Test) {
    Write-Host ''
    Write-Host '>>> 试连' -ForegroundColor Cyan
    & ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 $Alias 'hostname'
    if ($LASTEXITCODE -eq 0) { Ok '免密登录可用' } else { Warn ('连不上或还没加公钥（退出码 ' + $LASTEXITCODE + '）') }
}
