# backend/ —— LangGraph Agent 服务（Python）

巴利经文 AI 问答 agent：LangGraph + DeepSeek LLM + mock 经文检索工具，
通过 FastAPI 以 **AG-UI 协议** 暴露，供 CopilotKit Runtime 对接。

## 端口

- **8000**（绑定 `0.0.0.0`，便于手机经局域网访问）

## LLM 模式

- 配置了 `DEEPSEEK_API_KEY` → 使用 DeepSeek（`deepseek-chat`，OpenAI 兼容接口）
- **未配置 key → 自动使用内置 mock 演示模型**（`mock_llm.py`，模板回答），
  没有 key 也能完整验证「提问 → 工具检索 → 流式回答」全链路

## 启动

```bash
cd backend
cp .env.example .env      # 填入 DEEPSEEK_API_KEY
./run.sh                  # 自动建 venv、装依赖、启动
# 等价手动方式:
#   python3 -m venv .venv && source .venv/bin/activate
#   pip install -r requirements.txt
#   uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## 验证

```bash
# 1) 健康检查（无需 API key）
curl http://127.0.0.1:8000/health
# -> {"status":"ok", ..., "api_key_configured": true}

# 2) 离线验证图逻辑（不需要 API key、不联网）
source .venv/bin/activate
python scripts/test_graph_local.py

# 3) 端到端验证 AG-UI SSE 流（mock 模式即可跑；真实回答需配置 key）
python scripts/test_agui_stream.py
# 预期依次出现: RUN_STARTED -> STEP_STARTED -> TOOL_CALL_START/END（mock 检索）
#            -> TOOL_CALL_RESULT -> TEXT_MESSAGE_START
#            -> TEXT_MESSAGE_CONTENT...（流式回答）-> TEXT_MESSAGE_END -> RUN_FINISHED
```

AG-UI 端点即 `POST /`（CopilotKit Runtime 的
`LangGraphHttpAgent({ url: "http://<本机IP>:8000" })` 直接对接该地址）。
