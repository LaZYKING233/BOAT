#Requires -Version 5.1
<#
.SYNOPSIS
    在【参考机】上被 ssh 调用：用便携工具链编译 Debug/BOAT.elf。

.DESCRIPTION
    由小电脑的 fetch-elf.ps1 通过 ssh 触发，也可以手工跑：
        ssh boat "powershell -NoProfile -ExecutionPolicy Bypass -File E:\STM32\BOAT\tools\migrate\ssh\Remote-Build.ps1"
#>
[CmdletBinding()]
param([switch]$Clean, [int]$Jobs = 8)

$ErrorActionPreference = 'Stop'

function Ok   { param($m) Write-Host ('  [OK] ' + $m) -ForegroundColor Green }
function Bad  { param($m) Write-Host ('  [X]  ' + $m) -ForegroundColor Red }

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$envFile = Join-Path $env:LOCALAPPDATA 'boat-env\env.ps1'
if (Test-Path $envFile) {
    . $envFile
} else {
    # 退回到参考机上的 ST 工具链
    $tc = 'E:\WORK\STM32CubeIDE_2.1.1\STM32CubeIDE\plugins\com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.14.3.rel1.win32_1.0.100.202602081740\tools\bin'
    $mk = 'E:\WORK\STM32CubeIDE_2.1.1\STM32CubeIDE\plugins\com.st.stm32cube.ide.mcu.externaltools.make.win32_2.2.100.202601091506\tools\bin'
    if (Test-Path $tc) { $env:PATH = $tc + ';' + $mk + ';' + $env:PATH }
}

$make = Get-Command make.exe -ErrorAction SilentlyContinue
if (-not $make) { Bad '参考机上找不到 make.exe（先跑 bootstrap.ps1）'; exit 1 }

Push-Location -LiteralPath (Join-Path $root 'Debug')
try {
    if ($Clean) { & $make.Source clean | Out-Null }
    $out = & $make.Source -j $Jobs all 2>&1 | Out-String
    $code = $LASTEXITCODE
} finally { Pop-Location }

if ($code -ne 0) {
    Bad ('远程编译失败（' + $code + '）')
    Write-Host ($out -split [Environment]::NewLine | Select-Object -Last 15 | Out-String)
    exit $code
}
$elf = Join-Path $root 'Debug\BOAT.elf'
if (-not (Test-Path $elf)) { Bad '没有产出 BOAT.elf'; exit 1 }
Ok ('远程编译成功: ' + $elf + ' (' + [math]::Round((Get-Item $elf).Length / 1KB) + ' KB)')
exit 0
