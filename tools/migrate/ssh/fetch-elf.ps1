#Requires -Version 5.1
<#
.SYNOPSIS
    在【小电脑】上：从参考机拉回编译好的固件，然后本地烧录。

.DESCRIPTION
    远端编译 + 本地烧录的分工：编译在参考机上做（快），
    ST-Link 插在小电脑上（必须本地写），所以把 elf 拉回来再烧。

.PARAMETER Alias
    ~/.ssh/config 里的别名，默认 boat。

.PARAMETER RemoteRepo
    参考机上仓库的绝对路径，默认 E:/STM32/BOAT。

.PARAMETER Dest
    拉回后放的本地目录，默认 <仓库>/_remote。

.PARAMETER Build
    先让参考机编译一次（调用 Remote-Build.ps1），再拉。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\migrate\ssh\fetch-elf.ps1 -Build
#>
[CmdletBinding()]
param(
    [string]$Alias = 'boat',
    [string]$RemoteRepo = 'E:/STM32/BOAT',
    [string]$Dest = '',
    [switch]$Build
)

$ErrorActionPreference = 'Stop'
function Ok   { param($m) Write-Host ('  [OK] ' + $m) -ForegroundColor Green }
function Warn { param($m) Write-Host ('  [!]  ' + $m) -ForegroundColor Yellow }
function Bad  { param($m) Write-Host ('  [X]  ' + $m) -ForegroundColor Red }

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $Dest) { $Dest = Join-Path $repoRoot '_remote' }
if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }

$remoteRepo = $RemoteRepo.TrimEnd('/')

if ($Build) {
    Write-Host ''
    Write-Host '>>> 远程编译' -ForegroundColor Cyan
    $cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $remoteRepo + '/tools/migrate/ssh/Remote-Build.ps1"'
    & ssh.exe $Alias $cmd
    if ($LASTEXITCODE -ne 0) { Bad ('远程编译失败（' + $LASTEXITCODE + '）'); exit $LASTEXITCODE }
}

Write-Host ''
Write-Host '>>> 拉回固件' -ForegroundColor Cyan
foreach ($f in @('Debug/BOAT.elf', 'Debug/BOAT.map')) {
    $remote = $remoteRepo + '/' + $f
    $local  = Join-Path $Dest (Split-Path -Leaf $f)
    & scp.exe ('{0}:{1}' -f $Alias, $remote) $local
    if ($LASTEXITCODE -ne 0) { Bad ('拉取失败: ' + $remote); exit 1 }
    Ok ('已拉回 ' + $local + ' (' + [math]::Round((Get-Item $local).Length / 1KB) + ' KB)')
}

Write-Host ''
Write-Host ('  下一步烧录:  powershell -ExecutionPolicy Bypass -File tools\migrate\dev.ps1 flash -Elf "' + (Join-Path $Dest 'BOAT.elf') + '"') -ForegroundColor White
exit 0
