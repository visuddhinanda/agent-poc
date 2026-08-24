#!/usr/bin/env bash
# dev-up.sh —— 一键拉起 WikiPali 整条链路（开发模式）
#
#   MCP server (3000)  ->  LangGraph backend (8000)  ->  CopilotKit runtime (3001)  ->  web (3002)
#
# 用法:
#   ./dev-up.sh              # 依次启动四个服务 + 健康检查，Ctrl+C 停止全部
#   ./dev-up.sh stop         # 停止全部服务（按端口清理）
#
# 说明:
#   - MCP 默认指向 next（www 稳定版上 /v2/case 等端点会 500）
#   - web 默认用 3002，避开 MCP 的 3000；浏览器打开 http://localhost:3002
#   - 端口可用环境变量覆盖：MCP_PORT / BACKEND_PORT / RUNTIME_PORT / WEB_PORT

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGDIR="$ROOT/logs"

MCP_PORT="${MCP_PORT:-3000}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
RUNTIME_PORT="${RUNTIME_PORT:-3001}"
WEB_PORT="${WEB_PORT:-3002}"

MCP_API_URL="${WIKIPALI_API_URL:-https://next.wikipali.org/api}"

mkdir -p "$LOGDIR"

declare -a PIDS=()

log()  { echo -e "$*"; }
info() { log "  $*"; }

record_pid() { echo "$2" > "$LOGDIR/$1.pid"; }

port_pids() { # 返回监听某端口的所有 PID（空格分隔）；依赖 ss -p，个别受限环境可能取不到
  ss -ltnp 2>/dev/null | grep -E "[.:]${1}([^0-9]|$)" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | tr '\n' ' '
}

port_in_use() { ss -ltn 2>/dev/null | grep -qE "[.:]${1}([^0-9]|$)"; }

http_code() { curl -sS --max-time 3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }

mcp_ready() {
  [ "$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${MCP_PORT}/mcp" \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"dev-up","version":"0"}}}' 2>/dev/null)" = "200" ]
}

wait_for() { # wait_for <名称> <探针命令> <tries>
  local name="$1" probe="$2" tries="${3:-40}"
  for _ in $(seq 1 "$tries"); do
    if eval "$probe" >/dev/null 2>&1; then
      info "✓ ${name} 就绪"
      return 0
    fi
    sleep 1
  done
  log "  ✗ ${name} 未就绪（超时），日志见 ${LOGDIR}/${name}.log" >&2
  return 1
}

stop_all() {
  log "[dev-up] 停止所有服务..."
  # 先按本脚本记录的 pid 文件精确清理（不依赖端口→pid 解析，受限环境也能用）
  for name in mcp backend runtime web; do
    local f="$LOGDIR/$name.pid"
    if [ -f "$f" ]; then
      local pid
      pid=$(cat "$f" 2>/dev/null)
      if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
        log "  stopped $name (pid $pid)"
      fi
      rm -f "$f"
    fi
  done
  # 兜底：按端口清（fuser / ss -p；普通 Linux 都可用）
  for port in "$WEB_PORT" "$RUNTIME_PORT" "$BACKEND_PORT" "$MCP_PORT"; do
    fuser -k "${port}/tcp" >/dev/null 2>&1 && log "  stopped :$port (fuser)"
    for pid in $(port_pids "$port"); do
      kill "$pid" 2>/dev/null && log "  stopped :$port (pid $pid)"
    done
  done
  log "  done"
}

if [ "${1:-}" = "stop" ]; then
  stop_all
  exit 0
fi

trap 'log "\n[dev-up] 收到退出信号，停止所有服务..."; for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done; rm -f "$LOGDIR"/*.pid; exit 0' INT TERM

FAIL=0

# ---- 1/4 MCP server ---------------------------------------------------------
log "\n[dev-up] 1/4 MCP server（端口 ${MCP_PORT}，API=${MCP_API_URL}）"
if port_in_use "$MCP_PORT"; then
  info "端口 ${MCP_PORT} 已被占用，跳过启动"
