# web/ —— Next.js 前端（聊天页面）

Next.js 15 (App Router) + CopilotKit 经典组件组合：

- `CopilotKit`（来自 `@copilotkit/react-core/v2` 的向后兼容包装器，
  官方 LangGraph quickstart 同款接线方式，`useSingleEndpoint={false}` 对接多路由 runtime）
- `<CopilotChat />`（来自 `@copilotkit/react-ui`，样式 `@copilotkit/react-ui/styles.css` 已全局引入）

## 端口

- **3000**（`npm run dev` 默认）
- 依赖 runtime 已在 **3001** 运行（再往前是 backend **8000**）

## 启动

```bash
cd web
npm install
cp .env.example .env.local    # 可选：默认 runtime 地址已是 http://localhost:3001/api/copilotkit
npm run dev                   # http://localhost:3000
```

`NEXT_PUBLIC_RUNTIME_URL` 指到 CopilotKit Runtime 的 `/api/copilotkit`。
若在手机上通过局域网访问本页面，把它改成电脑的局域网 IP（如
`http://192.168.x.x:3001/api/copilotkit`）。

## 验证

1. 确保 backend(8000) 和 runtime(3001) 已启动
2. `npm run dev` 后打开 http://localhost:3000
3. 输入「什么是四圣谛？」发送
4. 预期：先看到工具调用状态（`retrieve_sutta_passage` 检索经文），
   随后流式输出回答（引用 SN 56.11 巴利原文与中文译文）。
   未配置 DEEPSEEK_API_KEY 时回答带「（mock 演示模式）」前缀。
