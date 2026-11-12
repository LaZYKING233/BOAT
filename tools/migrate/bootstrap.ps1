#Requires -Version 5.1
<#
.SYNOPSIS
    BOAT 便携开发环境安装器（在小电脑上跑一次）

.DESCRIPTION
    把参考机（E:\STM32\BOAT）上验证过的构建/烧录环境，在这台机器上重建出来。
    两种来源：
      A. 有离线包  -> -KitPath <_outdoor_kit 目录>   （不联网，最快）
      B. 没有离线包 -> 直接跑，从官方源下载并按 manifest.json 校验哈希

    安装完成后会在安装目录生成 env.ps1，并按需把工具目录追加到【用户 PATH】。
    不写系统 PATH，不改注册表，不需要管理员权限。

.PARAMETER InstallRoot
    工具链安装目录，默认 %LOCALAPPDATA%\boat-env

.PARAMETER KitPath
    离线包根目录（里面要有 env\gcc、env\make ...）

.PARAMETER Force
    即使已安装也重新复制/下载

.PARAMETER NoUserPath
    不修改用户 PATH，只用 env.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\migrate\bootstrap.ps1 -KitPath D:\_outdoor_kit

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\migrate\bootstrap.ps1
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'boat-env'),
    [string]$KitPath = '',
    [switch]$Force,
    [switch]$NoUserPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$ScriptDir = $PSScriptRoot
$RepoRoot  = (Resolve-Path -LiteralPath (Join-Path $ScriptDir '..\..')).Path
$Manifest  = Get-Content -LiteralPath (Join-Path $ScriptDir 'manifest.json') -Raw | ConvertFrom-Json
$CacheDir  = Join-Path $InstallRoot '_cache'
$script:Problems = New-Object System.Collections.ArrayList

function Step { param($m) Write-Host ""; Write-Host ">>> $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Bad  { param($m) Write-Host "  [X]  $m" -ForegroundColor Red; [void]$script:Problems.Add($m) }
function FreeGB { param($p) try { $d = New-Object System.IO.DriveInfo($p.Substring(0,2)); [math]::Round($d.AvailableFreeSpace / 1GB, 1) } catch { -1 } }

function Get-ToolPath { param($name) Join-Path $InstallRoot $name }

function Set-SessionPath {
    $dirs = @(
        (Join-Path (Get-ToolPath 'gcc') 'bin'),
        (Join-Path (Get-ToolPath 'make') 'bin'),
        (Join-Path (Get-ToolPath 'openocd') 'bin'),
        (Get-ToolPath 'node')
    )
    foreach ($d in $dirs) { if (Test-Path -LiteralPath $d) { $env:PATH = $d + ';' + $env:PATH } }
}

function Test-ArtifactHash {
    param($Path, $Algo, $Expect)
    if (-not $Expect) { return $true }
    if ($Algo -eq 'md5-base64') {
        $md5 = [System.Security.Cryptography.MD5]::Create()
        $fs = [System.IO.File]::OpenRead($Path)
        try { $actual = [Convert]::ToBase64String($md5.ComputeHash($fs)) }
        finally { $fs.Close(); $md5.Dispose() }
        return ($actual -eq $Expect)
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    return ($actual -eq $Expect.ToUpper())
}

function Save-Artifact {
    param($Url, $OutFile)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -L --fail --retry 3 --retry-delay 3 -C - -sS -o $OutFile $Url
        if ($LASTEXITCODE -ne 0) { throw "下载失败（curl 退出码 $LASTEXITCODE）: $Url" }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    }
}

function Expand-Artifact {
    param($Zip, $Marker, $Dest, $Name)
    $tmp = Join-Path $CacheDir ('unpack_' + $Name)
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Expand-Archive -LiteralPath $Zip -DestinationPath $tmp -Force
    $hit = Get-ChildItem -LiteralPath $tmp -Recurse -Filter $Marker -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $hit) { throw "解压后找不到 $Marker（压缩包结构可能变了）" }
    $root = Split-Path -Parent $hit.FullName
    if ((Split-Path -Leaf $root) -eq 'bin') { $root = Split-Path -Parent $root }
    if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
    if ($root -eq $tmp) {
        Move-Item -LiteralPath $tmp -Destination $Dest
    } else {
        Move-Item -LiteralPath $root -Destination $Dest
        Remove-Item -LiteralPath $tmp -Recurse -Force
    }
}

