/**
 * 站点与身份工具（无状态）：endpoint（只读） / whoami（凭据来自 Authorization 头）。
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { makeClient } from "../client.ts";
import { SITES, expandSiteAlias, normalizeApiUrl, siteLabel } from "../sites.ts";
import * as write from "../api/write.ts";
import { registerJsonTool, requireUserToken } from "./common.ts";

export function registerSiteTools(server: McpServer): void {
  registerJsonTool(server, "wikipali_endpoint", {
    title: "查看 API 地址",
    description:
      "查看当前 WikiPali API 地址与可用站点。无状态 server：站点由服务端环境变量 WIKIPALI_API_URL 决定，本工具只读不切换。",
    inputSchema: {
      target: z.string().optional().describe("仅用于展开别名的展示，不写回任何状态"),
    },
  }, async (args) => {
    const current = makeClient().apiUrl;
    const sites = SITES.map((s, i) => ({
      index: i + 1,
      key: s.key,
      url: s.url,
      version: s.version,
      domain: s.domain,
      bucket: s.bucket,
      current: s.url === current,
    }));
    let resolved: string | undefined;
    if (args.target) resolved = normalizeApiUrl(expandSiteAlias(args.target));
    return {
      current,
      sites,
      note: "无状态 server：切换站点要改服务端环境变量 WIKIPALI_API_URL 并重启；线上四站共享数据库，staging/local 是独立库。",
      ...(resolved ? { resolvedAlias: resolved } : {}),
    };
  });

  registerJsonTool(server, "wikipali_whoami", {
    title: "当前身份",
    description: "用客户端提供的 userToken（Authorization 头）向服务端校验当前用户，返回身份与 token 到期时间。",
    inputSchema: {
      check: z.boolean().default(false).describe("保留参数，实际始终会向服务端校验"),
    },
  }, async (_args, extra) => {
    const userToken = requireUserToken(extra);
    return write.whoami(makeClient(), userToken);
  });
}
