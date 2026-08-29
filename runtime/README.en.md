<div align="center">

# CopilotKit Runtime

**Translates CopilotKit requests into AG-UI, forwards them to the LangGraph agent, streams SSE back**

A single-file Node service · ~40 lines, no build step

[中文](README.md) · **English**

[![Node](https://img.shields.io/badge/Node-22%2B-green.svg)](package.json)
[![CopilotKit](https://img.shields.io/badge/@copilotkit/runtime-1.69-purple.svg)](package.json)
[![Port](https://img.shields.io/badge/port-3001-lightgrey.svg)](#configuration)

</div>

---

The forwarding layer of `agent-poc`. The whole service is [`server.ts`](server.ts): it
registers one `LangGraphHttpAgent` under the key `pali_agent`, enables CORS, and listens on 3001.

## Where it sits

```
web (:3000/3002) ──HTTP + SSE──▶ runtime (:3001) ──AG-UI──▶ backend (:8800)
```

- **Upstream**: [`web/`](../web/README.en.md) points `NEXT_PUBLIC_RUNTIME_URL` at this service's `/api/copilotkit`
- **Downstream**: [`backend/`](../backend/README.en.md), which must already be running

> [!NOTE]
> The runtime **forwards** `authorization` and `x-*` request headers to the backend by
> default — that is exactly how write credentials travel. See the
> [credential model](../docs/credentials.md).

## Quick start

```bash
cd runtime
npm install
cp .env.example .env      # optional; defaults work locally
npm run dev               # node --watch, listens on 0.0.0.0:3001
```

Requires Node.js 22+ (uses `--env-file-if-exists` and native TypeScript execution). Use
`npm start` for no watch. It binds all interfaces so a phone on the LAN can reach it.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `LANGGRAPH_URL` | `http://localhost:8800` | The backend's AG-UI endpoint |
| `PORT` | `3001` | Listen port |

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/copilotkit/info` | Service info, lists registered agents |
| `POST` | `/api/copilotkit/agent/pali_agent/run` | AG-UI endpoint, SSE event stream |

`pali_agent` is the agent key registered in `server.ts`; the frontend refers to it as
`agent="pali_agent"`.

## Verify

```bash
# 1) Service info
curl -s http://127.0.0.1:3001/api/copilotkit/info

# 2) End to end: an AG-UI request through the runtime to the backend, streamed back
curl -sN -X POST http://127.0.0.1:3001/api/copilotkit/agent/pali_agent/run \
  -H 'Content-Type: application/json' \
  -d '{"threadId":"rt-test-1","runId":"rt-run-1","tools":[],"context":[],"state":{},"forwardedProps":{},"messages":[{"id":"m1","role":"user","content":"什么是四圣谛？"}]}'
# Expect RUN_STARTED / TOOL_CALL_START / TEXT_MESSAGE_CONTENT / RUN_FINISHED events

# 3) CORS headers (needed for cross-origin access)
curl -sI -X OPTIONS http://127.0.0.1:3001/api/copilotkit/info \
  -H 'Origin: http://192.168.1.100:8081' | grep -i access-control
```

## Production deployment

```bash
npm ci --omit=dev
LANGGRAPH_URL=http://127.0.0.1:8800 PORT=3001 node server.ts
```

- No build artefacts — run `server.ts` directly.
- Supervise with systemd / pm2; adapt
  [`../mcp/deploy/wikipali-mcp.service`](../mcp/deploy/wikipali-mcp.service) for a unit file.
- The runtime and backend usually run on the same host, so `LANGGRAPH_URL` can stay on
  `127.0.0.1` and the backend need not be exposed.

> [!WARNING]
> **CORS is currently wide open** (`cors: true`). In public deployments, restrict the origin
> allowlist and add authentication at the reverse proxy.

## Design docs

- [Architecture and data flow](../docs/architecture.md) — the four layers and request flow
- [Credential model](../docs/credentials.md) — where the runtime sits in the forwarding chain

Design docs are currently written in Chinese only.

## License

[MIT](../LICENSE)
