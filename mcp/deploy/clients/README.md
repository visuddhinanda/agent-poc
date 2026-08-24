# 客户端连接配置：Bearer 头怎么配

server 无状态、不落凭据；**客户端**每次请求带两个 HTTP 头：

| 头 | 值 | 用途 |
|---|---|---|
| `Authorization` | `Bearer <modelToken>` | 模型身份：写句子/术语/批注时 API 据此记 `editor_uid`=模型（审计） |
| `X-Wikipali-User-Token` | `<userToken>` | 人类授权：列 channel / 建模型 / 签 access token |

**工具按类型取不同的头**（server 侧自动选择）：

| 工具 | 需要的头 |
|---|---|
| 读端 17 个 + `endpoint` | 无 |
| `whoami` / `ensure_model` / `revoke` / `channels` / `grant` / `my_terms` | `X-Wikipali-User-Token`（缺省回退 `Authorization`） |
| `write` / `term_add` / `term_edit`（preview+commit） | `Authorization`=modelToken + `X-Wikipali-User-Token`=userToken |
| `discuss` / `discuss_add` / `discuss_reply` | `Authorization`=modelToken |

## token 从哪来

1. `npm run login` → 把 userToken 写入**客户端侧** `~/.wikipali/credentials.json`（0600）。
2. 调用 `wikipali_ensure_model`（`X-Wikipali-User-Token: <userToken>`）→ 返回 `modelToken`，客户端同样保存。

> 静态客户端配置（Claude / LangGraph）里 headers 是一次性写死的，所以**建议同时配两个头**：
> `Authorization: Bearer <modelToken>` + `X-Wikipali-User-Token: <userToken>`。
> server 会按工具自动挑用，读端忽略它们。

## 各客户端样例

- Claude Code：`claude-code.mcp.json`（放项目根 `.mcp.json`，或 `claude mcp add` 导入）
- Claude Desktop：`claude-desktop.json`（并入 `claude_desktop_config.json` 的 `mcpServers`）
- LangGraph：`langgraph.py`

> ⚠️ Claude 系客户端对远程 HTTP MCP 的 `headers` 支持随版本演进，具体字段以当前官方文档为准；
> 不支持自定义头时，可在 server 前加一层反代/网关，把静态 Bearer 头注入到转发请求。
