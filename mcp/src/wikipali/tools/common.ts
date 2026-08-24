/**
 * 工具注册的公共辅助（对应 CLI 的 emit/--json 行为）。
 *
 * 无状态：写/身份类工具需要的凭据，从 MCP 传输层的请求里取（HTTP Authorization 头），
 * 经 handler 的第二个参数 extra 透传，绝不作为工具参数、也绝不落盘。
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod/v4";

import { WpError } from "../errors.ts";

export interface JsonToolOpts {
  title?: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
}

export type JsonToolHandler = (args: any, extra: any) => Promise<unknown> | unknown;

export function registerJsonTool(
  server: McpServer,
  name: string,
  opts: JsonToolOpts,
  handler: JsonToolHandler,
): void {
  server.registerTool(
    name,
    {
      description: opts.description,
      inputSchema: opts.inputSchema,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
    },
    async (args: any, extra: any) => {
      const result = await handler(args, extra);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] };
    },
  );
}

/** 从请求头取指定值（大小写不敏感；HTTP 头会进 extra.requestInfo.headers）。 */
export function headerValue(extra: any, name: string): string | undefined {
  const headers = extra?.requestInfo?.headers;
  if (!headers) return undefined;
  const v = headers[name] ?? headers[name.toLowerCase()];
  return typeof v === "string" ? v : undefined;
}

/** 取 Authorization: Bearer <token>。 */
export function bearerToken(extra: any): string | undefined {
  const auth = headerValue(extra, "authorization");
  if (typeof auth !== "string" || !auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m?.[1];
}

/** 模型身份 token（写句子/术语/批注的署名审计）。来自 Authorization 头。 */
export function requireModelToken(extra: any): string {
  const token = bearerToken(extra);
  if (!token) {
    throw new WpError(
      "缺少凭据：请客户端在 HTTP 请求里带 Authorization: Bearer <modelToken>（模型身份，\n" +
        "写句子/术语/批注时 API 据此记录 editor_uid=模型，便于审计）。server 无状态、不落凭据。",
    );
  }
  return token;
}

/** 人类 userToken：优先 X-Wikipali-User-Token 头，回退到 Authorization（兼容只发一个 token 的管理型客户端）。 */
export function requireUserToken(extra: any): string {
  const x = headerValue(extra, "x-wikipali-user-token");
  if (x) return x;
  const auth = bearerToken(extra);
  if (auth) return auth;
  throw new WpError(
    "缺少凭据：请客户端在 HTTP 请求里带 X-Wikipali-User-Token: <userToken>（或 Authorization: Bearer <userToken>）。\n" +
      "server 用它做人类授权（列 channel / 建模型 / 签 access token）。server 无状态、不落凭据。",
  );
}

/** 写句子/术语专用：严格要 X-Wikipali-User-Token（不回退到 Authorization，避免误把 modelToken 当 userToken 用）。 */
export function requireUserTokenHeader(extra: any): string {
  const token = headerValue(extra, "x-wikipali-user-token");
  if (!token) {
    throw new WpError(
      "缺少 userToken：写句子/术语需要在 HTTP 请求里额外带 X-Wikipali-User-Token: <userToken>，\n" +
        "server 用它瞬时签发 channel access token（Authorization 里是 modelToken，负责署名审计）。",
    );
  }
  return token;
}
