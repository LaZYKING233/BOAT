#Requires -Version 5.1
<#
.SYNOPSIS
    验收：确认这台机器能真的编译出可烧录的固件。

.DESCRIPTION
    1) 四个工具齐全且能跑
    2) 工程结构完整
    3) 全量编译（-Clean 时先 clean）
    4) 产物存在，text 段落在合理区间
    5) 可选：检测 ST-Link / 串口（-WithHardware）
    任何一项失败 -> 退出码 1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\migrate\verify.ps1 -Clean -WithHardware
#>
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$WithHardware,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'boat-env')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

function Invoke-Soft {
    # 原生命令（gcc/make/openocd）会把进度和警告写到 stderr，
    # 在 ErrorActionPreference=Stop 下会被当成终止错误。这里临时放宽。
    param([scriptblock]$Block)
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & $Block 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
        }
        $out = ($lines -join [Environment]::NewLine)
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $old }
    return [pscustomobject]@{ Output = $out; Code = $code }
}
$ScriptDir = $PSScriptRoot
$RepoRoot  = (Resolve-Path -LiteralPath (Join-Path $ScriptDir '..\..')).Path
$DebugDir  = Join-Path $RepoRoot 'Debug'
$Manifest  = Get-Content -LiteralPath (Join-Path $ScriptDir 'manifest.json') -Raw | ConvertFrom-Json
$script:Fails = New-Object System.Collections.ArrayList

function Step { param($m) Write-Host ""; Write-Host ">>> $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Bad  { param($m) Write-Host "  [X]  $m" -ForegroundColor Red; [void]$script:Fails.Add($m) }

Write-Host ""
Write-Host "=======================================================" -ForegroundColor White
Write-Host "  BOAT 环境验收（工程: $RepoRoot）" -ForegroundColor White
Write-Host "=======================================================" -ForegroundColor White

Step "1/5 工具链"
$envFile = Join-Path $InstallRoot 'env.ps1'
if (Test-Path -LiteralPath $envFile) { . $envFile } else { Warn "没有 $envFile，改用当前 PATH" }
foreach ($t in @('arm-none-eabi-gcc.exe', 'make.exe', 'openocd.exe', 'node.exe')) {
    $c = Get-Command $t -ErrorAction SilentlyContinue
    if (-not $c) { Bad "$t 不在 PATH"; continue }
    $r = Invoke-Soft { & $c.Source --version }
    $v = ($r.Output -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 1)
    if ($v) { Ok ("{0,-22} {1}" -f $t, $v.Trim()) } else { Bad "$t 无法执行" }
}

Step "2/5 工程结构"
foreach ($p in @('Debug\makefile', 'Debug\objects.list', 'BOAT.ioc', 'STM32U5A5ZJTXQ_FLASH.ld', 'Core\Src\main.c', 'WebUI\package.json')) {
    if (Test-Path -LiteralPath (Join-Path $RepoRoot $p)) { Ok $p } else { Bad "缺少 $p" }
}
if ((Test-Path -LiteralPath (Join-Path $RepoRoot 'AI\ph\libneai_ph.a'))) { Ok "AI\ph\libneai_ph.a" } else { Bad "缺少 NanoEdge 静态库 AI\ph\libneai_ph.a" }

Step "3/5 编译"
$make = Get-Command make.exe -ErrorAction SilentlyContinue
if (-not $make) { Bad "没有 make，跳过编译" }
else {
    Push-Location -LiteralPath $DebugDir
    try {
        if ($Clean) { Invoke-Soft { & $make.Source clean } | Out-Null }
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $build = Invoke-Soft { & $make.Source -j 8 all }
        $log = $build.Output
        $code = $build.Code
        $sw.Stop()
    } finally { Pop-Location }

    if ($code -ne 0) {
        Bad "编译失败（make 退出码 $code）"
        Write-Host ($log -split [Environment]::NewLine | Select-Object -Last 25 | Out-String) -ForegroundColor DarkGray
    } else {
        Ok ("编译成功，{0:N1} 秒" -f $sw.Elapsed.TotalSeconds)
    }
}

Step "4/5 产物"
$elf = Join-Path $DebugDir 'BOAT.elf'
if (-not (Test-Path -LiteralPath $elf)) {
    Bad "没有生成 BOAT.elf"
} else {
    $fi = Get-Item -LiteralPath $elf
    Ok ("BOAT.elf  {0:N0} KB  {1:yyyy-MM-dd HH:mm}" -f ($fi.Length / 1KB), $fi.LastWriteTime)
    $size = Get-Command arm-none-eabi-size.exe -ErrorAction SilentlyContinue
    if ($size) {
        $out = (Invoke-Soft { & $size.Source $elf }).Output
        Write-Host $out.Trim() -ForegroundColor DarkGray
        $m = [regex]::Match($out, '(\d+)\s+(\d+)\s+(\d+)')
        if ($m.Success) {
            $text = [int]$m.Groups[1].Value
            $lo = $Manifest.acceptance.text_size_range[0]
            $hi = $Manifest.acceptance.text_size_range[1]
            if ($text -ge $lo -and $text -le $hi) { Ok "text 段 $text 字节，在预期区间 [$lo, $hi]" }
            else { Bad "text 段 $text 字节，超出预期区间 [$lo, $hi]（工具链或代码变了？）" }
        }
    }
}

Step "5/5 现场检查"
if ($WithHardware) {
    $ports = @()
    try { $ports = @([System.IO.Ports.SerialPort]::GetPortNames()) } catch { }
    if ($ports.Count -gt 0) { Ok ("串口: " + ($ports -join ', ')) } else { Warn "没有串口设备（板子没插或没驱动）" }
    $probes = @()
    try { $probes = @(Get-CimInstance Win32_PnPEntity -ErrorAction Stop | Where-Object { $_.Name -match 'ST-?Link|STM32' } | ForEach-Object { $_.Name }) } catch { }
    if ($probes.Count -gt 0) { $probes | ForEach-Object { Ok "调试器: $_" } } else { Warn "没发现 ST-Link" }
} else {
    Warn "跳过硬件检查（加 -WithHardware 才检查）"
}

Write-Host ""
if ($script:Fails.Count -gt 0) {
    Write-Host "验收失败：$($script:Fails.Count) 项" -ForegroundColor Red
    $script:Fails | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
Write-Host "验收通过：这台机器可以编译、可以烧录。" -ForegroundColor Green
exit 0
