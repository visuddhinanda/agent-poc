<div align="center">

# WikiPali MCP Server

**Every [WikiPali](https://www.wikipali.org) capability, wrapped as 35 MCP tools**

A stateless Streamable HTTP service · no credentials stored, supplied per request as headers

[中文](README.md) · **English**

[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](tsconfig.json)
[![MCP SDK](https://img.shields.io/badge/@modelcontextprotocol/sdk-1.30-orange.svg)](package.json)
[![Port](https://img.shields.io/badge/port-3000%2Fmcp-lightgrey.svg)](#configuration)

</div>

---

The bottom layer of `agent-poc`. A native TypeScript rewrite of every WikiPali capability from
[wikipali-plugins](https://github.com/iapt-platform/wikipali-plugins) as **35 MCP tools**
(`wikipali_*`), built on `@modelcontextprotocol/sdk` and served over stateless Streamable HTTP.

All three kinds of clients — agent tooling, editor plugins, and the LangGraph server — talk to
this one service. No credentials are stored here: clients supply them per request via HTTP
headers, and the server forwards them or mints a short-lived access token, then discards
everything. Nothing is written to disk, cached, or kept in a session.

## Where it sits

```
backend (:8800) ──MCP Streamable HTTP──▶ mcp (:3000/mcp) ──HTTPS──▶ WikiPali API
```

This service has **no dependency on other services in this repo** and can be started and
deployed on its own. Its consumer is [`backend/`](../backend/README.en.md), which connects
through `langchain-mcp-adapters`.

## Quick start

```bash
cd mcp
npm install
cp .env.example .env      # optional
npm run dev               # tsx --watch, http://127.0.0.1:3000/mcp by default
```

Requires Node.js 20+. Use `npm run start` for no watch.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `MCP_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` for remote/container/LangGraph access |
| `MCP_ALLOWED_HOSTS` | empty | Comma-separated Host allowlist when bound to a non-loopback address (DNS-rebinding protection) |
| `WIKIPALI_API_URL` | `https://www.wikipali.org/api` | Target WikiPali site |

> [!IMPORTANT]
> **Use `https://next.wikipali.org/api` for development.** The stable `www` site returns 500
> on `/v2/case` and similar endpoints.

> [!NOTE]
> Write credentials are **not configured here**; clients pass them as request headers. See the
> [credential model](../docs/credentials.md).

## Login (obtain a userToken)

```bash
npm run login             # interactive, hidden password, writes client-side ~/.wikipali/credentials.json
```

The token is never printed and the server never reads that file. Full flow:
[credential model](../docs/credentials.md).

## Test and build

```bash
npm test                  # 24 tests
npm run typecheck
npm run build             # tsc -> dist/
```

## Production deployment

```bash
npm run build
MCP_HOST=0.0.0.0 MCP_ALLOWED_HOSTS=mcp.example.com node dist/index.js
```

| Method | File |
|---|---|
| systemd | `deploy/wikipali-mcp.service` |
| Docker | `Dockerfile`, multi-stage (devDeps for the build, production deps + `dist/` at runtime) |
| Static clients | `deploy/clients/` (Claude Code / Desktop / LangGraph samples) |

> [!WARNING]
> **When bound to `0.0.0.0`, always front it with an authenticating proxy** and set
> `MCP_ALLOWED_HOSTS`. The server performs no authentication of its own.

## Design docs

- [Tool catalogue and semantics](../docs/mcp-tools.md) — the 35 tools, source layout, contracts that must not change
- [Credential model](../docs/credentials.md) — two tokens, per-tool header selection, the forwarding chain
- [Architecture and data flow](../docs/architecture.md) — the full four-layer picture

Design docs are currently written in Chinese only.

## License

[MIT](../LICENSE)
