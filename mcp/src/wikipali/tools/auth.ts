/**
 * 凭据与 token 管理工具（无状态）：ensure-model / revoke / channels / grant。
 *
 * 登录（sign-in）不在 MCP 内——由独立登录脚本（npm run login）取得 userToken，
 * 客户端在每次请求的 Authorization 头里带它；server 不落任何凭据。
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { makeClient } from "../client.ts";
import { fmtTs, mask, tokenExpiry } from "../creds.ts";
import * as write from "../api/write.ts";
import { registerJsonTool, requireUserToken } from "./common.ts";

export function registerAuthTools(server: McpServer): void {
  registerJsonTool(server, "wikipali_ensure_model", {
    title: "建立/更新 AI 模型身份",
    description:
      "幂等地建立模型记录并返回模型 uid（写操作的 model_uid 用它）。name 决定句子作者署名，不要冒用别的模型名。凭据来自 Authorization 头。",
    inputSchema: {
      name: z.string().optional().describe("模型标识，如 claude-opus-5（成为句子作者署名）"),
      model: z.string().optional().describe("底层模型 id"),
      url: z.string().optional().describe("模型服务地址"),
      description: z.string().optional(),
      privacy: z.enum(["private", "public"]).default("private"),
    },
  }, async (args, extra) => write.ensureModel(makeClient(), requireUserToken(extra), args));

  registerJsonTool(server, "wikipali_revoke", {
    title: "撤销模型全部 token",
    description: "撤销该模型已签出的全部 token。凭据来自 Authorization 头。",
    inputSchema: {
      uid: z.string().describe("模型 uid"),
    },
  }, async (args, extra) => write.revokeModel(makeClient(), requireUserToken(extra), args.uid));

  registerJsonTool(server, "wikipali_channels", {
    title: "列出可编辑 channel",
    description: "列出当前账号可编辑的 channel。写入句子/术语前先查这个。凭据来自 Authorization 头。",
    inputSchema: {
      search: z.string().optional().describe("按名字过滤"),
    },
  }, async (args, extra) => write.listChannels(makeClient(), requireUserToken(extra), args.search));

  registerJsonTool(server, "wikipali_grant", {
    title: "签发 channel access token（校验编辑权）",
    description:
      "用客户端 userToken 为某个 channel 签发 access token（瞬时，不落盘），用于校验编辑权与查看范围/到期。写句子/术语时 server 会自行瞬时签发，无需预存。",
    inputSchema: {
      channel: z.string().optional().describe("channel uid / 序号 / 名字片段"),
      book: z.number().int().nonnegative().default(0).describe("限定 book，0 表示不限"),
    },
  }, async (args, extra) => {
    const client = makeClient();
    const userToken = requireUserToken(extra);
    const { uid, name } = await write.resolveChannel(client, userToken, args.channel);
    const item = await write.grantAccessToken(client, userToken, uid, args.book);
    return {
      channel: { uid, name },
      scope: item.book === 0 ? "全部 book" : `book ${item.book}`,
      token: mask(item.token),
      expires: fmtTs(item.exp ?? tokenExpiry(item.token)),
      note: "该 access token 已随本次调用即弃；写句子/术语时 server 会自行瞬时签发。",
    };
  });
}
