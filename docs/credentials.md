# 凭据模型（双 token）

> 设计文档。涉及 `web` → `runtime` → `backend` → `mcp` 全链路的写端授权。

## 1. 两个 token

客户端持有两个 token，经 HTTP 头逐请求传入；服务端按工具类型自动挑用。

| 头 | 值 | 用途 |
|---|---|---|
| `Authorization` | `Bearer <modelToken>` | **模型身份**：写句子/术语/批注时 WikiPali API 据此记 `editor_uid` = 模型（审计） |
| `X-Wikipali-User-Token` | `<userToken>` | **人类授权**：列 channel / 建模型 / 瞬时签发 access token |

## 2. 工具按类型取头

| 工具 | 需要的头 |
|---|---|
| 读端 17 个 + `wikipali_endpoint` | 无 |
| `whoami` / `ensure_model` / `revoke` / `channels` / `grant` / `my_terms` | `X-Wikipali-User-Token`（缺省回退 `Authorization`） |
| `write` / `term_add` / `term_edit`（含 `_preview` 与 `_commit`） | `Authorization` + `X-Wikipali-User-Token` |
| `discuss_add` / `discuss_reply` | 只需 `Authorization` |

## 3. 首次准备

```bash
cd mcp
npm run login                                            # 交互式，密码隐藏输入
npm run login -- --api next                              # 登录其它站点
printf '%s' "$PW" | npm run login -- --username me --password-stdin   # 自动化
```

1. `npm run login` 把 **userToken** 写入**客户端侧** `~/.wikipali/credentials.json`
   （权限 0600，路径可用 `WIKIPALI_CREDS_PATH` 覆盖）。token **不打印**，server 不读这个文件。
2. 调用 `wikipali_ensure_model`（带 `X-Wikipali-User-Token: <userToken>`）拿到 **modelToken**，
   客户端自行保存。
3. `wikipali_channels` 查可编辑的 channel。
4. 之后每次写操作配好两个头即可。

## 4. 全链路透传

```
浏览器 localStorage["token"]
   │  Authorization / X-Wikipali-User-Token
   ▼
runtime（默认透传 authorization 与 x-* 头）
   ▼
backend（contextvars 暂存 → ToolCallInterceptor 注入 MCP 连接头，请求结束即丢弃）
   ▼
mcp server（原样透传 / 瞬时签发 access token，不落盘）
   ▼
WikiPali API
```

要点：

- **不要**在 `backend/.env` 里配 `WIKIPALI_MODEL_TOKEN` / `WIKIPALI_USER_TOKEN`——
  这两个环境变量已移除，backend 无状态。
- web 前端目前用**同一个** `localStorage["token"]` 填两个头（见 `web/app/page.tsx`
  的 `wikipaliHeaders()`）。若要严格区分 modelToken 与 userToken，在该函数里分别读
  不同的 localStorage 字段即可。
- 没有 `localStorage["token"]` 时即纯读模式。

## 5. 静态客户端（Claude Code / Desktop / LangGraph）

这类客户端的 headers 是一次性写死的，**建议同时配两个头**，server 会按工具自动挑用，
读端忽略它们。样例见 `mcp/deploy/clients/`。

> ⚠️ Claude 系客户端对远程 HTTP MCP 的 `headers` 支持随版本演进，以官方文档为准。
> 不支持自定义头时，可在 server 前加反代/网关，把静态 Bearer 头注入到转发请求。
