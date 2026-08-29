# 架构与数据流

> 设计文档。各服务的安装与运行方式见对应目录的 README。

## 1. 四层链路

```
浏览器 (web, Next.js)
   │  HTTP + SSE
   ▼
CopilotKit Runtime (runtime, Node)          :3001  /api/copilotkit
   │  AG-UI 协议 (POST /, SSE)
   ▼
LangGraph Agent (backend, Python/FastAPI)   :8800  POST /
   │  MCP Streamable HTTP
   ▼
WikiPali MCP Server (mcp, TypeScript)       :3000  /mcp
   │  HTTPS
   ▼
WikiPali API (www / next.wikipali.org)
```

| 层 | 目录 | 端口 | 对外入口 | 上游依赖 |
|---|---|---|---|---|
| 前端 | `web/` | 3000（`dev-up.sh` 用 3002） | `/` | runtime |
| Runtime | `runtime/` | 3001 | `/api/copilotkit` | backend |
| Agent | `backend/` | 8800 | `POST /`（AG-UI） | mcp、DeepSeek |
| MCP | `mcp/` | 3000 | `/mcp` | WikiPali API |

`dev-up.sh` 把 web 放在 3002，是为了避开 mcp 占用的 3000。

## 2. 一次对话的完整流程

1. 浏览器在 `web/app/page.tsx` 里向 `NEXT_PUBLIC_RUNTIME_URL` 发起请求，附带写端凭据头（若有）。
2. runtime 用 `LangGraphHttpAgent` 把请求转成 AG-UI 请求打到 `LANGGRAPH_URL`（backend），
   并透传 `authorization` 与 `x-*` 头。注册的 agent key 是 `pali_agent`。
3. backend 的 LangGraph 图调用 LLM；需要语料时调用 `wikipali_*` 工具。
4. 工具调用经 `langchain-mcp-adapters` 转成 MCP 调用打到 `WIKIPALI_MCP_URL`，
   凭据头由 `ToolCallInterceptor` 在每次调用时注入。
5. MCP server 请求 WikiPali API，结果原路返回。
6. backend 以 AG-UI 事件流（`RUN_STARTED` / `TOOL_CALL_START` / `TEXT_MESSAGE_CONTENT` /
   `RUN_FINISHED`）经 runtime 的 SSE 回到浏览器。

## 3. 降级与可选依赖

| 缺什么 | 行为 |
|---|---|
| `DEEPSEEK_API_KEY` | backend 走内置 mock 演示模型（`mock_llm.py`），回答带「（mock 演示模式）」前缀 |
| MCP server 不可用 | backend 回退到内置 mock 检索工具 `retrieve_sutta_passage` |
| 无写端凭据 | 全链路降为纯读模式，读端 17 个工具无需凭据 |

因此仅启动 backend + runtime + web（不启动 mcp、不配 key）也能跑通演示。

## 4. 无状态原则

backend 与 mcp 都**不持久化任何凭据**：

- 不写文件、不读环境变量、不缓存、无会话状态；
- 凭据只在单次请求的生命周期内存在，请求结束即丢弃；
- token 由客户端持有，逐请求经 HTTP 头传递。

细节见 [凭据模型](./credentials.md)。

## 5. WikiPali 站点选择

`WIKIPALI_API_URL` 决定 mcp server 打哪个站点：

- `https://www.wikipali.org/api` —— 稳定版（默认），但 `/v2/case` 等端点会 500；
- `https://next.wikipali.org/api` —— 最新代码，**开发联调请用这个**（`dev-up.sh` 已默认）。
