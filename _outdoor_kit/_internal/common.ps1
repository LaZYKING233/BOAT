# ============================================================
#  BOAT 户外便携开发环境 - 公共函数
#  所有路径都从本文件位置推导，整个 _outdoor_kit 文件夹可以放在
#  任意盘符 / 目录（U 盘、C:\BOAT、D:\work 都可以），
#  不安装、不写注册表、不需要管理员权限。
# ============================================================

$script:KitRoot  = Split-Path -Parent $PSScriptRoot      # _internal 的上一级 = 包根目录
$script:EnvRoot  = Join-Path $KitRoot 'env'
$script:ProjRoot = Join-Path $KitRoot 'project'
$script:ElfPath  = Join-Path $ProjRoot 'Debug\BOAT.elf'

function Write-Step { param($t) Write-Host ""; Write-Host ">>> $t" -ForegroundColor Cyan }
function Write-Ok   { param($t) Write-Host "  [OK] $t" -ForegroundColor Green }
function Write-Note { param($t) Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Write-Bad  { param($t) Write-Host "  [X]  $t" -ForegroundColor Red }

function Initialize-Toolchain {
    $dirs = @(
        (Join-Path $EnvRoot 'gcc\bin'),
        (Join-Path $EnvRoot 'make\bin'),
        (Join-Path $EnvRoot 'openocd\bin'),
        (Join-Path $EnvRoot 'node')
    )
    foreach ($d in $dirs) {
        if (Test-Path $d) { $env:PATH = "$d;$env:PATH" }
        else { Write-Note "缺少工具目录: $d" }
    }
}

function Repair-ProjectPaths {
    # 历史遗留：CubeIDE 生成的 Debug\makefile 里曾把链接脚本写成绝对路径
    # （E:\STM32\BOAT\STM32U5A5ZJTXQ_FLASH.ld），换机器就要改写。
    #
    # 现在已经把 makefile 里的路径改成相对路径（../STM32U5A5ZJTXQ_FLASH.ld），
    # 任何目录、任何盘符、拷贝到哪台机器都不用再改，所以这里什么都不做。
    #
    # 保留空实现只是为了不破坏 build.ps1 / flash.ps1 里的调用点。
}

function Get-ComPorts {
    try { return @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object) } catch { return @() }
}

function Get-UsbDebugProbe {
    $hit = @()
    try {
        $devs = Get-CimInstance Win32_PnPEntity -ErrorAction Stop | Where-Object { $_.Name -match 'ST-?Link|STM32|J-?Link' }
        foreach ($d in $devs) { $hit += $d.Name }
    } catch { }
    return $hit
}

function Show-ElfInfo {
    if (-not (Test-Path $ElfPath)) { Write-Note "还没有编译产物: $ElfPath"; return }
    $fi = Get-Item $ElfPath
    Write-Ok ("固件: {0}  ({1:N0} KB, {2:yyyy-MM-dd HH:mm})" -f $fi.Name, ($fi.Length / 1KB), $fi.LastWriteTime)
}
