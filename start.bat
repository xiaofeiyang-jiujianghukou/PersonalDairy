@echo off
rem 我的日记 · 一键启停(Windows)
rem   用法: start.bat            启动服务并打开浏览器
rem          start.bat stop      停止服务
rem          start.bat restart   重启服务
rem          start.bat status    查看是否运行
setlocal enabledelayedexpansion
cd /d "%~dp0"
set PORT=4520
set URL=http://localhost:%PORT%

:killport
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :%PORT% ^| findstr LISTENING') do taskkill /f /pid %%p >nul 2>nul
exit /b 0

set CMD=%~1
if "%CMD%"=="stop" (
  echo ==^> 停止服务(端口 %PORT%)
  call :killport
  echo ==^> 已停止
  exit /b 0
)
if "%CMD%"=="status" (
  netstat -ano | findstr :%PORT% | findstr LISTENING >nul 2>nul && echo 运行中:%URL% || echo 未运行
  exit /b 0
)
if "%CMD%"=="restart" (
  call :killport
  timeout /t 1 >nul
  goto :start
)

:start
where node >nul 2>nul || ( echo ✗ 未检测到 Node.js,请安装 Node 22+ & pause & exit /b 1 )
set PM=pnpm
where pnpm >nul 2>nul || set PM=call npx pnpm
if not exist node_modules ( echo ==^> 首次运行,安装依赖... & %PM% install )
echo ==^> 构建前端...
%PM% --filter @diary/web build

echo ==^> 启动服务 %URL%
start "diary-server" cmd /c "cd /d %~dp0 && %PM% --filter @diary/server start"
timeout /t 3 >nul
start "" %URL%

echo ==^> 停止请运行: start.bat stop
endlocal
