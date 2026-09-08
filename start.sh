#!/usr/bin/env bash
# 我的日记 · 一键启动(Linux / macOS)
# 用法: bash start.sh   (或 ./start.sh)
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "==> 我的日记 · 一键启动"

# 1) 检查 Node
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 Node.js,请先安装 Node 22+(https://nodejs.org)" >&2
  exit 1
fi

# 2) 包管理器(优先 pnpm,缺失时用 npx pnpm)
PM="pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
  PM="npx pnpm"
fi

# 3) 依赖(首次自动安装)
if [ ! -d node_modules ]; then
  echo "==> 首次运行,安装依赖..."
  $PM install
fi

# 4) 构建前端(生产模式,由后端一并伺服)
echo "==> 构建前端..."
$PM --filter @diary/web build

# 5) 启动服务
echo "==> 启动服务,浏览器将打开 http://localhost:4520 (Ctrl+C 停止)"
$PM --filter @diary/server start &
SERVER_PID=$!

# 6) 尽力自动打开浏览器
sleep 2
if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:4520" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then open "http://localhost:4520" >/dev/null 2>&1 || true
fi

# 前台等待(可 Ctrl+C 停止服务)
wait "$SERVER_PID"
