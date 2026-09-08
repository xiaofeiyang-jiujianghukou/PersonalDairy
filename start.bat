@echo off
rem 我的日记 · 一键启动(Windows)
setlocal
cd /d "%~dp0"
echo ==^> 我的日记 · 一键启动

rem 1) 检查 Node
where node >nul 2>nul || ( echo ✗ 未检测到 Node.js,请安装 Node 22+ & pause & exit /b 1 )

rem 2) 包管理器(优先 pnpm,缺失用 npx pnpm)
set PM=pnpm
where pnpm >nul 2>nul || set PM=call npx pnpm

rem 3) 依赖(首次自动安装)
if not exist node_modules (
  echo ==^> 首次运行,安装依赖...
  %PM% install
)

rem 4) 构建前端(生产模式,由后端一并伺服)
echo ==^> 构建前端...
%PM% --filter @diary/web build

rem 5) 启动服务(新窗口,保留本窗口)
echo ==^> 启动服务 http://localhost:4520
start "diary-server" cmd /c "cd /d %~dp0 && %PM% --filter @diary/server start"

rem 6) 打开浏览器
timeout /t 3 >nul
start "" http://localhost:4520

rem 停止服务用:taskkill /f /t /fi "imagename eq cmd.exe" (或直接关掉 diary-server 窗口)
endlocal
