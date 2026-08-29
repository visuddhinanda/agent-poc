<div align="center">

# CopilotKit Runtime

**把前端的 CopilotKit 请求转成 AG-UI 协议，转发给 LangGraph agent 并流回 SSE**

单文件 Node 服务 · 约 40 行，无构建步骤

**中文** · [English](README.en.md)

[![Node](https://img.shields.io/badge/Node-22%2B-green.svg)](package.json)
[![CopilotKit](https://img.shields.io/badge/@copilotkit/runtime-1.69-purple.svg)](package.json)
[![Port](https://img.shields.io/badge/port-3001-lightgrey.svg)](#配置)

</div>

---

`agent-poc` 的转发层。整个服务就是 [`server.ts`](server.ts)：注册一个 key 为 `pali_agent`
的 `LangGraphHttpAgent`，开启 CORS，监听 3001。

## 在整条链路中的位置

```
web (:3000/3002) ──HTTP + SSE──▶ runtime (:3001) ──AG-UI──▶ backend (:8800)
```

- **上游**：[`web/`](../web/README.md) 通过 `NEXT_PUBLIC_RUNTIME_URL` 指向本服务的 `/api/copilotkit`
- **下游**：[`backend/`](../backend/README.md)，必须先启动

> [!NOTE]
> runtime 默认把 `authorization` 与 `x-*` 请求头**透传**给 backend，
> 写端凭据正是靠这条路径传递。见[凭据模型](../docs/credentials.md)。

## 快速开始

```bash
cd runtime
npm install
cp .env.example .env      # 可选，默认值即可本机跑通
npm run dev               # node --watch，监听 0.0.0.0:3001
```

需要 Node.js 22+（用到 `--env-file-if-exists` 与原生 TypeScript 执行）。
不带 watch 用 `npm start`。绑定全网卡，便于手机经局域网访问。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LANGGRAPH_URL` | `http://localhost:8800` | backend 的 AG-UI 端点 |
| `PORT` | `3001` | 监听端口 |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/copilotkit/info` | 服务信息，列出已注册的 agent |
| `POST` | `/api/copilotkit/agent/pali_agent/run` | AG-UI 端点，SSE 事件流 |

`pali_agent` 是 `server.ts` 里注册 agent 的 key，前端用 `agent="pali_agent"` 引用。

## 验证

```bash
# 1) 服务信息
curl -s http://127.0.0.1:3001/api/copilotkit/info

# 2) 端到端：经 runtime 发 AG-UI 请求直达 backend，SSE 流回
curl -sN -X POST http://127.0.0.1:3001/api/copilotkit/agent/pali_agent/run \
  -H 'Content-Type: application/json' \
  -d '{"threadId":"rt-test-1","runId":"rt-run-1","tools":[],"context":[],"state":{},"forwardedProps":{},"messages":[{"id":"m1","role":"user","content":"什么是四圣谛？"}]}'
# 预期看到 RUN_STARTED / TOOL_CALL_START / TEXT_MESSAGE_CONTENT / RUN_FINISHED 等事件

# 3) CORS 头（跨域访问需要）
curl -sI -X OPTIONS http://127.0.0.1:3001/api/copilotkit/info \
  -H 'Origin: http://192.168.1.100:8081' | grep -i access-control
```

## 生产部署

```bash
npm ci --omit=dev
LANGGRAPH_URL=http://127.0.0.1:8800 PORT=3001 node server.ts
```

- 无构建产物，直接跑 `server.ts` 即可。
- 用 systemd / pm2 托管进程；service 单元可参照
  [`../mcp/deploy/wikipali-mcp.service`](../mcp/deploy/wikipali-mcp.service) 改写。
- runtime 与 backend 通常同机部署，`LANGGRAPH_URL` 用 `127.0.0.1` 即可，backend 不必对外暴露。

> [!WARNING]
> **CORS 当前是全放开的**（`cors: true`）。公网部署请在反向代理上收敛 Origin 白名单并加鉴权。

## 设计文档

- [架构与数据流](../docs/architecture.md) —— 四层链路、请求流程
- [凭据模型](../docs/credentials.md) —— runtime 在透传链路中的位置

## License

[MIT](../LICENSE)
