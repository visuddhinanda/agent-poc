# MCP Server：WikiPali 客户端（agent-poc/mcp）

把 [wikipali-plugins](https://github.com/iapt-platform/wikipali-plugins) 里 WikiPali 的全部访问能力，
用 TypeScript + `@modelcontextprotocol/sdk` 原生重写为 MCP 工具。

**架构：无状态 Streamable HTTP 服务。** 三种场景（agent 工具 / plugin / LangGraph server）的客户端
都只连这一个服务；凭据不落 server——客户端每次请求经 HTTP 头提供，server 原样透传/瞬时签发、
随用随弃，不落盘、不缓存、无会话状态。

## 凭据模型（关键）

客户端持有**两个 token**，经 HTTP 头传入；server 按工具类型自动挑用：

| 头 | 值 | 用途 |
|---|---|---|
| `Authorization` | `Bearer <modelToken>` | 模型身份：写句子/术语/批注时 API 据此记 `editor_uid`=模型（审计） |
| `X-Wikipali-User-Token` | `<userToken>` | 人类授权：列 channel / 建模型 / 签 access token |

- 读端 17 个 + `endpoint`：无需凭据。
- `whoami` / `ensure_model` / `revoke` / `channels` / `grant` / `my_terms`：用 `X-Wikipali-User-Token`（缺省回退 `Authorization`）。
- 写句子/术语：`Authorization`=modelToken + `X-Wikipali-User-Token`=userToken（用于瞬时签发 access token）。
- 批注：只用 `Authorization`=modelToken（不需要 access token）。

## 结构

```
src/
  index.ts                    # 入口：启动 Streamable HTTP 服务
  server.ts                   # createMcpServer(): 注册全部 wikipali_* 工具
  login.ts                    # 登录脚本：取 userToken 写入客户端侧 ~/.wikipali/credentials.json
  transports/streamable-http.ts
  wikipali/
    sites.ts / errors.ts / client.ts / creds.ts / coords.ts / markup.ts
    api/read.ts               # 读端 17 个端点（无凭据）
    api/write.ts              # 写端端点（modelToken 透传 + userToken 签 access token）
    tools/{read,site,auth,write,common}.ts
test/
  server.test.ts / client.test.ts / wikipali.test.ts
deploy/
  wikipali-mcp.service        # systemd 服务单元
  clients/                    # Claude Code / Desktop / LangGraph 连接样例（含 Bearer 头）
Dockerfile
```

## 工具清单（35 个，`wikipali_*`）

**读端（17，无需凭据）**：`forms` `word` `count` `terms` `books` `toc` `paras` `chapter`
`chapter_fetch` `get` `versions` `search` `dist` `related` `articles` `article` `anthology`

**站点/身份（2）**：`endpoint`（只读）、`whoami`

**凭据与 token（4）**：`ensure_model`（返回 modelToken）、`revoke`、`channels`、`grant`

**写端（12）**：`my_terms` + `write`/`term_add`/`term_edit`/`discuss_add`/`discuss_reply`
各拆 `_preview`（dry-run）与 `_commit`（真写）。

## 运行

```bash
cd agent-poc/mcp
npm install
cp .env.example .env        # 可选（PORT / MCP_HOST / MCP_ALLOWED_HOSTS / WIKIPALI_API_URL）

npm run start               # 启动 Streamable HTTP，默认 http://127.0.0.1:3000/mcp
npm run dev                 # tsx --watch
```

- 远程/容器/LangGraph 调用：`MCP_HOST=0.0.0.0`（配合 `MCP_ALLOWED_HOSTS`），前置反代加鉴权。
- `WIKIPALI_API_URL` 决定 server 打哪个 WikiPali 站点（默认 `www` 稳定版；`next` 是最新代码）。

## 登录与凭据（客户端持有，server 不落）

```bash
npm run login                              # 交互式（密码隐藏输入），写 userToken 到 ~/.wikipali/credentials.json
npm run login -- --api next                # 登录其它站点
printf '%s' "$PW" | npm run login -- --username me --password-stdin   # 自动化
```

登录只把 **userToken** 写入客户端侧 `~/.wikipali/credentials.json`（0600，`WIKIPALI_CREDS_PATH` 可覆盖），
**不打印**。server 不读这个文件。

首次准备（客户端流程）：
1. `npm run login` 拿 userToken；
2. `wikipali_ensure_model`（`X-Wikipali-User-Token: <userToken>`）拿 `modelToken`，客户端同样保存；
3. `wikipali_channels` 查可编辑 channel；
4. 写操作配好两个头即可。

## 部署

- `Dockerfile`：多阶段构建（构建用 devDeps，运行只带生产依赖 + `dist/`）。
  ⚠️ 需要 `package-lock.json` 纳入版本管理（当前 `.gitignore` 忽略了它）。
- `deploy/wikipali-mcp.service`：systemd 服务单元。
- `deploy/clients/`：Claude Code / Claude Desktop / LangGraph 连接样例与 Bearer 头说明。

## 测试 / 构建

```bash
npm test               # 24 测试
npm run typecheck
npm run build          # tsc -> dist/
```

## 关键语义（从 Python 插件 1:1 保留）

- 空结果 ≠ 故障（`access-token count:0`=无编辑权、`chapter-content` 空占位、`related` 查无关联时 500）
- `count` < 提交条数 = 有句子被静默跳过，必须报差集
- 检索前必须展开词形；黑体/页码/本文·义注·复注层次/机器译标注；401 不自动重试；`book` 必须整数
