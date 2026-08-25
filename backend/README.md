# backend/ —— LangGraph Agent 服务（Python）

巴利经文 AI 问答 agent：LangGraph + DeepSeek LLM + **WikiPali MCP 工具**（真实语料），
通过 FastAPI 以 **AG-UI 协议** 暴露，供 CopilotKit Runtime 对接。

后端通过 `langchain-mcp-adapters` 连接无状态 MCP server（`../mcp`），加载 35 个
`wikipali_*` 工具；MCP 不可用时自动回退到内置 mock 检索工具（`retrieve_sutta_passage`）。

## 端口

- **8800**（绑定 `0.0.0.0`，便于手机经局域网访问）

## LLM 模式

- 配置了 `DEEPSEEK_API_KEY` → 使用 DeepSeek（OpenAI 兼容接口）
- **未配置 key → 自动使用内置 mock 演示模型**（`mock_llm.py`，模板回答）

## 前置：启动 MCP server

后端依赖 `../mcp` 的 Streamable HTTP 服务（默认 `http://127.0.0.1:3000/mcp`）：

```bash
cd ../mcp
npm run build
WIKIPALI_API_URL=https://next.wikipali.org/api npm run start
# ↑ 用 next（最新代码）：www 稳定版上 /v2/case 等端点会 500
```

## 启动

```bash
cd backend
cp .env.example .env      # 填入 DEEPSEEK_API_KEY；按需改 WIKIPALI_MCP_URL
./run.sh                  # 自动建 venv、装依赖、启动
# 等价手动方式:
#   python3 -m venv .venv && source .venv/bin/activate
#   pip install -r requirements.txt
#   uvicorn main:app --host 0.0.0.0 --port 8800 --reload
```

## 验证

```bash
# 1) 健康检查（含 MCP 连接状态）
curl http://127.0.0.1:8800/health
# -> {"status":"ok", ..., "mcp_connected": true}

# 2) 直接验证 MCP 工具拉取 wikipali 数据（读端，无需凭据）
source .venv/bin/activate
python scripts/test_mcp.py

# 3) 端到端：LangGraph agent 通过 MCP 调用 wikipali 工具（需要 DEEPSEEK_API_KEY）
python scripts/test_graph_mcp.py

# 4) 离线验证图逻辑（mock 模式，不联网）
python scripts/test_graph_local.py

# 5) 端到端验证 AG-UI SSE 流（mock 模式即可跑）
python scripts/test_agui_stream.py
```

AG-UI 端点即 `POST /`（CopilotKit Runtime 的
`LangGraphHttpAgent({ url: "http://<本机IP>:8800" })` 直接对接该地址）。

## 写端（可选）

写句子/术语/批注需要客户端持 modelToken + userToken（见 `../mcp/README.md`），
配到 `WIKIPALI_MODEL_TOKEN` / `WIKIPALI_USER_TOKEN` 环境变量即可；默认纯读。
