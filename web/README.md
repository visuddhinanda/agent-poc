<div align="center">

# Web 前端

**巴利经文问答的聊天界面：Next.js 15 + CopilotKit**

对话流式输出 · 经文引用卡片与悬浮预览 · 侧栏浏览与 channel 列表

**中文** · [English](README.en.md)

[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg)](package.json)
[![React](https://img.shields.io/badge/React-19-blue.svg)](package.json)
[![Port](https://img.shields.io/badge/port-3000%2F3002-lightgrey.svg)](#配置)

</div>

---

`agent-poc` 的前端层。只与 [`../runtime`](../runtime/README.md) 通信，
不直接接触 backend 或 MCP server。

## 在整条链路中的位置

```
浏览器 ──▶ web (:3000) ──HTTP + SSE──▶ runtime (:3001) ──▶ backend (:8800) ──▶ mcp (:3000)
```

- **下游**：[`runtime/`](../runtime/README.md)，必须先启动（再往前是 backend）
- 页面把写端凭据头交给 runtime，由 runtime 透传给 backend

## 快速开始

```bash
cd web
npm install
npm run dev                   # http://localhost:3000
```

需要 Node.js 20+。

> [!IMPORTANT]
> **mcp server 默认也占用 3000。** 同机跑全链路时请把 web 换到 3002：
> ```bash
> npm run dev -- -p 3002      # 仓库根 dev-up.sh 即用 3002
> ```

## 配置

在 `web/.env.local` 中设置（该文件不入库）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NEXT_PUBLIC_RUNTIME_URL` | `http://localhost:3001/api/copilotkit` | CopilotKit Runtime 地址 |
| `NEXT_PUBLIC_WIKIPALI_BASE_URL` | `https://next.wikipali.org` | 引用卡片点击跳转的 WikiPali 阅读器基地址 |

> [!NOTE]
> `NEXT_PUBLIC_*` 变量在**构建时**注入，生产环境改值需要重新 build。
> 手机经局域网访问时，把 `NEXT_PUBLIC_RUNTIME_URL` 改成电脑的局域网 IP，
> 如 `http://192.168.x.x:3001/api/copilotkit`。

## 写端凭据（可选）

写句子/术语/批注需要凭据。页面从浏览器 `localStorage["token"]` 读一个 token，在
`app/page.tsx` 的 `wikipaliHeaders()` 里同时填 `Authorization` 与 `X-Wikipali-User-Token`
两个头发给 runtime。**没有该 token 时即纯读模式**，不影响正常问答。

详见[凭据模型](../docs/credentials.md)。

## 验证

1. 确保 backend（8800）与 runtime（3001）已启动
2. `npm run dev` 后打开 http://localhost:3000
3. 输入「什么是四圣谛？」发送
4. 预期：先看到工具调用状态，随后流式输出回答，并带可点击的经文引用卡片。
   未配置 `DEEPSEEK_API_KEY` 时回答带「（mock 演示模式）」前缀。

## 生产部署

```bash
npm ci
NEXT_PUBLIC_RUNTIME_URL=https://api.example.com/api/copilotkit npm run build
npm run start                 # 默认 3000，可用 -p 指定
```

- 部署到 Vercel 或任意 Node 环境；在**构建环境**里配好 `NEXT_PUBLIC_*` 变量。
- runtime 必须能被**浏览器**直接访问（不是仅服务端可达），并在其反代上收敛 CORS Origin。

> [!WARNING]
> **生产环境请给 runtime 走 HTTPS**，否则 HTTPS 页面无法请求 HTTP 端点。

## 设计文档

- [架构与数据流](../docs/architecture.md) —— 四层链路、请求流程、降级策略
- [凭据模型](../docs/credentials.md) —— 双 token 与全链路透传

## License

[MIT](../LICENSE)
