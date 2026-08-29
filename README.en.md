<div align="center">

# agent-poc

**A prototype AI agent for the Pāli canon: LangGraph + DeepSeek + the real [WikiPali](https://www.wikipali.org) corpus**

Four services · MCP tools reach the corpus, AG-UI streams the conversation, CopilotKit renders the UI

[中文](README.md) · **English**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![LangGraph](https://img.shields.io/badge/agent-LangGraph-blue.svg)](backend)
[![MCP](https://img.shields.io/badge/tools-MCP%20%C3%9735-orange.svg)](mcp)
[![CopilotKit](https://img.shields.io/badge/ui-CopilotKit-purple.svg)](web)

</div>

---

## Quick start

```bash
./dev-up.sh          # starts all four services with health checks; Ctrl+C stops everything
./dev-up.sh stop     # stop everything
```

Open http://localhost:3002 and ask "什么是四圣谛？" (What are the Four Noble Truths?).

Logs land in `logs/`; override ports with `MCP_PORT` / `BACKEND_PORT` / `RUNTIME_PORT` / `WEB_PORT`.

> [!NOTE]
> **It runs without `DEEPSEEK_API_KEY`.** The backend falls back to a built-in mock model,
> prefixes answers with "（mock 演示模式）", and the whole chain is still verifiable.

## Services

```
browser ──▶ web (:3000/3002) ──▶ runtime (:3001) ──▶ backend (:8800) ──▶ mcp (:3000) ──▶ WikiPali API
```

| Directory | Service | Port | Role |
|---|---|---|---|
| [`web/`](web/README.en.md) | Next.js frontend | 3000 (3002 in the full stack) | Chat UI, citation cards |
| [`runtime/`](runtime/README.en.md) | CopilotKit Runtime | 3001 | Translates to AG-UI, streams SSE back |
| [`backend/`](backend/README.en.md) | LangGraph agent | 8800 | FastAPI + AG-UI, calls the LLM and tools |
| [`mcp/`](mcp/README.en.md) | WikiPali MCP server | 3000 | 35 `wikipali_*` tools |

Dependencies run **one way**: each layer knows only the one below it. Every service starts
and deploys independently — see its own README for setup and deployment.

> [!IMPORTANT]
> **web and mcp both default to port 3000.** When running the full stack on one machine,
> move web to 3002 (as `dev-up.sh` does).

## Design docs

- [Architecture and data flow](docs/architecture.md) — four layers, request flow, degradation
- [Credential model (two tokens)](docs/credentials.md) — write authorization and header forwarding
- [MCP tool catalogue and semantics](docs/mcp-tools.md) — the 35 tools and the contracts behind them

Design docs are currently written in Chinese only.

## Repository layout

```
web/         Next.js frontend
runtime/     CopilotKit Runtime (single-file server.ts)
backend/     LangGraph agent (FastAPI + AG-UI)
mcp/         WikiPali MCP server (TypeScript)
docs/        Design documents
dev-up.sh    Bring up the whole stack
logs/        dev-up.sh runtime logs and pid files
```

## Links

- [WikiPali](https://www.wikipali.org)
- [iapt-platform/wikipali-plugins](https://github.com/iapt-platform/wikipali-plugins) — where this repo's MCP tools were ported from
- Handover status: [STATUS.md](STATUS.md)

## License

[MIT](LICENSE)
