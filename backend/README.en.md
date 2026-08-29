<div align="center">

# LangGraph Agent Service

**An AI agent for the Pāli canon: LangGraph + DeepSeek + WikiPali MCP tools**

Exposed by FastAPI over the AG-UI protocol · stateless, write credentials arrive only as headers

[中文](README.md) · **English**

[![Python](https://img.shields.io/badge/Python-3.11%2B-blue.svg)](requirements.txt)
[![LangGraph](https://img.shields.io/badge/LangGraph-1.2-green.svg)](requirements.txt)
[![Port](https://img.shields.io/badge/port-8800-lightgrey.svg)](#configuration)

</div>

---

The agent layer of `agent-poc`. It connects to [`../mcp`](../mcp/README.en.md) via
`langchain-mcp-adapters`, loads 35 `wikipali_*` tools that reach the real corpus, and exposes
the agent through FastAPI over the **AG-UI protocol** for the CopilotKit Runtime.

## Where it sits

```
runtime (:3001) ──AG-UI (POST /, SSE)──▶ backend (:8800) ──MCP──▶ mcp (:3000)
                                              └──────────────────▶ DeepSeek API
```

- **Upstream**: [`runtime/`](../runtime/README.en.md) points `LangGraphHttpAgent({ url: "http://<IP>:8800" })` straight at `POST /`
- **Downstream (optional)**: [`mcp/`](../mcp/README.en.md); if unreachable, the agent falls back to the built-in mock retrieval tool `retrieve_sutta_passage`

## Quick start

```bash
cd backend
cp .env.example .env      # set DEEPSEEK_API_KEY (may be left empty)
./run.sh                  # first run creates the venv, installs deps, and starts
```

Requires Python 3.11+. Listens on `0.0.0.0:8800` (all interfaces, so a phone on the LAN can
reach it).

<details>
<summary><b>Manual install / without run.sh</b></summary>

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8800 --reload    # what run.sh runs
```
</details>

> [!TIP]
> **Start the MCP server first**, otherwise only the mock retrieval tool is available:
> ```bash
> cd ../mcp && npm run build && WIKIPALI_API_URL=https://next.wikipali.org/api npm run start
> ```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | none | If empty, the built-in mock model (`mock_llm.py`) is used |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible endpoint |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | |
| `WIKIPALI_MCP_URL` | `http://127.0.0.1:3000/mcp` | MCP server address |

> [!WARNING]
> **Do not put write credentials (modelToken / userToken) in `.env`.** Those environment
> variables were removed — the backend is stateless, and clients pass tokens per request as
> HTTP headers. See the [credential model](../docs/credentials.md).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/` | AG-UI endpoint, SSE event stream |
| `GET` | `/health` | Health check, includes `mcp_connected` |
| `GET` | `/info` | Service info |

## Verify

```bash
curl http://127.0.0.1:8800/health          # -> {"status":"ok", ..., "mcp_connected": true}
```

```bash
source .venv/bin/activate
python scripts/test_mcp.py                 # can MCP tools fetch wikipali data (read side, no credentials)
python scripts/test_graph_local.py         # graph logic offline (mock mode, no network)
python scripts/test_agui_stream.py         # end-to-end AG-UI SSE stream (works in mock mode)
python scripts/test_graph_mcp.py           # end-to-end agent → MCP → wikipali (needs DEEPSEEK_API_KEY)
```

## Production deployment

```bash
.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8800    # drop --reload
```

- Supervise with systemd / supervisor. The repo ships no backend service unit yet; adapt
  [`../mcp/deploy/wikipali-mcp.service`](../mcp/deploy/wikipali-mcp.service).
- Scale out with `--workers N` — the agent keeps no shared state.
- Make sure `WIKIPALI_MCP_URL` points at a running MCP server before deploying.

> [!WARNING]
> **This service performs no authentication.** Put it behind a reverse proxy if exposed
> publicly. It usually runs on the same host as the runtime and need only listen internally.

## Design docs

- [Architecture and data flow](../docs/architecture.md) — four layers, request flow, degradation
- [Credential model](../docs/credentials.md) — two tokens, `contextvars` + `ToolCallInterceptor` forwarding
- [MCP tool catalogue and semantics](../docs/mcp-tools.md)

Design docs are currently written in Chinese only.

## License

[MIT](../LICENSE)
