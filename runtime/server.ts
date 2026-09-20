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
const LANGGRAPH_URL = process.env.LANGGRAPH_URL || "http://localhost:8800";

/**
 * 客户端中途断开（手机点「停止」/ 息屏 / 网络抖动）会让上游流中止，undici 抛
 * `TypeError: terminated`（cause: `UND_ERR_SOCKET` / "other side closed"）。
 * 这类错误是单个连接的正常生命周期事件，不该拖垮整个 runtime，只记录即可；
 * 其余未捕获异常仍按致命处理退出，避免带病运行。
 */
function isDisconnectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause as
    | { message?: string; code?: string }
    | undefined;
  const text = `${err.message} ${cause?.message ?? ""} ${cause?.code ?? ""}`;
  return /terminated|other side closed|UND_ERR_SOCKET|\baborted\b/i.test(text);
}

process.on("uncaughtException", (err) => {
  if (isDisconnectError(err)) {
    console.error("[runtime] 客户端断开导致的流中止（忽略）:", err.message);
    return;
  }
  console.error("[runtime] uncaughtException（致命）:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  if (isDisconnectError(err)) {
    console.error("[runtime] 断连导致的流中止（忽略）:", (err as Error)?.message);
    return;
  }
  console.error("[runtime] unhandledRejection（致命）:", err);
  process.exit(1);
});

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
