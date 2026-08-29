<div align="center">

# WikiPali MCP Server

**把 [WikiPali](https://www.wikipali.org) 的全部访问能力封装成 35 个 MCP 工具**

无状态 Streamable HTTP 服务 · 凭据不落 server，随请求头逐次传入

**中文** · [English](README.en.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](tsconfig.json)
[![MCP SDK](https://img.shields.io/badge/@modelcontextprotocol/sdk-1.30-orange.svg)](package.json)
[![Port](https://img.shields.io/badge/port-3000%2Fmcp-lightgrey.svg)](#配置)

</div>

---

`agent-poc` 的最底层服务。把 [wikipali-plugins](https://github.com/iapt-platform/wikipali-plugins)
里的 WikiPali 访问能力，用 TypeScript + `@modelcontextprotocol/sdk` 原生重写为 **35 个 MCP 工具**
（`wikipali_*`），以无状态 Streamable HTTP 对外提供。

三类客户端——agent 工具、编辑器 plugin、LangGraph server——都只连这一个服务。
凭据不落 server：客户端每次请求经 HTTP 头提供，server 原样透传或瞬时签发 access token，
用完即弃，不落盘、不缓存、无会话状态。

## 在整条链路中的位置

```
backend (:8800) ──MCP Streamable HTTP──▶ mcp (:3000/mcp) ──HTTPS──▶ WikiPali API
```

本服务**不依赖仓库内其它服务**，可独立启动与独立部署。
上游是 [`backend/`](../backend/README.md)，它通过 `langchain-mcp-adapters` 连接本服务。

## 快速开始

```bash
cd mcp
npm install
cp .env.example .env      # 可选
npm run dev               # tsx --watch，默认 http://127.0.0.1:3000/mcp
```

需要 Node.js 20+。不带 watch 用 `npm run start`。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `MCP_HOST` | `127.0.0.1` | 绑定地址。远程/容器/LangGraph 调用时设 `0.0.0.0` |
| `MCP_ALLOWED_HOSTS` | 空 | 绑定非回环地址时的 Host 白名单（逗号分隔），防 DNS rebinding |
| `WIKIPALI_API_URL` | `https://www.wikipali.org/api` | 目标 WikiPali 站点 |

> [!IMPORTANT]
> **开发联调请用 `https://next.wikipali.org/api`。** www 稳定版上 `/v2/case` 等端点会 500。

> [!NOTE]
> 写端凭据**不在这里配置**，由客户端经请求头传入，见[凭据模型](../docs/credentials.md)。

## 登录（取 userToken）

```bash
npm run login             # 交互式，密码隐藏输入，写入客户端侧 ~/.wikipali/credentials.json
```

token 不打印，server 不读这个文件。完整流程见[凭据模型](../docs/credentials.md)。

## 测试与构建

```bash
npm test                  # 24 个测试
npm run typecheck
npm run build             # tsc -> dist/
```

## 生产部署

```bash
npm run build
MCP_HOST=0.0.0.0 MCP_ALLOWED_HOSTS=mcp.example.com node dist/index.js
```

| 方式 | 文件 |
|---|---|
| systemd | `deploy/wikipali-mcp.service` |
| Docker | `Dockerfile`，多阶段构建（构建用 devDeps，运行只带生产依赖 + `dist/`） |
| 静态客户端接入 | `deploy/clients/`（Claude Code / Desktop / LangGraph 样例） |

> [!WARNING]
> **绑定 `0.0.0.0` 时务必前置反代并加鉴权**，同时设好 `MCP_ALLOWED_HOSTS`。
> server 本身不做任何鉴权。

## 设计文档

- [工具清单与语义](../docs/mcp-tools.md) —— 35 个工具、源码结构、必须保留的调用约定
- [凭据模型](../docs/credentials.md) —— 双 token、工具按类型取头、透传链路
- [架构与数据流](../docs/architecture.md) —— 四层链路全貌

## License

[MIT](../LICENSE)
