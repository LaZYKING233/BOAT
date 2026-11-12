# 5-启动WebUI：本地跑 WebUI 服务，浏览器打开 http://localhost:3000
. "$PSScriptRoot\common.ps1"

Initialize-Toolchain
$ui = Join-Path $ProjRoot 'WebUI'
if (-not (Test-Path $ui)) { Write-Bad "找不到 WebUI 目录: $ui"; exit 1 }

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Write-Bad "找不到 node.exe"; exit 1 }

if (-not (Test-Path (Join-Path $ui 'node_modules'))) {
    Write-Note "缺少 node_modules，尝试 npm install（需要联网）"
    Push-Location $ui; & npm.cmd install; Pop-Location
}

Write-Ok "WebUI 目录: $ui"
Write-Host "  启动后浏览器会自动打开 http://localhost:3000 ，Ctrl+C 停止服务" -ForegroundColor DarkGray

Start-Job -ScriptBlock {
    Start-Sleep -Seconds 3
    Start-Process 'http://localhost:3000'
} | Out-Null

Push-Location $ui
try { & $node.Source 'server.js' } finally { Pop-Location }
