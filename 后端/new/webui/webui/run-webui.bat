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

powershell -NoProfile -Command "$ids = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); if ($ids.Count -gt 0) { Write-Host ('[WARN] 检测到 3000 端口已被占用，正在结束进程: ' + ($ids -join ', ')); Stop-Process -Id $ids -Force -ErrorAction Stop; Start-Sleep -Seconds 1 }"
if errorlevel 1 (
  echo [ERROR] 无法结束占用 3000 端口的进程。
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

echo [INFO] 服务器启动后，请在浏览器打开 http://localhost:3000
call npm start

if errorlevel 1 (
  echo [ERROR] 服务器已退出。
  pause
)

endlocal
