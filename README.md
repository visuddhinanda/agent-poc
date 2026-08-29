<div align="center">

# agent-poc

**巴利经文 AI 问答 agent 原型：LangGraph + DeepSeek + [WikiPali](https://www.wikipali.org) 真实语料**

四层服务 · MCP 工具接语料，AG-UI 流式对话，CopilotKit 呈现界面

**中文** · [English](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![LangGraph](https://img.shields.io/badge/agent-LangGraph-blue.svg)](backend)
[![MCP](https://img.shields.io/badge/tools-MCP%20%C3%9735-orange.svg)](mcp)
[![CopilotKit](https://img.shields.io/badge/ui-CopilotKit-purple.svg)](web)

</div>

---

## 快速开始

```bash
./dev-up.sh          # 依次拉起四个服务 + 健康检查，Ctrl+C 停止全部
./dev-up.sh stop     # 停止全部
```

浏览器打开 http://localhost:3002 ，输入「什么是四圣谛？」即可对话。

日志在 `logs/`，端口可用 `MCP_PORT` / `BACKEND_PORT` / `RUNTIME_PORT` / `WEB_PORT` 覆盖。

> [!NOTE]
> **不配 `DEEPSEEK_API_KEY` 也能跑通。** backend 会自动改用内置 mock 演示模型，
> 回答带「（mock 演示模式）」前缀，整条链路照样验证得了。

## 服务构成

```
浏览器 ──▶ web (:3000/3002) ──▶ runtime (:3001) ──▶ backend (:8800) ──▶ mcp (:3000) ──▶ WikiPali API
```

| 目录 | 服务 | 端口 | 职责 |
|---|---|---|---|
| [`web/`](web/README.md) | Next.js 前端 | 3000（全链路时 3002） | 聊天界面、经文引用卡片 |
| [`runtime/`](runtime/README.md) | CopilotKit Runtime | 3001 | 转 AG-UI 协议、流回 SSE |
| [`backend/`](backend/README.md) | LangGraph Agent | 8800 | FastAPI + AG-UI，调 LLM 与工具 |
| [`mcp/`](mcp/README.md) | WikiPali MCP Server | 3000 | 35 个 `wikipali_*` 工具 |

依赖是**单向**的：上层只认识下一层。每个服务都可独立启动、独立部署，
安装与部署细节见各自 README。

> [!IMPORTANT]
> **web 和 mcp 默认都用 3000。** 同机跑全链路时把 web 换到 3002（`dev-up.sh` 已这么做）。

## 设计文档

- [架构与数据流](docs/architecture.md) —— 四层链路、请求流程、降级策略
- [凭据模型（双 token）](docs/credentials.md) —— 写端授权与全链路透传
- [MCP 工具清单与语义](docs/mcp-tools.md) —— 35 个工具与必须保留的调用约定

## 仓库结构

```
web/         Next.js 前端
runtime/     CopilotKit Runtime（单文件 server.ts）
backend/     LangGraph agent（FastAPI + AG-UI）
mcp/         WikiPali MCP server（TypeScript）
docs/        设计文档
dev-up.sh    一键拉起全链路
logs/        dev-up.sh 的运行日志与 pid
```

## 相关链接

- [WikiPali 网站](https://www.wikipali.org)
- [iapt-platform/wikipali-plugins](https://github.com/iapt-platform/wikipali-plugins) —— 本仓库 MCP 工具的移植来源
- 开发交接状态见 [STATUS.md](STATUS.md)

## License

[MIT](LICENSE)
