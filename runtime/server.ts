/**
 * CopilotKit Runtime（独立 Node.js 服务）
 *
 * 职责：把前端的 CopilotKit 请求转发给 backend 的 LangGraph agent（AG-UI 协议），
 * 并把 SSE 事件流回前端。web 与 mobile 都连接 http://<本机IP>:3001/api/copilotkit
 *
 * 端口 3001，绑定 0.0.0.0（手机经局域网访问需要）。
 */
import { createServer } from "node:http";
import { CopilotRuntime, InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";

const PORT = Number(process.env.PORT || 3001);
// backend 的 AG-UI 端点地址（backend 与 runtime 在同一台电脑上，用 localhost 即可）
const LANGGRAPH_URL = process.env.LANGGRAPH_URL || "http://localhost:8000";

const runtime = new CopilotRuntime({
  agents: {
    // :agentId 即这里的 key，前端用 agent="pali_agent" 引用
    pali_agent: new LangGraphHttpAgent({
      url: LANGGRAPH_URL,
    }),
  },
  runner: new InMemoryAgentRunner(),
});

const listener = createCopilotNodeListener({
  runtime,
  basePath: "/api/copilotkit",
  cors: true, // 允许 web(3000)/mobile(Expo) 跨域访问
});

createServer(listener).listen(PORT, "0.0.0.0", () => {
  console.log(`[runtime] CopilotKit Runtime: http://0.0.0.0:${PORT}/api/copilotkit`);
  console.log(`[runtime] LangGraph backend (AG-UI): ${LANGGRAPH_URL}`);
});
