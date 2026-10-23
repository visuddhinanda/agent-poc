/**
 * 写端 MCP 工具注册（无状态）。
 *
 * 凭据走 HTTP 头，不落 server、不进工具参数：
 *   - 管理/读（my_terms）：Authorization: Bearer <userToken>
 *   - 写句子/术语：Authorization: Bearer <modelToken>（署名审计）+ X-Wikipali-User-Token: <userToken>（签 access token）
 *   - 批注读（discuss / discuss_range）：Authorization: Bearer <modelToken>
 *   - 批注写（discuss_* / note_push）：Authorization: Bearer <modelToken> + X-Wikipali-User-Token: <userToken>
 *     （server 用 userToken 瞬时签 v3 agent-grant，写请求带 X-Agent-Grant；署名为授权人、模型记为协作者）
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { makeClient } from "../client.ts";
import * as write from "../api/write.ts";
import * as discuss from "../api/discuss.ts";
import * as notes from "../api/notes.ts";
import { optionalUserToken, registerJsonTool, requireModelToken, requireUserToken, requireUserTokenHeader } from "./common.ts";

const DISCUSS_WRITE_AUTH =
  " Authorization: Bearer <modelToken> + X-Wikipali-User-Token: <userToken>（server 用 userToken 为模型瞬时签发该句 channel + book 的写入授权）。";

function writeCreds(extra: any): discuss.WriteCreds {
  return { modelToken: requireModelToken(extra), userToken: requireUserTokenHeader(extra) };
}

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

  // --- 批注（discussion，v3） -------------------------------------------------
  const typeEnum = z.enum(discuss.DISCUSS_TYPES);
  const typeHelp =
    "note＝批注 / 脚注（正文即注解），commentary＝注释对照（正文为 {{book-para-start-end}}），discussion＝审稿意见 / 讨论，" +
    "qa＝问答，help＝求助，issue＝问题报告，glossary＝外挂术语（不改译文，给一段译文临时挂上术语；与术语表 term_add 是两回事），" +
    "assessment＝译文评估（打分）";
  const sentenceInput = {
    coord: z.string().optional().describe("book-paragraph；也可改用 sent 直接给句子 uid"),
    sent: z.string().optional().describe("句子 uid（wikipali_get 返回的 id），给了就不再按坐标解析"),
    channel: z.string().optional().describe("句子所在版本：uid；名字片段要带 X-Wikipali-User-Token。缺省巴利原文"),
    words: z.string().optional().describe("一段多句时指明是哪一句，如 2-17"),
  };
  const anchorInput = {
    quote_exact: z.string().optional().describe("被锚定文本的原样摘录（含标点）；只给它就行，位置与前后缀由程序按句子原文算"),
    quote_prefix: z.string().optional().describe("摘录前的上下文：摘录在句中出现多次时用来指明是哪一处"),
    quote_suffix: z.string().optional().describe("摘录后的上下文：同上"),
  };

  registerJsonTool(server, "wikipali_discuss", {
    title: "列出某句上的批注",
    description: "列出某一句上某一类的批注 / 话题及回复（v3）。Authorization: Bearer <modelToken>。",
    inputSchema: {
      ...sentenceInput,
      type: typeEnum.default("discussion").describe(`列哪一类：${typeHelp}`),
      status: z.enum(["active", "close"]).default("active"),
      limit: z.number().int().positive().max(200).default(50).describe("每页条数，最多 200"),
      page: z.number().int().positive().default(1),
    },
  }, async (args, extra) => discuss.discussList(makeClient(), requireModelToken(extra), args, optionalUserToken(extra)));

  registerJsonTool(server, "wikipali_discuss_range", {
    title: "列出一段经文里的批注",
    description:
      "列出一章（coord + chapter）/ 一段段落区间（coord + to）/ 一段（只给 coord）/ 一本书（book）/ 整个 channel 里挂在句子上的批注，按经文顺序、每条带句子坐标。Authorization: Bearer <modelToken>。",
    inputSchema: {
      channel: z.string().describe("批注挂在哪个版本的句子上：uid；名字片段要带 X-Wikipali-User-Token"),
      coord: z.string().optional().describe("book-paragraph"),
      chapter: z.boolean().default(false).describe("coord 是章节起始段，取整章"),
      to: z.number().int().nonnegative().optional().describe("段落区间的结束段（含）"),
      book: z.number().int().nonnegative().optional().describe("不给 coord 时取整本书；coord 与 book 都不给就是整个 channel"),
      type: z.string().optional().describe("类型，逗号多选，如 issue,glossary；不给只列话题（discussion / qa / help / issue / glossary），批注与评估要显式 note / commentary / assessment"),
      status: z.enum(["active", "close"]).optional().describe("不给则两种都列"),
      severity: z.string().optional().describe("严重程度，逗号多选，如 error,warning；assessment 时是评估方法，如 mqm"),
      limit: z.number().int().positive().max(200).default(50),
      page: z.number().int().positive().default(1),
      all: z.boolean().default(false).describe("自动翻页取完全部"),
    },
  }, async (args, extra) => discuss.discussRange(makeClient(), requireModelToken(extra), args, optionalUserToken(extra)));

  const discussAddInput = {
    ...sentenceInput,
    type: typeEnum.default("discussion").describe(`${typeHelp}。锚点只有 note / commentary / issue / glossary 收`),
    title: z.string().optional().describe("标题：discussion / qa / help / issue 必填；glossary 必填且填术语词头；note / commentary / assessment 可不给"),
    content: z.string().optional().describe("正文（markdown）；assessment 写打分理由，可不给"),
    severity: z.enum(discuss.SEVERITY_CHOICES as [string, ...string[]]).optional().describe("issue：error / warning / suggestion；help：urgent / normal"),
    score: z.number().int().min(0).max(100).optional().describe("评估分数，0–100 的整数（只限且必填于 assessment）"),
    method: z.string().optional().describe("评估方法（只限且必填于 assessment），1–16 位字母数字 . _ -，如 mqm、llm-judge"),
    ...anchorInput,
    notify: z.boolean().default(false).describe("发站内通知（批注与评估本来就不发）"),
  };
  registerJsonTool(server, "wikipali_discuss_add_preview", {
    title: "给某句加批注（预览）",
    description: "新建批注 / 话题 / 外挂术语 / 译文评估的预览（dry-run）：定位句子、按摘录算锚点并回显，不写入。" + DISCUSS_WRITE_AUTH,
    inputSchema: discussAddInput,
  }, async (args, extra) => discuss.discussAdd(makeClient(), writeCreds(extra), { ...args, dryRun: true }));

  registerJsonTool(server, "wikipali_discuss_add_commit", {
    title: "给某句加批注（提交）",
    description: "提交新建批注（署名为授权人、模型记为协作者；assessment 一句只留一条，再评估覆盖旧的）。写前先用 _preview 回显。" + DISCUSS_WRITE_AUTH,
    inputSchema: discussAddInput,
  }, async (args, extra) => discuss.discussAdd(makeClient(), writeCreds(extra), { ...args, dryRun: false }));

  const discussReplyInput = {
    id: z.string().describe("被回复的话题 id，用 wikipali_discuss 查（不能回复一条回复）"),
    content: z.string().describe("正文（markdown）"),
    notify: z.boolean().default(false),
  };
  registerJsonTool(server, "wikipali_discuss_reply_preview", {
    title: "回复批注（预览）",
    description: "回复话题的预览（dry-run）。" + DISCUSS_WRITE_AUTH,
    inputSchema: discussReplyInput,
  }, async (args, extra) => discuss.discussReply(makeClient(), writeCreds(extra), { ...args, dryRun: true }));

  registerJsonTool(server, "wikipali_discuss_reply_commit", {
    title: "回复批注（提交）",
    description: "提交回复话题。" + DISCUSS_WRITE_AUTH,
    inputSchema: discussReplyInput,
  }, async (args, extra) => discuss.discussReply(makeClient(), writeCreds(extra), { ...args, dryRun: false }));

  const discussEditInput = {
    id: z.string().describe("批注 id，用 wikipali_discuss 查"),
    title: z.string().optional(),
    content: z.string().optional().describe("新正文；不给则保留原文"),
    status: z.enum(["active", "close"]).optional(),
    severity: z.enum(discuss.SEVERITY_CHOICES as [string, ...string[]]).optional(),
    score: z.number().int().min(0).max(100).optional().describe("改评估分数（只限 assessment）"),
    method: z.string().optional().describe("改评估方法（只限 assessment）"),
    ...anchorInput,
    pos_start: z.number().int().nonnegative().nullable().optional().describe("一般不用给；null 表示清空锚点位置"),
    pos_end: z.number().int().nonnegative().nullable().optional().describe("一般不用给；null 表示清空锚点位置"),
  };
  registerJsonTool(server, "wikipali_discuss_edit_preview", {
    title: "修改批注（预览）",
    description: "修改批注 / 对应 / 评估的预览（dry-run）：只列出改了的字段。给新的 quote_exact 时按句子原文重新定位。" + DISCUSS_WRITE_AUTH,
    inputSchema: discussEditInput,
  }, async (args, extra) => discuss.discussEdit(makeClient(), writeCreds(extra), { ...args, dryRun: true }));

  registerJsonTool(server, "wikipali_discuss_edit_commit", {
    title: "修改批注（提交）",
    description: "提交修改（v3 PATCH，只发改了的字段）。" + DISCUSS_WRITE_AUTH,
    inputSchema: discussEditInput,
  }, async (args, extra) => discuss.discussEdit(makeClient(), writeCreds(extra), { ...args, dryRun: false }));

  const discussDeleteInput = { id: z.string().describe("批注 id") };
  registerJsonTool(server, "wikipali_discuss_delete_preview", {
    title: "删除批注（预览）",
    description: "删除批注 / 对应的预览（dry-run）。作者或该句 channel 的编辑者可删。" + DISCUSS_WRITE_AUTH,
    inputSchema: discussDeleteInput,
  }, async (args, extra) => discuss.discussDelete(makeClient(), writeCreds(extra), { ...args, dryRun: true }));

  registerJsonTool(server, "wikipali_discuss_delete_commit", {
    title: "删除批注（提交）",
    description: "提交删除（软删除；有回复的话题以「已删除」占位保留）。" + DISCUSS_WRITE_AUTH,
    inputSchema: discussDeleteInput,
  }, async (args, extra) => discuss.discussDelete(makeClient(), writeCreds(extra), { ...args, dryRun: false }));

  // --- 注释书对应（commentary-align） ------------------------------------------
  registerJsonTool(server, "wikipali_note_context", {
    title: "注释书对应的素材",
    description:
      "某 CST 锚点（book_name + cs_para）下根本 / 义注 / 复注各句的巴利原文与该 channel 的译文原始 content，供做注释对照。Authorization 不需要；channel 给名字时要 X-Wikipali-User-Token。",
    inputSchema: {
      book_name: z.string().describe("CST 书名，如 an6、dn1"),
      cs_para: z.number().int().nonnegative().describe("CST 段号"),
      channel: z.string().describe("译文所在的 channel（uid 或名字片段）"),
      layers: z.string().optional().describe("只取某几层，逗号分隔：mula,att,tika"),
    },
  }, async (args, extra) => notes.noteContext(makeClient(), args, optionalUserToken(extra)));

  const notePushInput = {
    items: z.array(z.object({
      target: z.string().describe("上一层一句译文的坐标 book-para-start-end"),
      note: z.union([z.string(), z.array(z.string())]).describe("下一层解释它的句子坐标；多句给数组（只能列单句，不能写区间）"),
      quote_exact: z.string().optional().describe("target 译文里被解释片段的原样摘录；不给＝整句挂（只用于段落引子）"),
      quote_prefix: z.string().optional(),
      quote_suffix: z.string().optional(),
    })).min(1).describe("对应列表，一条一个 {target, note, quote_exact}"),
    channel: z.string().describe("target 译文句子所在的 channel"),
    replace: z.boolean().default(false).describe("同一句已有同一条对应时删掉旧的重写（默认跳过）"),
  };
  registerJsonTool(server, "wikipali_note_push_preview", {
    title: "写入注释书对应（预览）",
    description: "按摘录在译文原始 content 里算位置、校验句子存在、去重，并报下一层未覆盖的句子；不写入。" + DISCUSS_WRITE_AUTH,
    inputSchema: notePushInput,
  }, async (args, extra) => notes.notePush(makeClient(), writeCreds(extra), { ...args, dryRun: true }));

  registerJsonTool(server, "wikipali_note_push_commit", {
    title: "写入注释书对应（提交）",
    description: "提交注释书对应（type=commentary）。有问题的条目跳过并在 problems 里列出。" + DISCUSS_WRITE_AUTH,
    inputSchema: notePushInput,
  }, async (args, extra) => notes.notePush(makeClient(), writeCreds(extra), { ...args, dryRun: false }));
}
