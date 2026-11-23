@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，无法启动本地服务器。
  echo 请安装 Node.js，或把整个文件夹交给技术人员部署。
  pause
  exit /b 1
)
start "" /b node serve.cjs
timeout /t 1 >nul
start "" http://127.0.0.1:8787/game.html
exit /b 0
