# 1-环境自检：不修改任何东西，只报告这台电脑现在的状态
. "$PSScriptRoot\common.ps1"

Write-Host ""
Write-Host "==============================================" -ForegroundColor White
Write-Host "   BOAT 户外便携环境 - 自检" -ForegroundColor White
Write-Host "==============================================" -ForegroundColor White

Write-Step "1. 检查工具链"
Initialize-Toolchain

$items = @(
    @{ Name = 'arm-none-eabi-gcc'; Args = @('--version') },
    @{ Name = 'make.exe';          Args = @('--version') },
    @{ Name = 'openocd.exe';       Args = @('--version') },
    @{ Name = 'node.exe';          Args = @('--version') }
)
foreach ($it in $items) {
    $cmd = Get-Command $it.Name -ErrorAction SilentlyContinue
    if (-not $cmd) { Write-Bad "$($it.Name) 找不到（包不完整？）"; continue }
    try {
        $out = & $cmd.Source @($it.Args) 2>&1 | Out-String
        $first = ($out -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
        Write-Ok ("{0,-18} {1}" -f $it.Name, $first)
    } catch { Write-Bad "$($it.Name) 运行失败: $_" }
}

Write-Step "2. 检查工程"
if (Test-Path $ProjRoot) { Write-Ok "工程目录: $ProjRoot" } else { Write-Bad "缺少 project 目录" }
if (Test-Path (Join-Path $ProjRoot 'Debug\makefile')) { Write-Ok "构建脚本: Debug\makefile 已就绪" } else { Write-Bad "缺少 Debug\makefile" }
Show-ElfInfo

Write-Step "3. 检查设备"
$ports = Get-ComPorts
if ($ports.Count -gt 0) { Write-Ok ("串口: " + ($ports -join ', ')) } else { Write-Note "当前没有串口设备（板子的 USB 没插 / 没装 VCP 驱动）" }
$probes = Get-UsbDebugProbe
if ($probes.Count -gt 0) { foreach ($p in $probes) { Write-Ok "调试器: $p" } } else { Write-Note "没发现 ST-Link / STM32 调试口（烧录前要插上）" }

Write-Step "4. 结论"
Write-Host "  三个工具和工程都在，就可以直接跑:" -ForegroundColor White
Write-Host "     2-编译固件.bat   ->   3-烧录固件.bat   ->   4-串口监视.bat" -ForegroundColor White
Write-Host ""
Write-Host "  提示：从 U 盘直接编译会明显慢，建议先把整个 _outdoor_kit 拷到本机硬盘" -ForegroundColor DarkGray
Write-Host "        （例如 C:\BOAT），再从硬盘里跑这些 bat。" -ForegroundColor DarkGray
Write-Host ""