function Repair-ProjectPaths {
    $old = 'E:\STM32\BOAT'
    $fixed = 0
    foreach ($f in @((Join-Path $RepoRoot 'Debug\makefile'))) {
        if (-not (Test-Path -LiteralPath $f)) { continue }
        $orig = [System.IO.File]::ReadAllText($f)
        $t = $orig.Replace($RepoRoot, $old).Replace($old, $RepoRoot)
        if ($t -ne $orig) {
            [System.IO.File]::WriteAllText($f, $t, [System.Text.Encoding]::ASCII)
            $fixed++
        }
    }
    if ($fixed -gt 0) { Ok "已把 Debug\makefile 里的绝对路径修正为 $RepoRoot" }
    else { Ok "构建文件路径无需修正" }
}

# ---------------------------------------------------------------- 开始

Write-Host ""
Write-Host "=======================================================" -ForegroundColor White
Write-Host "  BOAT 便携开发环境安装器" -ForegroundColor White
Write-Host "  工程目录 : $RepoRoot" -ForegroundColor DarkGray
Write-Host "  安装目录 : $InstallRoot" -ForegroundColor DarkGray
Write-Host "  安装来源 : $(if ($KitPath) { '离线包 ' + $KitPath } else { '官方源下载' })" -ForegroundColor DarkGray
Write-Host "=======================================================" -ForegroundColor White

Step "0/5 环境检查"
if (-not [Environment]::Is64BitOperatingSystem) { Bad "需要 64 位 Windows"; exit 1 }
Ok ("操作系统: " + [Environment]::OSVersion.VersionString)
$free = FreeGB $InstallRoot
if ($free -ge 0 -and $free -lt 3) { Bad "安装盘只剩 $free GB，至少需要 3 GB" } else { Ok "安装盘可用空间: $free GB" }
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'Debug\makefile'))) { Bad "工程里没有 Debug\makefile，这不是完整的 BOAT 仓库" }
if ($script:Problems.Count -gt 0) { Write-Host ""; Bad "前置检查没过，先修上面的问题"; exit 1 }
if (-not (Test-Path -LiteralPath $InstallRoot)) { New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null }
if (-not (Test-Path -LiteralPath $CacheDir))  { New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null }

Step "1/5 安装工具链"
if ($KitPath) {
    $kitEnv = Join-Path $KitPath 'env'
    if (-not (Test-Path -LiteralPath $kitEnv)) { Bad "离线包里没有 env 目录: $kitEnv"; exit 1 }
    foreach ($n in @('gcc', 'make', 'openocd', 'node', 'cubeprog')) {
        $src = Join-Path $kitEnv $n
        $dst = Get-ToolPath $n
        if (-not (Test-Path -LiteralPath $src)) { Warn "$n 不在离线包里，跳过"; continue }
        if ((Test-Path -LiteralPath $dst) -and (-not $Force)) { Ok "$n 已安装，跳过"; continue }
        Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
        Ok "$n 已从离线包复制"
    }
} else {
    foreach ($a in $Manifest.artifacts) {
        $dst = Get-ToolPath $a.name
        $probe = Get-ChildItem -LiteralPath $dst -Recurse -Filter $a.verify_marker -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($probe -and (-not $Force)) { Ok ("{0} 已安装，跳过" -f $a.label); continue }

        $zip = Join-Path $CacheDir ($a.name + '.zip')
        $needDownload = $true
        if ((Test-Path -LiteralPath $zip) -and (-not $Force)) {
            if (Test-ArtifactHash -Path $zip -Algo $a.hash_algo -Expect $a.hash) { Ok ("{0} 已有缓存且校验通过" -f $a.label); $needDownload = $false }
            else { Warn ("{0} 缓存损坏，重新下载" -f $a.label); Remove-Item -LiteralPath $zip -Force }
        }
        if ($needDownload) {
            Write-Host ("  下载 {0}（{1:N0} MB）..." -f $a.label, ($a.size_bytes / 1MB)) -ForegroundColor Gray
            try { Save-Artifact -Url $a.url -OutFile $zip }
            catch {
                if ($a.url_alt) { Warn "主地址失败，换备用地址"; Save-Artifact -Url $a.url_alt -OutFile $zip }
                else { throw }
            }
        }
        if (-not (Test-ArtifactHash -Path $zip -Algo $a.hash_algo -Expect $a.hash)) {
            Bad ("{0} 校验失败（哈希不匹配），停止" -f $a.label)
            Write-Host "  期望: $($a.hash)" -ForegroundColor DarkGray
            exit 1
        }
        Ok ("{0} 校验通过" -f $a.label)
        Expand-Artifact -Zip $zip -Marker $a.verify_marker -Dest $dst -Name $a.name
        Ok ("{0} 已解压到 {1}" -f $a.label, $dst)
    }
}

