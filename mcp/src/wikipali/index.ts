/**
 * WikiPali MCP 工具装配入口：把读端 / 站点凭据 / 写端全部工具注册到 McpServer。
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerReadTools } from "./tools/read.ts";
import { registerSiteTools } from "./tools/site.ts";
import { registerAuthTools } from "./tools/auth.ts";
import { registerWriteTools } from "./tools/write.ts";

export function registerWikipaliTools(server: McpServer): void {
  registerReadTools(server);
  registerSiteTools(server);
  registerAuthTools(server);
  registerWriteTools(server);
}
