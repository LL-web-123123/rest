@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 抖音群聊 AI 助手

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 Node.js，请先安装 Node.js 22.5+：https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo [错误] 依赖还没装，先双击 install.bat。
  pause
  exit /b 1
)

echo 正在启动，浏览器会自动打开界面。关掉这个窗口就是停止程序。
echo.
node src\index.mjs
echo.
echo 程序已退出。
pause
