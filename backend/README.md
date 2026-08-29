<div align="center">

# LangGraph Agent 服务

**巴利经文 AI 问答 agent：LangGraph + DeepSeek + WikiPali MCP 工具**

FastAPI 以 AG-UI 协议暴露 · 无状态，写端凭据只随请求头传入

**中文** · [English](README.en.md)

[![Python](https://img.shields.io/badge/Python-3.11%2B-blue.svg)](requirements.txt)
[![LangGraph](https://img.shields.io/badge/LangGraph-1.2-green.svg)](requirements.txt)
[![Port](https://img.shields.io/badge/port-8800-lightgrey.svg)](#配置)

</div>

---

`agent-poc` 的 agent 层。用 `langchain-mcp-adapters` 连接 [`../mcp`](../mcp/README.md)，
加载 35 个 `wikipali_*` 工具访问真实语料，再以 **AG-UI 协议**通过 FastAPI 暴露给
CopilotKit Runtime。

## 在整条链路中的位置

```
runtime (:3001) ──AG-UI (POST /, SSE)──▶ backend (:8800) ──MCP──▶ mcp (:3000)
                                              └──────────────────▶ DeepSeek API
```

- **上游**：[`runtime/`](../runtime/README.md) 用 `LangGraphHttpAgent({ url: "http://<IP>:8800" })` 直连 `POST /`
- **下游（可选）**：[`mcp/`](../mcp/README.md)，不可用时自动回退到内置 mock 检索工具 `retrieve_sutta_passage`

## 快速开始

```bash
cd backend
cp .env.example .env      # 填 DEEPSEEK_API_KEY（可留空）
./run.sh                  # 首次运行自动建 venv、装依赖并启动
```

需要 Python 3.11+。监听 `0.0.0.0:8800`（绑定全网卡，便于手机经局域网访问）。

<details>
<summary><b>手动安装 / 不用 run.sh</b></summary>

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8800 --reload    # run.sh 的等价命令
```
</details>

> [!TIP]
> **建议先启动 MCP server**，否则只能用 mock 检索工具：
> ```bash
> cd ../mcp && npm run build && WIKIPALI_API_URL=https://next.wikipali.org/api npm run start
> ```

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 无 | 留空则自动使用内置 mock 演示模型（`mock_llm.py`） |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容接口 |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | |
| `WIKIPALI_MCP_URL` | `http://127.0.0.1:3000/mcp` | MCP server 地址 |

> [!WARNING]
> **写端凭据（modelToken / userToken）不要写进 `.env`。** 相关环境变量已移除——后端无状态，
> token 由客户端持有，逐请求经 HTTP 头传入。见[凭据模型](../docs/credentials.md)。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/` | AG-UI 端点，SSE 事件流 |
| `GET` | `/health` | 健康检查，含 `mcp_connected` |
| `GET` | `/info` | 服务信息 |

## 验证

```bash
curl http://127.0.0.1:8800/health          # -> {"status":"ok", ..., "mcp_connected": true}
```

```bash
source .venv/bin/activate
python scripts/test_mcp.py                 # MCP 工具能否拉到 wikipali 数据（读端，无需凭据）
python scripts/test_graph_local.py         # 离线验证图逻辑（mock 模式，不联网）
python scripts/test_agui_stream.py         # 端到端 AG-UI SSE 流（mock 模式即可跑）
python scripts/test_graph_mcp.py           # 端到端：agent 经 MCP 调用 wikipali（需 DEEPSEEK_API_KEY）
```

## 生产部署

```bash
.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8800    # 去掉 --reload
```

- 用 systemd / supervisor 托管进程。仓库内暂未提供 backend 的 service 单元，
  可参照 [`../mcp/deploy/wikipali-mcp.service`](../mcp/deploy/wikipali-mcp.service) 改写。
- 需要横向扩展时用 `--workers N`——agent 本身无共享状态。
- 部署前确认 `WIKIPALI_MCP_URL` 指向已就绪的 MCP server。

> [!WARNING]
> **本服务不做鉴权。** 公网暴露时请前置反向代理。通常与 runtime 同机部署，只监听内网即可。

## 设计文档

- [架构与数据流](../docs/architecture.md) —— 四层链路、请求流程、降级策略
- [凭据模型](../docs/credentials.md) —— 双 token、`contextvars` + `ToolCallInterceptor` 透传机制
- [MCP 工具清单与语义](../docs/mcp-tools.md)

## License

[MIT](../LICENSE)
