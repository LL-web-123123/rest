@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================
echo   抖音群聊 AI 助手 - 安装依赖
echo ================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 Node.js。请先安装 Node.js 22.5 或更高版本：
  echo        https://nodejs.org/
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo 当前 Node.js: %%v
echo.
echo 正在安装依赖，第一次会慢一点...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [错误] 依赖安装失败，把上面的报错发给我。
  pause
  exit /b 1
)

echo.
node scripts\check-env.mjs
echo.
pause
