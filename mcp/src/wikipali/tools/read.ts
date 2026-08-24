/**
 * 读端 MCP 工具注册（17 项 Library 能力，全部无需登录）。
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { makeClient } from "../client.ts";
import { parseCoord } from "../coords.ts";
import * as read from "../api/read.ts";
import { registerJsonTool } from "./common.ts";

export function registerReadTools(server: McpServer): void {
  registerJsonTool(server, "wikipali_forms", {
    title: "词形展开",
    description:
      "展开词形：给词根或任意变格形，返回候选词典原型及该词根在语料中实际出现过的全部变格形（含频次与黑体数）。一切检索的前置——语料索引的是变格形，不是词典形。",
    inputSchema: {
      word: z.string().describe("词根或任意变格形，如 parivāsa"),
      limit: z.number().int().positive().default(3).describe("显示几个候选词根"),
    },
  }, async (args) => {
    const client = makeClient();
    const rows = await read.fetchForms(client, args.word);
    if (!rows.length) throw new Error(`「${args.word}」在语料里找不到任何词形。检查拼写（变音符号是否正确），或换一个词根。`);
    const shown = rows.slice(0, args.limit).map((r, idx) => ({
      index: idx + 1,
      word: r.word,
      forms: (r.case ?? []).length,
      total: (r.case ?? []).reduce((s: number, f: any) => s + (Number(f.count) || 0), 0),
      bold: (r.case ?? []).reduce((s: number, f: any) => s + (Number(f.bold) || 0), 0),
      cases: [...(r.case ?? [])].sort((a: any, b: any) => (Number(b.count) || 0) - (Number(a.count) || 0))
        .map((f: any) => ({ word: f.word, count: f.count, bold: f.bold })),
    }));
    return {
      rows: shown,
      searchKey: read.formsArg(rows[0]!),
      notes: ["检索用第一候选的全部词形（searchKey）。若目标概念有名词与动词两条线，两条都要展开。"],
    };
  });

  registerJsonTool(server, "wikipali_word", {
    title: "词典释义与形态分析",
    description: "查词典：释义与形态分析（形→根），用来确认词根选对了。",
    inputSchema: {
      word: z.string().describe("词"),
      lang: z.string().default("zh").describe("释义语言"),
      limit: z.number().int().positive().default(3).describe("最多显示几个词条"),
      dicts: z.number().int().positive().default(3).describe("每个词条显示几部词典"),
    },
  }, async (args) => read.wordLookup(makeClient(), args));

  registerJsonTool(server, "wikipali_count", {
    title: "词频合计",
    description: "词频合计：给一个或多个词/词根，返回各自的词次与黑体数（数的是词次，不是段落数）。",
    inputSchema: {
      words: z.array(z.string()).min(1).describe("一个或多个词/词根"),
    },
  }, async (args) => read.count(makeClient(), args));

  registerJsonTool(server, "wikipali_terms", {
    title: "术语表（社区权威译名）",
    description: "查社区权威译名对照表（17074 条，本地缓存后过滤）。写译文或论文时的用词应与它一致。",
    inputSchema: {
      keyword: z.string().optional().describe("按巴利词形过滤；省略则列全表（建议给 keyword）"),
      lang: z.string().default("zh-Hans"),
      view: z.string().default("community"),
      limit: z.number().int().positive().default(30),
      refresh: z.boolean().default(false).describe("强制重新拉取全表"),
    },
  }, async (args) => read.terms(makeClient(), args));

  registerJsonTool(server, "wikipali_books", {
    title: "分类目录（按 tag 找书）",
    description: "分类目录：按 tag 找书（mūla 本文 / aṭṭhakathā 义注 / ṭīkā 复注 / 各部尼柯耶等），或列出全部 tag。",
    inputSchema: {
      keyword: z.string().optional().describe("按书名/toc 过滤"),
      tags: z.string().optional().describe("按 tag 筛，逗号分隔是「且」，如 dīghanikāya,ṭīkā"),
      tag_list: z.boolean().default(false).describe("列出全部 tag 及各自书数"),
      show_tags: z.boolean().default(false).describe("每本书都列出它的 tag"),
      limit: z.number().int().positive().default(40),
      refresh: z.boolean().default(false).describe("强制重新拉取书目清单"),
    },
  }, async (args) => read.books(makeClient(), args));

  registerJsonTool(server, "wikipali_toc", {
    title: "章节目录",
    description: "章节目录：给 book:paragraph 任意段号，返回所属丛书的目录（默认过滤到当前这本书）。",
    inputSchema: {
      coord: z.string().describe("book:paragraph，如 216:512"),
      depth: z.number().int().positive().default(4).describe("最多显示到第几层"),
      all: z.boolean().default(false).describe("显示整套丛书而不只当前这本"),
    },
  }, async (args) => read.toc(makeClient(), args));

  registerJsonTool(server, "wikipali_paras", {
    title: "段落清单（不取正文）",
    description: "章节内全部段落的清单：标题层级 + 每段字符数，不取正文。用于规划分批读取或翻译/校对工作量。",
    inputSchema: {
      coord: z.string().describe("book:paragraph，正文段也行，会自动向上找章节"),
      body: z.boolean().default(false).describe("连每个正文段的字符数一起列出"),
      depth: z.number().int().positive().default(9).describe("最多显示到第几层标题"),
      here: z.boolean().default(false).describe("给正文段时不向上找章节，只报这一段"),
    },
  }, async (args) => read.paras(makeClient(), args));

  registerJsonTool(server, "wikipali_chapter", {
    title: "章节体量与导航（只报体量）",
    description: "章节体量与导航：范围、段数、字符数、上一章/下一章、路径。只报体量，不取正文。",
    inputSchema: {
      coord: z.string().describe("book:paragraph，正文段也行，会自动向上找章节"),
    },
  }, async (args) => read.chapterMeta(makeClient(), args));

  registerJsonTool(server, "wikipali_chapter_fetch", {
    title: "整章取文",
    description: "取整章内容（先看 wikipali_chapter 报的体量再决定是否取）。缺省取巴利原文；给 channel 则取该版本（一次一个）。",
    inputSchema: {
      coord: z.string().describe("book:paragraph，正文段也行，会自动向上找章节"),
      channel: z.string().optional().describe("channel uid；缺省取巴利原文"),
      via: z.enum(["tipitaka-content", "chapter-content"]).default("tipitaka-content").describe("取文端点：默认 tipitaka-content；chapter-content 返回逐句多版本结构"),
      text: z.boolean().default(true).describe("输出纯文本（黑体转 **），false 保留 HTML"),
    },
  }, async (args) => {
    const client = makeClient();
    const [book, para] = parseCoord(args.coord);
    if (args.via === "chapter-content") {
      const res = await read.chapterContent(client, book, para, args.channel ? [args.channel] : [], args.text);
      return { ...res, notes: ["句子 id 就是引用坐标（book-para-wordStart-wordEnd）。"] };
    }
    const rows = await read.tipitakaContent(client, book, para, args.channel, args.text);
    return {
      rows,
      notes: [
        rows.length ? "" : "该版本在本章没有句子内容。",
        "句子 id 就是引用坐标（book-para-wordStart-wordEnd）；<code> 页码（M/V/P/T）已保留在文本里。",
      ].filter(Boolean),
    };
  });

  registerJsonTool(server, "wikipali_get", {
    title: "按坐标取文",
    description: "按坐标取原文/译文：book:paragraph + channel。缺省取巴利原文。",
    inputSchema: {
      coords: z.array(z.string()).min(1).describe("坐标数组，如 ['216:35', '216:36']"),
      channels: z.array(z.string()).optional().describe("channel uid，可多个；缺省取巴利原文"),
      limit: z.number().int().positive().default(200).describe("每次请求最多取几句"),
    },
  }, async (args) => read.getSentences(makeClient(), args));

  registerJsonTool(server, "wikipali_versions", {
    title: "某坐标有哪些译本",
    description: "某坐标有哪些译本/版本，以及缺哪些语言。",
    inputSchema: {
      coord: z.string().describe("book:paragraph"),
    },
  }, async (args) => read.versions(makeClient(), args));

  registerJsonTool(server, "wikipali_search", {
    title: "按词形检索段落",
    description: "按词形检索段落（黑体加权排序）。检索前必须先展开词形（wikipali_forms 或给 lemma）。",
    inputSchema: {
      forms: z.array(z.string()).default([]).describe("逗号或空格分隔的词形；或用 lemma 自动展开"),
      lemma: z.string().optional().describe("给词根，自动先展开成全部词形再检索"),
      bold: z.boolean().default(false).describe("只要黑体命中（注释书标出的词条）"),
      book: z.string().optional().describe("限定书（用 wikipali_dist 输出里的 book 值）"),
      tags: z.string().optional().describe("限定范围，如 vinaya 或 vinaya,mūla;vinaya,aṭṭhakathā"),
      limit: z.number().int().positive().default(50),
      offset: z.number().int().nonnegative().default(0),
      width: z.number().int().positive().default(200).describe("每条摘要字符数"),
    },
  }, async (args) => read.search(makeClient(), args));

  registerJsonTool(server, "wikipali_dist", {
    title: "出处分布",
    description: "出处分布：命中散布在哪些书、各多少、什么层次（本文/义注/复注）。数的是词次，不是段落数。",
    inputSchema: {
      forms: z.array(z.string()).default([]).describe("词形；或用 lemma 自动展开"),
      lemma: z.string().optional(),
      tags: z.string().optional(),
      limit: z.number().int().positive().default(25).describe("最多列几部书"),
    },
  }, async (args) => read.dist(makeClient(), args));

  registerJsonTool(server, "wikipali_related", {
    title: "本文↔义注↔复注段落对应",
    description: "本文 ↔ 义注 ↔ 复注的段落对应（CST 锚点）。找注释的正确方式，不要回头去注释书里搜关键词。",
    inputSchema: {
      coord: z.string().describe("book:paragraph"),
    },
  }, async (args) => read.related(makeClient(), args));

  registerJsonTool(server, "wikipali_articles", {
    title: "文章列表/搜索",
    description: "列出/搜索平台上的二手研究文章。",
    inputSchema: {
      keyword: z.string().optional().describe("标题关键词"),
      lang: z.string().optional(),
      view: z.string().default("public"),
      limit: z.number().int().positive().default(20),
      offset: z.number().int().nonnegative().default(0),
    },
  }, async (args) => read.articles(makeClient(), args));

  registerJsonTool(server, "wikipali_article", {
    title: "读文章全文",
    description: "读一篇二手研究文章的全文。引用它的观点要标明作者。",
    inputSchema: {
      uid: z.string().describe("文章 uid"),
      chars: z.number().int().nonnegative().default(4000).describe("最多输出多少字符，0 为不截断"),
    },
  }, async (args) => read.article(makeClient(), args));

  registerJsonTool(server, "wikipali_anthology", {
    title: "文集",
    description: "文集：不给 uid 列表，给 uid 看目录。",
    inputSchema: {
      uid: z.string().optional(),
      view: z.string().default("public"),
      limit: z.number().int().positive().default(30),
      offset: z.number().int().nonnegative().default(0),
    },
  }, async (args) => read.anthology(makeClient(), args));
}
