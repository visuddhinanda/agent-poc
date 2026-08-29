<div align="center">

# Web Frontend

**The chat interface for Pāli canon Q&A: Next.js 15 + CopilotKit**

Streamed answers · citation cards with hover previews · browsing sidebar and channel list

[中文](README.md) · **English**

[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg)](package.json)
[![React](https://img.shields.io/badge/React-19-blue.svg)](package.json)
[![Port](https://img.shields.io/badge/port-3000%2F3002-lightgrey.svg)](#configuration)

</div>

---

The frontend layer of `agent-poc`. It talks only to [`../runtime`](../runtime/README.en.md);
it never touches the backend or MCP server directly.

## Where it sits

```
browser ──▶ web (:3000) ──HTTP + SSE──▶ runtime (:3001) ──▶ backend (:8800) ──▶ mcp (:3000)
```

- **Downstream**: [`runtime/`](../runtime/README.en.md), which must be running (and the backend behind it)
- The page hands write-credential headers to the runtime, which forwards them to the backend

## Quick start

```bash
cd web
npm install
npm run dev                   # http://localhost:3000
```

Requires Node.js 20+.

> [!IMPORTANT]
> **The mcp server also defaults to port 3000.** When running the full stack on one machine,
> move web to 3002:
> ```bash
> npm run dev -- -p 3002      # dev-up.sh in the repo root uses 3002
> ```

## Configuration

Set these in `web/.env.local` (not committed):

| Variable | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_RUNTIME_URL` | `http://localhost:3001/api/copilotkit` | CopilotKit Runtime address |
| `NEXT_PUBLIC_WIKIPALI_BASE_URL` | `https://next.wikipali.org` | Base URL of the WikiPali reader that citation cards link to |

> [!NOTE]
> `NEXT_PUBLIC_*` variables are inlined **at build time**; changing them in production
> requires a rebuild. For LAN access from a phone, set `NEXT_PUBLIC_RUNTIME_URL` to the
> computer's LAN IP, e.g. `http://192.168.x.x:3001/api/copilotkit`.

## Write credentials (optional)

Writing sentences, terms, or annotations needs credentials. The page reads a single token
from the browser's `localStorage["token"]` and, in `wikipaliHeaders()` in `app/page.tsx`,
sends it as both `Authorization` and `X-Wikipali-User-Token` to the runtime. **Without that
token the app is read-only**, which does not affect normal Q&A.

See the [credential model](../docs/credentials.md).

## Verify

1. Make sure the backend (8800) and runtime (3001) are running
2. Run `npm run dev` and open http://localhost:3000
3. Send "什么是四圣谛？" (What are the Four Noble Truths?)
4. Expect a tool-call status first, then a streamed answer with clickable citation cards.
   Without `DEEPSEEK_API_KEY`, answers are prefixed with "（mock 演示模式）".

## Production deployment

```bash
npm ci
NEXT_PUBLIC_RUNTIME_URL=https://api.example.com/api/copilotkit npm run build
npm run start                 # port 3000 by default, override with -p
```

- Deploy on Vercel or any Node host; set the `NEXT_PUBLIC_*` variables in the **build** environment.
- The runtime must be reachable **from the browser** (not just server-side), with a tightened
  CORS origin allowlist on its proxy.

> [!WARNING]
> **Serve the runtime over HTTPS in production** — an HTTPS page cannot call an HTTP endpoint.

## Design docs

- [Architecture and data flow](../docs/architecture.md) — four layers, request flow, degradation
- [Credential model](../docs/credentials.md) — the two tokens and how they are forwarded

Design docs are currently written in Chinese only.

## License

[MIT](../LICENSE)
