/**
 * 远程 transport：Streamable HTTP（有状态，官方推荐）。
 *
 * 参考官方示例 src/examples/server/simpleStreamableHttp.ts，去掉了 OAuth / tasks。
 * 每个 MCP 会话对应一个 StreamableHTTPServerTransport，用 mcp-session-id 头关联。
 */
import { randomUUID } from "node:crypto";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Request, Response } from "express";

export interface StreamableHttpOptions {
  /** 端口，默认读取 env.PORT，再退化为 3000。 */
  port?: number;
  /** 绑定地址，默认读取 env.MCP_HOST，再退化为 127.0.0.1（仅本机）。远程部署设 0.0.0.0。 */
  host?: string;
  /** 允许的 Host 白名单（逗号分隔），远程部署时按需放开 DNS rebinding 防护。 */
  allowedHosts?: string[];
  /** 每个会话新建一个 McpServer（与 stdio 保持一致）。 */
  createServer: () => McpServer;
}

export async function runStreamableHttpServer(options: StreamableHttpOptions): Promise<void> {
  const { createServer } = options;
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? process.env.MCP_HOST ?? "127.0.0.1";
  const allowedHosts = options.allowedHosts ?? parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS);

  const app = createMcpExpressApp({ host, ...(allowedHosts.length ? { allowedHosts } : {}) });
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"];

    // 已有会话：复用 transport。
    if (typeof sessionId === "string" && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    // 新会话必须是 initialize 请求。
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: missing session id or not an initialize request",
        },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        transports.delete(sid);
      }
    };

    const server = createServer();
    // SDK 将 StreamableHTTPServerTransport 的 onclose 声明为 `(() => void) | undefined`，
    // 与 Transport 接口的 `onclose?: () => void` 在 exactOptionalPropertyTypes 下不兼容，
    // 这里显式断言以通过 connect() 的类型检查（不影响运行行为）。
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET：建立 / 复用 SSE 流（服务端主动推送）。
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  });

  // DELETE：结束会话。
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.listen(port, host, () => {
    console.log(`[mcp] Streamable HTTP server: http://${host}:${port}/mcp`);
  });
}

function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
