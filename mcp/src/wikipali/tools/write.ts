/**
 * 写端 MCP 工具注册（无状态）。
 *
 * 凭据走 HTTP 头，不落 server、不进工具参数：
 *   - 管理/读（my_terms）：Authorization: Bearer <userToken>
 *   - 写句子/术语：Authorization: Bearer <modelToken>（署名审计）+ X-Wikipali-User-Token: <userToken>（签 access token）
 *   - 批注（discussion）：Authorization: Bearer <modelToken>（不需要 access token）
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { makeClient } from "../client.ts";
import * as write from "../api/write.ts";
import { registerJsonTool, requireModelToken, requireUserToken, requireUserTokenHeader } from "./common.ts";

const sentenceSchema = z.object({
  book_id: z.number().int().describe("book id"),
  paragraph: z.number().int().describe("段号"),
  word_start: z.number().int().describe("句起始词下标"),
  word_end: z.number().int().describe("句结束词下标"),
  content: z.string().describe("译文内容"),
  content_type: z.string().optional().describe("默认 markdown"),
  channel_uid: z.string().optional().describe("目标 channel uid（整批共用时可省略，改由 channel 参数指定）"),
});

const writeInput = {
  sentences: z.array(sentenceSchema).min(1).describe("要写入的句子数组"),
  channel: z.string().optional().describe("目标 channel（uid / 序号 / 名字片段）"),
  book: z.number().int().optional().describe("access token 的 book 范围，缺省按句子推断"),
  batch: z.number().int().positive().default(50).describe("每批条数"),
  content_type: z.string().default("markdown"),
};

export function registerWriteTools(server: McpServer): void {
  // --- 自己的术语表（只读，凭据来自 Authorization 头 = userToken） ------------
  registerJsonTool(server, "wikipali_my_terms", {
    title: "自己的术语表",
    description: "列出自己 studio / channel 名下的术语。Authorization: Bearer <userToken>。",
    inputSchema: {
      channel: z.string().optional(),
      studio: z.string().optional(),
      keyword: z.string().optional(),
      tag: z.string().optional(),
      order: z.string().default("updated_at"),
      dir: z.enum(["asc", "desc"]).default("desc"),
      limit: z.number().int().positive().default(50),
      offset: z.number().int().nonnegative().default(0),
    },
  }, async (args, extra) => write.myTerms(makeClient(), requireUserToken(extra), args));

  // --- 写入句子 ------------------------------------------------------------
  registerJsonTool(server, "wikipali_write_preview", {
    title: "写入句子（预览）",
    description: "写入句子的预览（dry-run）：回显目标 channel、book、句子清单与覆盖警告，不发任何请求。Authorization: Bearer <modelToken> + X-Wikipali-User-Token: <userToken>。",
    inputSchema: writeInput,
  }, async (args, extra) => write.writeSentences(makeClient(), requireModelToken(extra), requireUserTokenHeader(extra), { ...args, dryRun: true }));

  registerJsonTool(server, "wikipali_write_commit", {
    title: "写入句子（提交）",
    description: "提交写入句子（覆盖式，按 batch 分批并核对 count 差集）。写前请先用 wikipali_write_preview 回显。Authorization: Bearer <modelToken> + X-Wikipali-User-Token: <userToken>。",
    inputSchema: writeInput,
  }, async (args, extra) => write.writeSentences(makeClient(), requireModelToken(extra), requireUserTokenHeader(extra), { ...args, dryRun: false }));

  // --- 术语 ----------------------------------------------------------------
  const termAddInput = {
    word: z.string().describe("巴利词"),
    meaning: z.string().describe("译名"),
    channel: z.string().optional().describe("目标 channel（uid / 序号 / 名字片段）"),
    other_meaning: z.string().optional(),
    note: z.string().optional(),
    tag: z.string().optional(),
    language: z.string().optional(),
  };
  registerJsonTool(server, "wikipali_term_add_preview", {
    title: "新建术语（预览）",
    description: "新建术语的预览（dry-run）。AI 写术语必须落在某个 channel。Authorization: Bearer <modelToken> + X-Wikipali-User-Token: <userToken>。",
    inputSchema: termAddInput,
  }, async (args, extra) => write.termAdd(makeClient(), requireModelToken(extra), requireUserTokenHeader(extra), { ...args, dryRun: true }));

  registerJsonTool(server, "wikipali_term_add_commit", {
    title: "新建术语（提交）",
    description: "提交新建术语（同 channel 下 word+tag 已存在时服务端会拒绝而不是覆盖）。Authorization: Bearer <modelToken> + X-Wikipali-User-Token: <userToken>。",
    inputSchema: termAddInput,
  }, async (args, extra) => write.termAdd(makeClient(), requireModelToken(extra), requireUserTokenHeader(extra), { ...args, dryRun: false }));

  const termEditInput = {
    guid: z.string().describe("术语 guid，用 wikipali_my_terms 查"),
    word: z.string().optional(),
    meaning: z.string().optional(),
    other_meaning: z.string().optional(),
    note: z.string().optional(),
    tag: z.string().optional(),
    language: z.string().optional(),
  };
  registerJsonTool(server, "wikipali_term_edit_preview", {
    title: "修改术语（预览）",
    description: "修改术语的预览（dry-run）：回显字段新旧值。只能改 channel 内的术语。Authorization: Bearer <modelToken> + X-Wikipali-User-Token: <userToken>。",
    inputSchema: termEditInput,
  }, async (args, extra) => write.termEdit(makeClient(), requireModelToken(extra), requireUserTokenHeader(extra), { ...args, dryRun: true }));

  registerJsonTool(server, "wikipali_term_edit_commit", {
    title: "修改术语（提交）",
    description: "提交修改术语（增量更新）。Authorization: Bearer <modelToken> + X-Wikipali-User-Token: <userToken>。",
    inputSchema: termEditInput,
  }, async (args, extra) => write.termEdit(makeClient(), requireModelToken(extra), requireUserTokenHeader(extra), { ...args, dryRun: false }));

  // --- 批注（discussion） ----------------------------------------------------
  registerJsonTool(server, "wikipali_discuss", {
    title: "列出某句上的批注",
    description: "列出某一句上的批注及回复。挂点用坐标或直接给句子 uid。Authorization: Bearer <modelToken>。",
    inputSchema: {
      coord: z.string().optional(),
      sent: z.string().optional(),
      channel: z.string().optional().describe("channel uid；缺省巴利原文（不给名字，避免需要 userToken）"),
      words: z.string().optional(),
      status: z.enum(["active", "close"]).default("active"),
      limit: z.number().int().positive().default(50),
      offset: z.number().int().nonnegative().default(0),
    },
  }, async (args, extra) => write.discussList(makeClient(), requireModelToken(extra), args));

  const discussAddInput = {
    coord: z.string().optional(),
    sent: z.string().optional(),
    channel: z.string().optional().describe("channel uid；缺省巴利原文"),
    words: z.string().optional(),
    title: z.string().describe("标题（服务端必填）"),
    content: z.string().optional(),
    content_type: z.string().default("markdown"),
    notify: z.boolean().default(false),
  };
  registerJsonTool(server, "wikipali_discuss_add_preview", {
    title: "给某句加批注（预览）",
    description: "新建批注的预览（dry-run）：回显挂点、标题、正文。Authorization: Bearer <modelToken>。",
    inputSchema: discussAddInput,
  }, async (args, extra) => write.discussAdd(makeClient(), requireModelToken(extra), { ...args, dryRun: true }));

  registerJsonTool(server, "wikipali_discuss_add_commit", {
    title: "给某句加批注（提交）",
    description: "提交新建批注（不需要 access token，署名是模型身份）。Authorization: Bearer <modelToken>。",
    inputSchema: discussAddInput,
  }, async (args, extra) => write.discussAdd(makeClient(), requireModelToken(extra), { ...args, dryRun: false }));

  const discussReplyInput = {
    id: z.string().describe("被回复的批注 id，用 wikipali_discuss 查"),
    content: z.string().optional(),
    content_type: z.string().default("markdown"),
    notify: z.boolean().default(false),
  };
  registerJsonTool(server, "wikipali_discuss_reply_preview", {
    title: "回复批注（预览）",
    description: "回复批注的预览（dry-run）。Authorization: Bearer <modelToken>。",
    inputSchema: discussReplyInput,
  }, async (args, extra) => write.discussReply(makeClient(), requireModelToken(extra), { ...args, dryRun: true }));

  registerJsonTool(server, "wikipali_discuss_reply_commit", {
    title: "回复批注（提交）",
    description: "提交回复批注。Authorization: Bearer <modelToken>。",
    inputSchema: discussReplyInput,
  }, async (args, extra) => write.discussReply(makeClient(), requireModelToken(extra), { ...args, dryRun: false }));
}
