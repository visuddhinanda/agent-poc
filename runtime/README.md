# runtime/ —— CopilotKit Runtime（Node.js）

独立 Node 服务，把 web / mobile 的 CopilotKit 请求转发给 backend 的
LangGraph agent（AG-UI 协议），并把 SSE 事件流回前端。

## 端口

- **3001**（绑定 `0.0.0.0`，手机经局域网访问需要）
- 依赖 backend 已在 **8000** 运行

## 启动

```bash
cd runtime
npm install
cp .env.example .env    # 可选：默认 LANGGRAPH_URL=http://localhost:8000, PORT=3001
npm start               # 或 npm run dev（--watch）
```

## 验证

```bash
# 1) 服务信息（列出注册的 agent）
curl -s http://127.0.0.1:3001/api/copilotkit/info

# 2) 端到端：经 runtime 发 AG-UI 请求，直达 backend 的 agent，SSE 流回
curl -sN -X POST http://127.0.0.1:3001/api/copilotkit/agent/pali_agent/run \
  -H 'Content-Type: application/json' \
  -d '{"threadId":"rt-test-1","runId":"rt-run-1","tools":[],"context":[],"state":{},"forwardedProps":{},"messages":[{"id":"m1","role":"user","content":"什么是四圣谛？"}]}'
# 预期看到 RUN_STARTED / TOOL_CALL_START / TEXT_MESSAGE_CONTENT / RUN_FINISHED 等事件

# 3) CORS 头（手机跨域访问需要）
curl -sI -X OPTIONS http://127.0.0.1:3001/api/copilotkit/info \
  -H 'Origin: http://192.168.1.100:8081' | grep -i access-control
```

Runtime 对外暴露的 AG-UI 端点是 `POST /api/copilotkit/agent/pali_agent/run`
（`pali_agent` 是 server.ts 里注册 agent 的 key，前端 provider 用 `agent="pali_agent"` 引用）。
