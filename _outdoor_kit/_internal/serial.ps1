param([string]$Port = '', [int]$Baud = 115200)
# 4-串口监视：直接用 .NET SerialPort 读板子/ LoRa 接收端的串口
. "$PSScriptRoot\common.ps1"

$ports = Get-ComPorts
if ($ports.Count -eq 0) {
    Write-Bad "这台电脑现在没有任何串口设备。"
    Write-Host "  检查：USB 线是否插好、板子是否上电、VCP 驱动是否装上（设备管理器 -> 端口）" -ForegroundColor White
    exit 1
}

if (-not $Port) {
    if ($ports.Count -eq 1) {
        $Port = $ports[0]
    } else {
        Write-Host "可用串口:" -ForegroundColor White
        for ($i = 0; $i -lt $ports.Count; $i++) { Write-Host ("  [{0}] {1}" -f ($i + 1), $ports[$i]) }
        $pick = Read-Host "输入序号"
        $idx = 0
        if ([int]::TryParse($pick, [ref]$idx) -and $idx -ge 1 -and $idx -le $ports.Count) { $Port = $ports[$idx - 1] }
        else { Write-Bad "选择无效"; exit 1 }
    }
}

Write-Ok "打开 $Port @ $Baud 8-N-1"
$sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 500
$sp.NewLine = "`n"
$sp.Encoding = [System.Text.Encoding]::UTF8
try { $sp.Open() } catch { Write-Bad "打不开 $Port : $($_.Exception.Message)"; exit 1 }

Write-Host "  收数据中…… 按 Ctrl+C 退出" -ForegroundColor DarkGray
Write-Host ""
try {
    while ($true) {
        try {
            $line = $sp.ReadLine()
            if ($null -ne $line) {
                $line = $line.TrimEnd("`r")
                Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $line)
            }
        } catch [System.TimeoutException] {
            continue
        }
    }
} finally {
    if ($sp.IsOpen) { $sp.Close() }
    Write-Host ""
    Write-Host "串口已关闭。" -ForegroundColor DarkGray
}
