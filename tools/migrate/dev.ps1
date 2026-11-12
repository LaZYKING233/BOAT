#Requires -Version 5.1
<#
.SYNOPSIS
    BOAT 日常开发入口（编译 / 烧录 / 串口 / WebUI / 环境诊断）

.EXAMPLE
    dev.ps1 build
    dev.ps1 clean
    dev.ps1 flash
    dev.ps1 flash -Elf ..\..\Debug\BOAT.elf
    dev.ps1 serial
    dev.ps1 serial -Port COM5 -Baud 115200
    dev.ps1 webui
    dev.ps1 doctor
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('build', 'clean', 'rebuild', 'flash', 'serial', 'webui', 'doctor', 'env')]
    [string]$Action = 'build',
    [string]$Elf = '',
    [string]$Port = '',
    [int]$Baud = 115200,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'boat-env'),
    [int]$Jobs = 8
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

function Invoke-Soft {
    # gcc/make/openocd 会把进度和警告写到 stderr，在 Stop 模式下会被当成终止错误
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

function Step { param($m) Write-Host ""; Write-Host ">>> $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Bad  { param($m) Write-Host "  [X]  $m" -ForegroundColor Red }

# ---------- 环境 ----------
$envFile = Join-Path $InstallRoot 'env.ps1'
if (Test-Path -LiteralPath $envFile) { . $envFile }
else {
    Bad "没找到 $envFile —— 先跑一次 bootstrap.ps1"
    exit 1
}

$make    = Get-Command make.exe    -ErrorAction SilentlyContinue
$ocd     = Get-Command openocd.exe -ErrorAction SilentlyContinue
$node    = Get-Command node.exe    -ErrorAction SilentlyContinue
$cube    = Join-Path $InstallRoot 'cubeprog\bin\STM32_Programmer_CLI.exe'

function Get-OcdScripts {
    # 各家发行版把 tcl 脚本放的位置不一样：
    #   xpack   -> <root>\openocd\scripts
    #   ST 打包 -> <root>\scripts
    # 直接按特征文件反查，别猜。
    $root = Join-Path $InstallRoot 'openocd'
    if (-not (Test-Path -LiteralPath $root)) { return '' }
    $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter 'stm32u5x.cfg' -File -ErrorAction SilentlyContinue |
           Where-Object { (Split-Path -Leaf $_.DirectoryName) -eq 'target' } |
           Select-Object -First 1
    if ($hit) { return (Split-Path -Parent $hit.DirectoryName) }
    return ''
}

function Get-ComPorts { try { return @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object) } catch { return @() } }

function Get-Probes {
    try {
        return @(Get-CimInstance Win32_PnPEntity -ErrorAction Stop |
                 Where-Object { $_.Name -match 'ST-?Link|STM32|J-?Link' } |
                 ForEach-Object { $_.Name })
    } catch { return @() }
}

switch ($Action) {

    'env' {
        Write-Host "BOAT_ENV      = $env:BOAT_ENV"
        Write-Host "RepoRoot      = $RepoRoot"
        Write-Host "gcc           = $((Get-Command arm-none-eabi-gcc.exe -ErrorAction SilentlyContinue).Source)"
        Write-Host "make          = $($make.Source)"
        Write-Host "openocd       = $($ocd.Source)"
        Write-Host "node          = $($node.Source)"
        Write-Host "cubeprog      = $(if (Test-Path -LiteralPath $cube) { $cube } else { '(未安装)' })"
    }

    'doctor' {
        Step "工具链"
        foreach ($t in @('arm-none-eabi-gcc.exe', 'make.exe', 'openocd.exe', 'node.exe')) {
            $c = Get-Command $t -ErrorAction SilentlyContinue
            if (-not $c) { Bad "$t 未找到"; continue }
            $r = Invoke-Soft { & $c.Source --version }
            $v = ($r.Output -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 1)
            if ($v) { Ok ("{0,-22} {1}" -f $t, $v.Trim()) } else { Warn "$t 无法执行" }
        }
        Step "设备"
        $ports = Get-ComPorts
        if ($ports) { Ok ("串口: " + ($ports -join ', ')) } else { Warn "没有串口设备" }
        $probes = Get-Probes
        if ($probes) { $probes | ForEach-Object { Ok "调试器: $_" } } else { Warn "没发现 ST-Link（烧录前要插上）" }
        Step "工程"
        if (Test-Path -LiteralPath (Join-Path $DebugDir 'makefile')) { Ok "Debug\makefile 存在" } else { Bad "缺少 Debug\makefile" }
        $elfPath = Join-Path $DebugDir 'BOAT.elf'
        if (Test-Path -LiteralPath $elfPath) { Ok ("固件: {0:N0} KB" -f ((Get-Item -LiteralPath $elfPath).Length / 1KB)) } else { Warn "还没有编译产物" }
    }

    'build' {
        if (-not $make) { Bad "make.exe 不在 PATH"; exit 1 }
        Step "编译"
        Push-Location -LiteralPath $DebugDir
        try {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            & $make.Source -j $Jobs all
            $code = $LASTEXITCODE
            $sw.Stop()
        } finally { Pop-Location }
        if ($code -ne 0) { Bad "编译失败（$code）"; exit $code }
        Ok ("编译成功，{0:N1} 秒" -f $sw.Elapsed.TotalSeconds)
        Ok ("产物: " + (Join-Path $DebugDir 'BOAT.elf'))
    }

    'clean' {
        if (-not $make) { Bad "make.exe 不在 PATH"; exit 1 }
        Push-Location -LiteralPath $DebugDir
        try { & $make.Source clean } finally { Pop-Location }
        Ok "已清理构建产物"
    }

    'rebuild' {
        if (-not $make) { Bad "make.exe 不在 PATH"; exit 1 }
        Push-Location -LiteralPath $DebugDir
        try { & $make.Source clean; & $make.Source -j $Jobs all; $code = $LASTEXITCODE }
        finally { Pop-Location }
        if ($code -ne 0) { Bad "编译失败（$code）"; exit $code }
        Ok "全量重编译完成"
    }

    'flash' {
        if (-not $Elf) { $Elf = Join-Path $DebugDir 'BOAT.elf' }
        if (-not (Test-Path -LiteralPath $Elf)) { Bad "找不到固件 $Elf，先 dev.ps1 build"; exit 1 }
        $Elf = (Resolve-Path -LiteralPath $Elf).Path
        $probes = Get-Probes
        if (-not $probes) { Warn "没检测到 ST-Link，仍然尝试连接" } else { $probes | ForEach-Object { Ok "调试器: $_" } }

        $ok = $false
        if (Test-Path -LiteralPath $cube) {
            Step "STM32_Programmer_CLI 烧录"
            $r = Invoke-Soft { & $cube -c port=SWD mode=UR -w $Elf -v -rst }
            Write-Host $r.Output
            $ok = ($r.Code -eq 0)
        }
        if (-not $ok) {
            if (-not $ocd) { Bad "openocd.exe 不在 PATH，且没有 CubeProgrammer 兜底"; exit 1 }
            $scp = Get-OcdScripts
            if (-not $scp) { Bad "找不到 openocd 脚本目录（没有 target/stm32u5x.cfg）"; exit 1 }
            Step "OpenOCD 烧录"
            # ST 打包版的 stlink.cfg 用 hla 驱动（与 swj-dp 冲突），上游/xpack 用 st-link 驱动
            $iface = 'interface/stlink-dap.cfg'
            $stlinkCfg = Join-Path $scp 'interface\stlink.cfg'
            if (Test-Path -LiteralPath $stlinkCfg) {
                $body = Get-Content -LiteralPath $stlinkCfg -Raw
                if ($body -notmatch 'adapter driver hla') { $iface = 'interface/stlink.cfg' }
            }
            $ep = $Elf -replace '\\', '/'
            $r = Invoke-Soft { & $ocd.Source -s $scp -f $iface -f target/stm32u5x.cfg -c "program {$ep} verify reset exit" }
            Write-Host $r.Output
            $ok = ($r.Code -eq 0)
        }
        if (-not $ok) {
            Bad "烧录失败"
            Write-Host "  排查：板子供电 / SWD 接线 / ST-Link 驱动 / 芯片读保护（先 -e all 整片擦除）" -ForegroundColor White
            exit 1
        }
        Ok "烧录成功，板子已复位"
    }

    'serial' {
        $ports = Get-ComPorts
        if (-not $ports) { Bad "没有可用串口"; exit 1 }
        if (-not $Port) {
            if ($ports.Count -eq 1) { $Port = $ports[0] }
            else {
                Write-Host "可用串口:" -ForegroundColor White
                for ($i = 0; $i -lt $ports.Count; $i++) { Write-Host ("  [{0}] {1}" -f ($i + 1), $ports[$i]) }
                $pick = Read-Host "输入序号"
                $idx = 0
                if ([int]::TryParse($pick, [ref]$idx) -and $idx -ge 1 -and $idx -le $ports.Count) { $Port = $ports[$idx - 1] }
                else { Bad "选择无效"; exit 1 }
            }
        }
        Ok "打开 $Port @ $Baud"
        $sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, 'None', 8, 'One'
        $sp.ReadTimeout = 500
        $sp.NewLine = [Environment]::NewLine
        try { $sp.Open() } catch { Bad "打不开 $Port : $($_.Exception.Message)"; exit 1 }
        Write-Host "  Ctrl+C 退出" -ForegroundColor DarkGray
        try {
            while ($true) {
                try {
                    $line = $sp.ReadLine()
                    if ($null -ne $line) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $line.TrimEnd()) }
                } catch [System.TimeoutException] { continue }
            }
        } finally { if ($sp.IsOpen) { $sp.Close() } }
    }

    'webui' {
        $ui = Join-Path $RepoRoot 'WebUI'
        if (-not (Test-Path -LiteralPath $ui)) { Bad "找不到 WebUI 目录"; exit 1 }
        if (-not $node) { Bad "node.exe 不在 PATH"; exit 1 }
        if (-not (Test-Path -LiteralPath (Join-Path $ui 'node_modules'))) {
            Warn "缺少 node_modules，先 npm install"
            Push-Location -LiteralPath $ui; try { & npm.cmd install } finally { Pop-Location }
        }
        Start-Job -ScriptBlock { Start-Sleep -Seconds 3; Start-Process 'http://localhost:3000' } | Out-Null
        Push-Location -LiteralPath $ui
        try { & $node.Source 'server.js' } finally { Pop-Location }
    }
}