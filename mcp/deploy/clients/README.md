# 客户端连接样例

静态客户端连接 WikiPali MCP server 的配置样例。

| 客户端 | 文件 | 放置位置 |
|---|---|---|
| Claude Code | `claude-code.mcp.json` | 项目根 `.mcp.json`，或用 `claude mcp add` 导入 |
| Claude Desktop | `claude-desktop.json` | 并入 `claude_desktop_config.json` 的 `mcpServers` |
| LangGraph | `langgraph.py` | 按需引用 |

## Bearer 头怎么配

server 无状态、不落凭据，客户端每次请求带两个头。静态配置里 headers 是一次性写死的，
所以**建议同时配两个头**——server 会按工具自动挑用，读端忽略它们：

```
Authorization: Bearer <modelToken>
X-Wikipali-User-Token: <userToken>
```

token 从哪来、哪个工具用哪个头，见[凭据模型](../../../docs/credentials.md)。

> ⚠️ Claude 系客户端对远程 HTTP MCP 的 `headers` 支持随版本演进，以官方文档为准。
> 不支持自定义头时，可在 server 前加反代/网关，把静态 Bearer 头注入到转发请求。
