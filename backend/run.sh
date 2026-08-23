#!/usr/bin/env bash
# backend 启动脚本：首次运行自动建 venv 并安装依赖，然后监听 0.0.0.0:8000
set -e
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "[run.sh] 创建虚拟环境 .venv ..."
  python3 -m venv .venv
fi

source .venv/bin/activate

if ! python -c "import fastapi, ag_ui_langgraph, langgraph" >/dev/null 2>&1; then
  echo "[run.sh] 安装依赖 ..."
  pip install -r requirements.txt
fi

echo "[run.sh] 启动 backend: http://0.0.0.0:8000  (AG-UI 端点: POST /)"
exec uvicorn main:app --host 0.0.0.0 --port 8000 --reload