Step "2/5 生成环境脚本"
Set-SessionPath
$envFile = Join-Path $InstallRoot 'env.ps1'
$lines = @(
    '# 由 tools/migrate/bootstrap.ps1 生成，勿手改',
    ('$env:BOAT_ENV = ' + "'" + $InstallRoot + "'"),
    '$dirs = @(',
    ('    ' + "'" + (Join-Path $InstallRoot 'gcc\bin') + "'" + ','),
    ('    ' + "'" + (Join-Path $InstallRoot 'make\bin') + "'" + ','),
    ('    ' + "'" + (Join-Path $InstallRoot 'openocd\bin') + "'" + ','),
    ('    ' + "'" + (Join-Path $InstallRoot 'node') + "'"),
    ')',
    'foreach ($d in $dirs) { if (Test-Path -LiteralPath $d) { $env:PATH = $d + ";" + $env:PATH } }'
)
[System.IO.File]::WriteAllText($envFile, ($lines -join [Environment]::NewLine) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($true)))
Ok "已生成 $envFile"

if (-not $NoUserPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    $add = @(
        (Join-Path $InstallRoot 'gcc\bin'),
        (Join-Path $InstallRoot 'make\bin'),
        (Join-Path $InstallRoot 'openocd\bin'),
        (Join-Path $InstallRoot 'node')
    ) | Where-Object { $userPath -notlike ('*' + $_ + '*') }
    if ($add) {
        $newPath = ($userPath.TrimEnd(';') + ';' + ($add -join ';')).TrimStart(';')
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Ok ("已追加 {0} 个目录到用户 PATH（新开的终端生效）" -f @($add).Count)
    } else {
        Ok "用户 PATH 已包含工具目录"
    }
}

Step "3/5 修正工程里的绝对路径"
Repair-ProjectPaths

Step "4/5 编译验收"
$make = Join-Path (Get-ToolPath 'make') 'bin\make.exe'
if (-not (Test-Path -LiteralPath $make)) { Bad "找不到 make.exe: $make"; exit 1 }
$Debug = Join-Path $RepoRoot 'Debug'
Push-Location -LiteralPath $Debug
try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $make -j 8 all
    $code = $LASTEXITCODE
    $sw.Stop()
} finally { Pop-Location }

if ($code -ne 0) {
    Bad "编译失败（make 退出码 $code）"
    Write-Host ""
    Write-Host "  把上面的报错发回参考机。常见原因：" -ForegroundColor White
    Write-Host "   1) 路径里有中文/空格导致 make 解析异常" -ForegroundColor White
    Write-Host "   2) 工具链没装全（重跑本脚本加 -Force）" -ForegroundColor White
    exit 1
}
Ok ("编译成功，用时 {0:N1} 秒" -f $sw.Elapsed.TotalSeconds)
$elf = Join-Path $Debug 'BOAT.elf'
if (Test-Path -LiteralPath $elf) {
    $fi = Get-Item -LiteralPath $elf
    Ok ("产物: {0}（{1:N0} KB）" -f $fi.FullName, ($fi.Length / 1KB))
} else {
    Bad "编译说成功了但没生成 BOAT.elf"
}

Step "5/5 结果"
if ($script:Problems.Count -gt 0) {
    Write-Host "  有 $($script:Problems.Count) 个问题：" -ForegroundColor Red
    $script:Problems | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }
    exit 1
}
Write-Host "  环境已就绪。" -ForegroundColor Green
Write-Host ""
Write-Host "  常用命令：" -ForegroundColor White
Write-Host "    powershell -ExecutionPolicy Bypass -File tools\migrate\dev.ps1 build" -ForegroundColor DarkGray
Write-Host "    powershell -ExecutionPolicy Bypass -File tools\migrate\dev.ps1 flash" -ForegroundColor DarkGray
Write-Host "    powershell -ExecutionPolicy Bypass -File tools\migrate\dev.ps1 serial" -ForegroundColor DarkGray
Write-Host "    powershell -ExecutionPolicy Bypass -File tools\migrate\verify.ps1 -Clean" -ForegroundColor DarkGray
Write-Host ""
exit 0
