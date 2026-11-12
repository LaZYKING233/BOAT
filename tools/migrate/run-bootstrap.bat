@echo off
chcp 65001 >nul
title BOAT - bootstrap environment
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" %*
echo.
pause
