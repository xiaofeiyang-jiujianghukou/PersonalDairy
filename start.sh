#!/usr/bin/env bash
# 我的日记 · 一键启停(Linux/macOS)
#   用法:
#     ./start.sh           启动服务并打开浏览器
#     ./start.sh stop      停止服务
#     ./start.sh restart   重启服务
#     ./start.sh status    查看是否运行
#   可用 PORT=xxxx 指定端口(默认 4520)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$ROOT/$(basename "${BASH_SOURCE[0]}")"
cd "$ROOT"
PORT="${PORT:-4520}"
URL="http://localhost:$PORT"
LOG="$ROOT/.diary-server.log"
PIDFILE="$ROOT/.diary.pid"

pids_on_port() {
  if command -v lsof >/dev/null 2>&1; then lsof -ti "tcp:$PORT" 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then fuser "$PORT/tcp" 2>/dev/null | tr -s ' ' '\n' || true
  fi
}
is_running() { [ -n "$(pids_on_port)" ]; }

stop_server() {
  local pids; pids=$(pids_on_port)
  if [ -n "$pids" ]; then
    echo "==> 停止服务(端口 $PORT):$pids"
    kill $pids 2>/dev/null || true
    sleep 1
    local pids2; pids2=$(pids_on_port)
    [ -n "$pids2" ] && kill -9 $pids2 2>/dev/null || true
    echo "==> 已停止"
  else
    echo "==> 服务未在运行(端口 $PORT)"
  fi
  [ -f "$PIDFILE" ] && rm -f "$PIDFILE"
}

cmd="${1:-start}"
case "$cmd" in
  stop) stop_server; exit 0 ;;
  status)
    if is_running; then echo "运行中: $URL"; else echo "未运行"; fi
    exit 0 ;;
  restart) stop_server; "$SELF" start; exit 0 ;;
  start) : ;;
  *) echo "用法: $0 [start|stop|restart|status]"; exit 1 ;;
esac

# ---------- start ----------
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 Node.js,请先安装 Node 22+(https://nodejs.org)" >&2; exit 1
fi
PM="pnpm"; command -v pnpm >/dev/null 2>&1 || PM="npx pnpm"

if [ ! -d node_modules ]; then
  echo "==> 首次运行,安装依赖..."; $PM install
fi
echo "==> 构建前端..."; $PM --filter @diary/web build

stop_server >/dev/null 2>&1 || true   # 避免重复启动

echo "==> 启动服务: $URL"
nohup $PM --filter @diary/server start >"$LOG" 2>&1 &
echo $! > "$PIDFILE"

sleep 2
if is_running; then
  echo "✅ 已启动: $URL (日志: .diary-server.log)"
else
  echo "⚠️ 服务可能未就绪,请查看日志: $LOG"
fi

# 尽力打开浏览器
( sleep 1; command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 || true ) &
( sleep 1; command -v open >/dev/null 2>&1 && open "$URL" >/dev/null 2>&1 || true ) &
