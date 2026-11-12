param([string]$Elf = '', [ValidateSet('auto', 'cube', 'ocd')][string]$Tool = 'auto')
# 3-烧录固件
#   默认先走 STM32_Programmer_CLI（ST 官方，最稳），失败再自动用 OpenOCD 兜底。
. "$PSScriptRoot\common.ps1"

Write-Step "定位工具和固件"
Initialize-Toolchain

$cube = Join-Path $EnvRoot 'cubeprog\bin\STM32_Programmer_CLI.exe'
$ocd  = Join-Path $EnvRoot 'openocd\bin\openocd.exe'
$scp  = Join-Path $EnvRoot 'openocd\scripts'

if (-not $Elf) { $Elf = $ElfPath }
if (-not (Test-Path $Elf)) { Write-Bad "找不到固件: $Elf（先跑 2-编译固件.bat）"; exit 1 }
$Elf = (Resolve-Path $Elf).Path
Write-Ok "固件: $Elf"

$probes = Get-UsbDebugProbe
if ($probes.Count -eq 0) {
    Write-Note "没检测到 ST-Link 设备，仍然尝试连接……"
    Write-Note "如果这边确实插了 ST-Link，先跑 7-安装STLink驱动.bat（需要管理员）"
} else {
    foreach ($p in $probes) { Write-Ok "调试器: $p" }
}

function Invoke-CubeFlash {
    if (-not (Test-Path $cube)) { Write-Note "没有 CubeProgrammer CLI，跳过"; return -1 }
    Write-Step "用 STM32_Programmer_CLI 烧录（port=SWD, under reset）"
    $out = & $cube -c port=SWD mode=UR -w $Elf -v -rst 2>&1 | Out-String
    Write-Host $out
    return $LASTEXITCODE
}

function Invoke-OcdFlash {
    if (-not (Test-Path $ocd)) { Write-Note "没有 OpenOCD，跳过"; return -1 }
    Write-Step "用 OpenOCD 烧录"
    $ep = $Elf -replace '\\', '/'
    $out = & $ocd -s $scp -f interface/stlink-dap.cfg -f target/stm32u5x.cfg -c "program {$ep} verify reset exit" 2>&1 | Out-String
    Write-Host $out
    return $LASTEXITCODE
}

$ok = $false
switch ($Tool) {
    'cube' { $ok = ((Invoke-CubeFlash) -eq 0) }
    'ocd'  { $ok = ((Invoke-OcdFlash) -eq 0) }
    default {
        $rc = Invoke-CubeFlash
        if ($rc -eq 0) { $ok = $true }
        elseif ($rc -eq -1) { $ok = ((Invoke-OcdFlash) -eq 0) }
        else {
            Write-Note "CubeProgrammer 失败（$rc），换 OpenOCD 再试一次"
            $ok = ((Invoke-OcdFlash) -eq 0)
        }
    }
}

Write-Host ""
if (-not $ok) {
    Write-Bad "两种烧录方式都没成功"
    Write-Host "  按顺序排查：" -ForegroundColor White
    Write-Host "   1) 板子供电了吗？ST-Link 的 SWDIO/SWCLK/GND 接对了吗？" -ForegroundColor White
    Write-Host "   2) 设备管理器里 ST-Link 有没有黄色感叹号 -> 跑 7-安装STLink驱动.bat" -ForegroundColor White
    Write-Host "   3) 芯片被读保护了 -> 先整片擦除：" -ForegroundColor White
    Write-Host "      env\cubeprog\bin\STM32_Programmer_CLI.exe -c port=SWD mode=UR -e all" -ForegroundColor DarkGray
    Write-Host "   4) 换了板子/芯片就改 -f target/xxx.cfg 里的型号" -ForegroundColor White
    exit 1
}

Write-Ok "烧录成功，板子已复位"
Write-Host "  下一步：4-串口监视.bat 看日志" -ForegroundColor White
