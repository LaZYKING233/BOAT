@echo off
chcp 65001 >nul
title BOAT WebUI - 中继模式
cd /d "%~dp0"

rem 通过 Tailscale 连远端中继（只认 100.x 地址，局域网地址出门就失效）
set BOAT_SERIAL=tcp://100.100.25.105:4001

echo.
echo   串口: %BOAT_SERIAL%
echo   网页: http://localhost:3000
echo.
echo   关闭这个窗口即停止服务。
echo.

node server.js
pause
