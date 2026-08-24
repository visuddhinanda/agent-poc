/**
 * MCP Server 工厂：注册 WikiPali 的全部能力（读 / 站点凭据 / 写）。
 *
 * 最小脚手架的核心结构：
 *   new McpServer({ name, version })
 *     -> registerTool / registerResource / registerPrompt（Zod 校验入参）
 *     -> new Transport(...)
 *     -> server.connect(transport)
 *
 * transport 在 src/transports/ 里（stdio 本地 / Streamable HTTP 远程）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerWikipaliTools } from "./wikipali/index.ts";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "agent-poc-mcp",
      version: "0.2.0",
    },
    { capabilities: { logging: {} } },
  );

  registerWikipaliTools(server);

  return server;
}
