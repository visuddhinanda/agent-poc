/**
 * 入口：无状态 WikiPali MCP server（Streamable HTTP）。
 *
 * 三种场景（agent 工具 / plugin / LangGraph server）的客户端都只连这一个服务，
 * 凭据由客户端经 HTTP Authorization: Bearer <userToken> 提供，server 不落任何凭据。
 *
 *   npm run start            -> 启动（MCP_HOST/PORT/WIKIPALI_API_URL 由 env 控制）
 */
import dotenv from "dotenv";

import { createMcpServer } from "./server.ts";
import { runStreamableHttpServer } from "./transports/streamable-http.ts";

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  await runStreamableHttpServer({ createServer: createMcpServer });
}

main().catch((error) => {
  console.error("[mcp] fatal:", error);
  process.exit(1);
});
