@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未检测到 Node.js，请先安装 Node.js 18+。
  pause
  exit /b 1
)

powershell -NoProfile -Command "$ids = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); if ($ids.Count -gt 0) { Write-Host ('[WARN] 检测到 8765 端口已被占用，正在结束进程: ' + ($ids -join ', ')); Stop-Process -Id $ids -Force -ErrorAction Stop; Start-Sleep -Seconds 1 }"
if errorlevel 1 (
  echo [ERROR] 无法结束占用 8765 端口的进程。
  pause
  exit /b 1
)

if not exist node_modules (
  echo [INFO] 首次运行，正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install 失败。
    pause
    exit /b 1
  )
)

echo [INFO] 演示网关服务器启动中...
echo [INFO] 小程序连接地址：ws://127.0.0.1:8765
echo [INFO] 在微信开发者工具中：设置 - 本地设置 - 勾选"不校验合法域名"
echo [INFO] 小程序 IP 填 127.0.0.1，端口填 8765
call npm start

if errorlevel 1 (
  echo [ERROR] 服务器已退出。
  pause
)

endlocal