else
  cd "$ROOT/mcp" || exit 1
  if [ ! -d node_modules ]; then info "npm install ..."; npm install --cache "$ROOT/.npm-cache" >/dev/null; fi
  if [ ! -f dist/index.js ]; then info "npm run build ..."; npm run build >/dev/null; fi
  (WIKIPALI_API_URL="$MCP_API_URL" PORT="$MCP_PORT" exec node dist/index.js > "$LOGDIR/mcp.log" 2>&1) &
  _pid=$!; PIDS+=("$_pid"); record_pid mcp "$_pid"
fi
wait_for mcp "mcp_ready" 40 || FAIL=1

# ---- 2/4 backend ------------------------------------------------------------
log "\n[dev-up] 2/4 LangGraph backend（端口 ${BACKEND_PORT}）"
if port_in_use "$BACKEND_PORT"; then
  info "端口 ${BACKEND_PORT} 已被占用，跳过启动"
else
  cd "$ROOT/backend" || exit 1
  if [ ! -x .venv/bin/uvicorn ]; then
    info "创建 venv 并安装依赖 ..."
    python3 -m venv .venv
    .venv/bin/pip install -q -r requirements.txt
  fi
  (.venv/bin/uvicorn main:app --host 0.0.0.0 --port "$BACKEND_PORT" > "$LOGDIR/backend.log" 2>&1) &
  _pid=$!; PIDS+=("$_pid"); record_pid backend "$_pid"
fi
wait_for backend "http_code http://127.0.0.1:${BACKEND_PORT}/health | grep -q 200" 40 || FAIL=1
info "backend mcp_connected=$(curl -sS --max-time 3 http://127.0.0.1:${BACKEND_PORT}/health 2>/dev/null | grep -oE '"mcp_connected":[a-z]+' | cut -d: -f2)"

# ---- 3/4 runtime ------------------------------------------------------------
log "\n[dev-up] 3/4 CopilotKit runtime（端口 ${RUNTIME_PORT}）"
if port_in_use "$RUNTIME_PORT"; then
  info "端口 ${RUNTIME_PORT} 已被占用，跳过启动"
else
  cd "$ROOT/runtime" || exit 1
  [ -d node_modules ] || npm install --cache "$ROOT/.npm-cache" >/dev/null
  (exec node --env-file-if-exists=.env server.ts > "$LOGDIR/runtime.log" 2>&1) &
  _pid=$!; PIDS+=("$_pid"); record_pid runtime "$_pid"
fi
wait_for runtime "http_code http://127.0.0.1:${RUNTIME_PORT}/api/copilotkit/info | grep -q 200" 40 || FAIL=1

# ---- 4/4 web ----------------------------------------------------------------
log "\n[dev-up] 4/4 web Next.js（端口 ${WEB_PORT}）"
if port_in_use "$WEB_PORT"; then
  info "端口 ${WEB_PORT} 已被占用，跳过启动"
else
  cd "$ROOT/web" || exit 1
  [ -d node_modules ] || npm install --cache "$ROOT/.npm-cache" >/dev/null
  (exec npm run dev -- -p "$WEB_PORT" > "$LOGDIR/web.log" 2>&1) &
  _pid=$!; PIDS+=("$_pid"); record_pid web "$_pid"
fi
wait_for web "http_code http://127.0.0.1:${WEB_PORT}/ | grep -q 200" 90 || FAIL=1

# ---- 汇总 -------------------------------------------------------------------
log ""
if [ "$FAIL" = "0" ]; then
  log "========================================================"
  log "✅ 整条链路已就绪："
  log "   MCP server       http://127.0.0.1:${MCP_PORT}/mcp"
  log "   LangGraph backend http://127.0.0.1:${BACKEND_PORT} (AG-UI POST /)"
  log "   CopilotKit runtime http://127.0.0.1:${RUNTIME_PORT}/api/copilotkit"
  log "   Web 界面         http://localhost:${WEB_PORT}"
  log ""
  log "   浏览器打开 http://localhost:${WEB_PORT} 即可对话。"
  log "   Ctrl+C 停止全部服务；或 ./dev-up.sh stop"
  log "========================================================"
else
  log "❌ 部分服务未就绪，请查看 ${LOGDIR}/ 下对应日志。" >&2
  exit 1
fi

# 前台等待，Ctrl+C 触发 trap 清理
wait
