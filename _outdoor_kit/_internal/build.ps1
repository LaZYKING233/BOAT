param([switch]$Clean)
# 2-编译固件：用便携版 arm-none-eabi-gcc + make 编译 Debug 目录
. "$PSScriptRoot\common.ps1"

Write-Step "初始化工具链"
Initialize-Toolchain
Repair-ProjectPaths

$mk = Join-Path $EnvRoot 'make\bin\make.exe'
if (-not (Test-Path $mk)) { Write-Bad "找不到 make.exe: $mk"; exit 1 }
if (-not (Test-Path $ProjRoot)) { Write-Bad "找不到工程目录: $ProjRoot"; exit 1 }

Push-Location $ProjRoot
try {
    if ($Clean) {
        Write-Step "清理旧的编译产物"
        & $mk -C Debug clean
    }
    Write-Step "开始编译（首次约 30-60 秒）"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $mk -C Debug -j 8 all
    $code = $LASTEXITCODE
    $sw.Stop()
    Write-Host ""
    if ($code -ne 0) {
        Write-Bad "编译失败（make 退出码 $code），把上面的红字发给我。"
        exit $code
    }
    Write-Ok ("编译成功，用时 {0:N1} 秒" -f $sw.Elapsed.TotalSeconds)
    Show-ElfInfo
    Write-Host ""
    Write-Host "  下一步：插上 ST-Link，跑 3-烧录固件.bat" -ForegroundColor White
} finally {
    Pop-Location
}
