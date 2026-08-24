/**
 * 读端 API 封装（对应 lib/cmd_read.py）。全部只读，无需凭据。
 *
 * 每个函数返回「已处理」的结果（与 CLI 的 --json 输出同源），并把 CLI 人类输出里的
 * 关键提示并入 `notes` 数组，让 MCP 调用方也能看到那些学术/语义上的红线。
 */

import { ApiError, WpError, explainApiError } from "../errors.ts";
import type { WikiClient } from "../client.ts";
import { READ_TIMEOUT } from "../client.ts";
import { fmtCoord, fmtPath, parseCoord, parseCoords, textLayer } from "../coords.ts";
import { PALI_CHANNEL, looksMachine, snippet, stripMarkup } from "../markup.ts";

type Row = Record<string, any>;

async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (exc) {
    if (exc instanceof ApiError) throw explainApiError(exc, what);
    throw exc;
  }
}

function rowsOf(data: unknown): Row[] {
  return (data as Row)?.rows ?? [];
}

// ---------------------------------------------------------------------------
// 词形展开 / 词典 / 词频
// ---------------------------------------------------------------------------

export async function fetchForms(client: WikiClient, word: string): Promise<Row[]> {
  const rows = await guarded(`展开词形 ${word}`, async () => {
    const data = await client.call("GET", `v2/case/${word}`, { timeout: READ_TIMEOUT });
    return rowsOf(data);
  });
  // 0 个词形的候选等同于没找到：服务端对查无此词会返回 case 为空的行，必须滤掉
  // （注意：JS 里空数组是 truthy，必须显式判长度，不能只判 truthiness）
  return rows.filter((r) => Array.isArray(r.case) && r.case.length > 0);
}

export function formsArg(row: Row): string {
  return ((row.case ?? []) as Row[]).map((f) => f.word).filter((w) => typeof w === "string").join(",");
}

export async function wordLookup(
  client: WikiClient,
  args: { word: string; lang: string; limit: number; dicts: number },
): Promise<Row> {
  const groups = await guarded(`查词典 ${args.word}`, async () => {
    const data = await client.call("GET", "v2/dict", {
      query: { word: args.word, lang: args.lang },
      timeout: READ_TIMEOUT,
    });
    return (data as Row)?.words ?? [];
  });
  if (!groups.length) throw new WpError(`词典里没有「${args.word}」。`);
  return { words: groups, notes: ["释义在 note 字段；case/grammar 的方向是 形→根，用来确认词根选对。"] };
}

// ---------------------------------------------------------------------------
// 检索 / 出处分布
// ---------------------------------------------------------------------------

export async function resolveKey(client: WikiClient, args: { lemma?: string; forms: string[] }): Promise<string> {
  if (args.lemma) {
    const rows = await fetchForms(client, args.lemma);
    if (!rows.length) throw new WpError(`「${args.lemma}」展不出任何词形。`);
    const key = formsArg(rows[0]!);
    if (!key) throw new WpError(`「${args.lemma}」展不出任何词形，无法检索。`);
    return key;
  }
  const key = args.forms
    .flatMap((item) => String(item).split(","))
    .map((p) => p.trim())
    .filter(Boolean)
    .join(",");
  if (!key) {
    throw new WpError("没有给出词形。用 --lemma 风格的 lemma 字段自动展开，或直接给逗号分隔的词形。");
  }
  return key;
}

export async function search(
  client: WikiClient,
  args: { lemma?: string; forms: string[]; bold?: boolean; book?: string; tags?: string; limit: number; offset: number; width: number },
): Promise<Row> {
  const key = await resolveKey(client, args);
  const query: Record<string, string | number> = { key, limit: args.limit, offset: args.offset };
  if (args.bold) query.bold = "on";
  if (args.book) query.book = args.book;
  if (args.tags) query.tags = args.tags;
  const data = await guarded("检索", async () =>
    client.call("GET", "v2/search-pali-wbw", { query, timeout: READ_TIMEOUT }),
  );
  const rows = rowsOf(data);
  const count = (data as Row)?.count ?? 0;
  
  const out = rows.map((r) => {
    const coord=fmtCoord(r.book, r.paragraph);
    return {
    book: r.book,
    paragraph: r.paragraph,
    coord: coord,
    ref:coord,
    link:`https://next.wikipali.org/library/tipitaka/${coord}/read?channel=translation`,
    path: fmtPath(r.path),
    rank: r.rank,
    highlight: snippet(stripMarkup(r.highlight), args.width, "【"),
  }
  });
  return {
    count,
    offset: args.offset,
    rows: out,
    notes: [
      `命中 ${count} 段（这里是段落数，不是词次数）。`,
      "引用时用坐标 book-paragraph；取原文用 wikipali_get。",
      "检索前必须先展开词形（wikipali_forms 或给 lemma）——直接拿词典形会 0 条且不报错。",
    ],
  };
}

export async function dist(
  client: WikiClient,
  args: { lemma?: string; forms: string[]; tags?: string; limit: number },
): Promise<Row> {
  const key = await resolveKey(client, args);
  const query: Record<string, string> = { key };
  if (args.tags) query.tags = args.tags;
  const data = await guarded("统计出处分布", async () =>
    client.call("GET", "v2/search-pali-wbw-books", { query, timeout: READ_TIMEOUT }),
  );
  const rows = rowsOf(data);
  const total = rows.reduce((s, r) => s + (Number(r.count) || 0), 0);
  const byLayer: Record<string, number> = {};
  const out = [...rows]
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .slice(0, args.limit)
    .map((r) => {
      const layer = textLayer(r.tags);
      byLayer[layer] = (byLayer[layer] ?? 0) + (Number(r.count) || 0);
      return {
        count: r.count,
        paliTitle: r.paliTitle,
        book: r.pcdBookId,
        tags: (r.tags ?? []).map((t: Row) => t.name).filter(Boolean),
        layer,
      };
    });
  return {
    books: rows.length,
    totalHits: total,
    rows: out,
    byLayer,
    notes: [
      `${rows.length} 部书，共 ${total} 次词命中——这里数的是词次，不是段落数（段落数看 wikipali_search 的 count）。`,
      "引用时必须标明层次（mūla 本文 / aṭṭhakathā 义注 / ṭīkā 复注）——把义注的解释当成本文的说法是学术错误。",
    ],
  };
}

// ---------------------------------------------------------------------------
// 取文（get / chapter / paras / toc）
// ---------------------------------------------------------------------------

export async function getSentences(
  client: WikiClient,
  args: { coords: string[]; channels?: string[]; limit: number },
): Promise<Row> {
  const grouped = parseCoords(args.coords);
  const channels = (args.channels ?? []).length ? args.channels!.join(",") : PALI_CHANNEL;
  const collected: Row[] = [];
  for (const [book, paras] of Object.entries(grouped)) {
    const data = await guarded(`取 ${book} 的段落`, async () =>
      client.call("GET", "v2/sentence", {
        query: { view: "paragraph", book, para: paras.map(String).join(","), channels, limit: args.limit },
        timeout: READ_TIMEOUT,
      }),
    );
    collected.push(...rowsOf(data));
  }
  if (!collected.length) {
    return {
      rows: [],
      notes: [
        "这些坐标在指定 channel 下没有内容。这是「该 channel 在此处没有文本」，不是查询失败——如实报告，不要拿相邻段落或别的译本凑。",
      ],
    };
  }
  const out = collected.map((r) => {
    const ch = r.channel ?? {};
    const editor = r.editor ?? {};
    return {
      book: r.book,
      paragraph: r.paragraph,
      coord: fmtCoord(r.book, r.paragraph),
      channel: { uid: ch.uid, name: ch.name, lang: ch.lang },
      author: editor.nickName || editor.name || "",
      word_start: r.word_start,
      word_end: r.word_end,
      text: stripMarkup(r.content),
    };
  });
  return { rows: out, count: out.length, notes: ["共 " + out.length + " 句。"] };
}

export async function toc(
  client: WikiClient,
  args: { coord: string; depth: number; all: boolean },
): Promise<Row> {
  const [book, para] = parseCoord(args.coord);
  const data = await guarded(`取 ${book}:${para} 的章节目录`, async () =>
    client.call("GET", "v2/palitext", { query: { view: "book-toc", book: String(book), para: String(para) }, timeout: READ_TIMEOUT }),
  );
  const rows = rowsOf(data);
  const shown = args.all ? rows : rows.filter((r) => r.book === book);
  const out = shown
    .filter((r) => (Number(r.level) || 1) <= args.depth)
    .map((r) => ({ coord: `${r.book}:${r.paragraph}`, level: r.level, toc: r.toc }));
  return {
    total: rows.length,
    rows: out,
    notes: args.all ? [] : [`返回整套丛书目录共 ${rows.length} 条，已过滤到 book ${book}（all=true 看整套）。`],
  };
}

const HEADING_LEVEL = 8;

async function fetchParagraphsInfo(client: WikiClient, book: number, para: number): Promise<Row[]> {
  return guarded(`取 ${book}:${para} 的段落清单`, async () => {
    try {
      const data = await client.call("GET", "v2/para-info", {
        query: { book: String(book), para: String(para) },
        timeout: READ_TIMEOUT,
      });
      return rowsOf(data);
    } catch (exc) {
      if (exc instanceof ApiError && exc.status === 404) {
        return guarded("取段落清单（旧接口）", async () =>
          rowsOf(await client.call("GET", "v2/palitext", {
            query: { view: "paragraphs-info", book: String(book), para: String(para) },
            timeout: READ_TIMEOUT,
          })),
        );
      }
      if (exc instanceof ApiError && exc.status === 400 && String(exc).includes("paragraph")) {
        throw new WpError(`${book}:${para} 这个坐标不存在（服务端：${exc.message}）。`);
      }
      throw exc;
    }
  });
}

function rowLen(row: Row): number {
  return Number(row.length ?? row.lenght ?? 0) || 0;
}

export async function paras(
  client: WikiClient,
  args: { coord: string; body: boolean; depth: number; here: boolean },
): Promise<Row> {
  const [book, para] = parseCoord(args.coord);
  let rows = await fetchParagraphsInfo(client, book, para);
  let climbed: number | undefined;

  if (rows.length <= 1 && !args.here) {
    const meta = await resolveChapter(client, book, para);
    const start = meta?.meta?.paragraph != null ? Number(meta.meta.paragraph) : undefined;
    if (start != null && start !== para) {
      rows = await fetchParagraphsInfo(client, book, start);
      climbed = start;
    }
  }
  if (!rows.length) throw new WpError(`${book}:${para} 没有段落信息。`);

  const isHead = rows.map((r) => (Number(r.level) || 100) < HEADING_LEVEL);
  const charSum = [0];
  const bodyCnt = [0];
  for (let i = 0; i < rows.length; i++) {
    charSum.push(charSum[i]! + rowLen(rows[i]!));
    bodyCnt.push(bodyCnt[i]! + (isHead[i] ? 0 : 1));
  }
  const levels = [...new Set(rows.map((r, i) => (isHead[i] ? Number(r.level) : null)).filter((x): x is number => x != null))].sort();
  const depthOf = new Map(levels.map((lv, n) => [lv, n]));

  const out: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const p = Number(r.paragraph);
    if (!isHead[i]) {
      if (args.body || !levels.length) {
        out.push({ coord: `${book}:${p}`, level: null, toc: "", length: rowLen(r), body: true });
      }
      continue;
    }
    const depth = depthOf.get(Number(r.level)) ?? 0;
    if (depth + 1 > args.depth) continue;
    const span = Math.min(i + (Number(r.chapter_len) || 1), rows.length);
    out.push({
      coord: `${book}:${p}`,
      level: r.level,
      toc: r.toc,
      length: rowLen(r),
      headingParagraphs: bodyCnt[span]! - bodyCnt[i]!,
      headingChars: charSum[span]! - charSum[i]!,
    });
  }

  return {
    book,
    start: Number(rows[0]!.paragraph),
    end: Number(rows[rows.length - 1]!.paragraph),
    total: rows.length,
    headings: rows.length - bodyCnt[bodyCnt.length - 1]!,
    totalChars: charSum[charSum.length - 1]!,
    climbed,
    rows: out,
    notes: [
      "字符数是巴利原文的长度（含标题自身），不含译文。",
      "这个端点只报体量与分布，不取正文。取整章用 wikipali_chapter_fetch，取单段用 wikipali_get。",
    ],
  };
}

// ---------------------------------------------------------------------------
// 章节元信息与整章取文
// ---------------------------------------------------------------------------

export interface ChapterMeta {
  meta: Row;
  hops: number;
}

export async function fetchMeta(client: WikiClient, book: number, para: number): Promise<Row> {
  return guarded(`取 ${book}:${para} 的段落元信息`, async () => {
    const data = await client.call("GET", `v2/palitext/${book}-${para}`, { timeout: READ_TIMEOUT });
    return data as Row;
  });
}

function parsePath(raw: unknown): Row[] {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

export async function resolveChapter(client: WikiClient, book: number, para: number): Promise<ChapterMeta> {
  let meta = await fetchMeta(client, book, para);
  let hops = 0;
  while (meta && (Number(meta.chapter_len) || 0) <= 1 && hops < 6) {
    let up: number | undefined;
    const path = parsePath(meta.path);
    if (path.length) {
      const last = path[path.length - 1]!;
      if (Number(last.paragraph ?? -1) !== Number(meta.paragraph ?? -1)) up = Number(last.paragraph);
    }
    if (up == null && meta.parent != null) up = Number(meta.parent);
    if (up == null) break;
    meta = await fetchMeta(client, book, up);
    hops++;
  }
  return { meta, hops };
}

export async function chapterMeta(
  client: WikiClient,
  args: { coord: string },
): Promise<Row> {
  const [book, para] = parseCoord(args.coord);
  const { meta, hops } = await resolveChapter(client, book, para);
  if (!meta || !meta.chapter_len) {
    throw new WpError(`${book}:${para} 向上找不到章节节点，无法确定章节范围。`);
  }
  const start = Number(meta.paragraph);
  const length = Number(meta.chapter_len);
  const strlen = Number(meta.chapter_strlen) || 0;
  const end = start + length - 1;
  const path = parsePath(meta.path);
  const title = meta.toc || meta.title || (path.length ? path[path.length - 1]?.title : "");
  return {
    title,
    path: fmtPath(path),
    book,
    start,
    end,
    paragraphs: length,
    chars: strlen,
    hops,
    prevChapter: meta.prev_chapter,
    nextChapter: meta.next_chapter,
    notes: ["只报体量，未取文。要读全文调用 wikipali_chapter_fetch。"],
  };
}

const SENTENCE_RE = /data-sid='([^']+)'\s*>(.*?)<\/div>/gs;

export async function tipitakaContent(
  client: WikiClient,
  book: number,
  para: number,
  channel?: string,
  asText = true,
): Promise<Row[]> {
  const query: Record<string, string> = {};
  if (channel) query.channel = channel;
  const data = await guarded(`取 ${book}:${para} 的整章内容`, async () => {
    try {
      return await client.call("GET", `v2/tipitaka-content/${book}-${para}`, { query, timeout: READ_TIMEOUT });
    } catch (exc) {
      if (exc instanceof ApiError && String(exc).includes("found") && String(exc).includes("false")) {
        throw new WpError(
          `${book}:${para} 这一章没有该版本的预建内容。这是「该 channel 在本章无文本」，不是服务故障——用 wikipali_versions 看这一段实际有哪些版本。`,
        );
      }
      throw exc;
    }
  });
  if (typeof data !== "string") throw new WpError("整章内容的返回不是字符串，服务端返回形状可能变了。");

  const grouped: Record<number, { id: string; text: string }[]> = {};
  const order: number[] = [];
  for (const m of String(data).matchAll(SENTENCE_RE)) {
    const sid = m[1]!;
    const body = m[2]!;
    const text = (asText ? stripMarkup(body) : body.replace(/\s+/g, " ")).trim();
    if (!text) continue;
    const paraNo = Number(sid.split("-")[1]);
    if (!Number.isInteger(paraNo)) continue;
    if (!grouped[paraNo]) {
      grouped[paraNo] = [];
      order.push(paraNo);
    }
    grouped[paraNo]!.push({ id: sid, text });
  }
  return order.map((n) => ({ para: n, sentences: grouped[n]! }));
}

export function pickBody(child: Row, wantedChannels: string[]): string | null {
  const sources: Row[] = [];
  if (wantedChannels.length) {
    for (const tran of child.translation ?? []) {
      if (wantedChannels.includes(tran.channel?.id)) sources.push(tran);
    }
    if (!sources.length) return null;
  } else {
    sources.push(...(child.origin ?? []));
  }
  for (const src of sources) {
    const body = String(src.content ?? "").trim();
    if (body) return body;
    const html = String(src.html ?? "").trim();
    if (html) return html;
  }
  return "";
}

export async function chapterContent(
  client: WikiClient,
  book: number,
  para: number,
  channels: string[],
  asText = true,
): Promise<{ rows: Row[]; placeholders: number }> {
  const query: Record<string, string> = {};
  if (channels.length) query.channels = channels.join(",");
  const data = await guarded(`取 ${book}:${para} 的整章内容`, async () =>
    client.call("GET", `v2/chapter-content/${book}-${para}`, { query, timeout: READ_TIMEOUT }),
  );
  const raw = (data as Row)?.content ?? "[]";
  let paragraphs: Row[];
  try {
    paragraphs = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new WpError("整章内容不是合法 JSON，服务端返回形状可能变了。");
  }

  const wanted = new Set(channels);
  const out: Row[] = [];
  let placeholders = 0;
  for (const item of paragraphs) {
    const sentences: Row[] = [];
    for (const child of item.children ?? []) {
      const body = pickBody(child, channels);
      if (body === null) continue;
      if (!body.trim()) {
        placeholders += 1;
        continue;
      }
      sentences.push({ id: child.id, text: asText ? stripMarkup(body) : body });
    }
    if (sentences.length) out.push({ para: Number(item.para), sentences });
  }
  return { rows: out, placeholders };
}

// ---------------------------------------------------------------------------
// versions / related
// ---------------------------------------------------------------------------

export async function versions(client: WikiClient, args: { coord: string }): Promise<Row> {
  const [book, para] = parseCoord(args.coord);
  const data = await guarded(`查 ${book}:${para} 的可用译本`, async () => {
    try {
      return await client.call("GET", "v2/channel", {
        query: { view: "paragraphs", book_id: String(book), para: String(para) },
        timeout: READ_TIMEOUT,
      });
    } catch (exc) {
      if (exc instanceof ApiError && exc.status >= 500) {
        throw new WpError(
          `查 ${book}:${para} 的可用译本失败（HTTP ${exc.status}）。稳定版站点上该端点有已知缺陷，请切到最新版（wikipali_endpoint 选 next）再试。`,
        );
      }
      throw exc;
    }
  });
  const rows = rowsOf(data);
  const langs = new Set(rows.map((r) => String(r.lang)));
  const missing = ["pali", "my", "zh-Hans", "zh", "en", "th"].filter((l) => !langs.has(l));
  const out = rows.map((r) => ({
    type: r.type,
    lang: r.lang,
    name: r.name,
    uid: r.uid,
    suspectedMachine: looksMachine(r.name),
  }));
  return {
    count: rows.length,
    rows: out,
    missingLanguages: missing,
    notes: [
      rows.length ? "" : `${book}:${para} 在任何 channel 下都没有内容。`,
      missing.length ? `该段没有这些语言的内容：${missing.join(", ")}——如实报告「无」。` : "",
      "标 suspectedMachine 的按机器译文标注引用；没标的不等于是人译，权威判定看 wikipali_get 返回的作者是不是模型。",
    ].filter(Boolean),
  };
}

export async function related(client: WikiClient, args: { coord: string }): Promise<Row> {
  const [book, para] = parseCoord(args.coord);
  const data = await guarded(`查 ${book}:${para} 的关联段落`, async () => {
    try {
      return await client.call("GET", "v2/related-paragraph", {
        query: { book: String(book), para: String(para) },
        timeout: READ_TIMEOUT,
      });
    } catch (exc) {
      if (exc instanceof ApiError && exc.status >= 500) {
        throw new WpError(
          `查 ${book}:${para} 的关联段落失败（HTTP ${exc.status}）。最可能是该段没有关联段落（稳定版此时报 500），也可能是服务问题——不要据此断言「该段有/没有注释」。`,
        );
      }
      throw exc;
    }
  });
  const rows = rowsOf(data);
  const order: Record<string, number> = { mūla: 0, aṭṭhakathā: 1, ṭīkā: 2 };
  const out = rows
    .sort((a, b) => (order[textLayer(a.tags)] ?? 9) - (order[textLayer(b.tags)] ?? 9))
    .map((r) => ({
      layer: textLayer(r.tags) || "未标层次",
      book: r.book,
      bookTitlePali: r.book_title_pali,
      paras: r.para ?? [],
    }));
  return {
    count: rows.length,
    rows: out,
    notes: rows.length
      ? ["引用时必须标明层次——把义注的解释当成本文的说法是学术错误。"]
      : ["该段没有关联段落。约 2% 的段落没有 CST 锚点，这是正常结果，不要转而搜关键词充数。"],
  };
}

// ---------------------------------------------------------------------------
// 文章 / 文集
// ---------------------------------------------------------------------------

export async function articles(
  client: WikiClient,
  args: { keyword?: string; lang?: string; view: string; limit: number; offset: number },
): Promise<Row> {
  const query: Record<string, string | number> = { view: args.view, limit: args.limit, offset: args.offset };
  if (args.keyword) query.search = args.keyword;
  if (args.lang) query.lang = args.lang;
  const data = await guarded("列出文章", async () =>
    client.call("GET", "v2/article", { query, timeout: READ_TIMEOUT }),
  );
  const rows = rowsOf(data);
  const out = rows.map((r) => ({
    lang: r.lang,
    title: r.title,
    subtitle: r.subtitle,
    uid: r.uid,
    author: r.editor?.nickName ?? "",
    updatedAt: String(r.updated_at ?? "").slice(0, 10),
  }));
  return {
    count: (data as Row)?.count ?? rows.length,
    rows: out,
    notes: ["文章是二手研究，不是原典。引用它的观点要标明作者。"],
  };
}

export async function article(client: WikiClient, args: { uid: string; chars: number }): Promise<Row> {
  const art = await guarded(`读文章 ${args.uid}`, async () => {
    const data = await client.call("GET", `v2/article/${args.uid}`, { timeout: READ_TIMEOUT });
    if (!data) throw new WpError(`读不到文章 ${args.uid}。`);
    return data as Row;
  });
  const body = String(art.content ?? "");
  const truncated = args.chars && body.length > args.chars;
  return {
    uid: art.uid,
    title: art.title,
    subtitle: art.subtitle,
    lang: art.lang,
    author: art.editor?.nickName ?? "",
    studio: art.studio?.nickName ?? "",
    updatedAt: String(art.updated_at ?? "").slice(0, 10),
    content: truncated ? body.slice(0, args.chars) : body,
    totalChars: body.length,
    truncated,
    notes: ["文章是二手研究，不是原典。引用它的观点要标明作者，不要把它的说法当成经律本身的说法。"],
  };
}

export async function anthology(
  client: WikiClient,
  args: { uid?: string; view: string; limit: number; offset: number },
): Promise<Row> {
  if (args.uid) {
    const data = await guarded(`读文集 ${args.uid}`, async () =>
      client.call("GET", `v2/anthology/${args.uid}`, { timeout: READ_TIMEOUT }),
    );
    const arts = ((data as Row)?.article_list ?? []) as Row[];
    return {
      title: (data as Row)?.title,
      lang: (data as Row)?.lang,
      summary: (data as Row)?.summary,
      articles: arts.slice(0, args.limit).map((a) =>
        typeof a === "object" ? { title: a.title, uid: a.uid } : a,
      ),
    };
  }
  const data = await guarded("列出文集", async () =>
    client.call("GET", "v2/anthology", { query: { view: args.view, limit: args.limit, offset: args.offset }, timeout: READ_TIMEOUT }),
  );
  const rows = rowsOf(data);
  return {
    count: (data as Row)?.count ?? rows.length,
    rows: rows.map((r) => ({
      lang: r.lang,
      title: r.title,
      uid: r.uid,
      childrenNumber: r.childrenNumber,
    })),
  };
}

// ---------------------------------------------------------------------------
// 分类目录 / 术语表（无状态：每次拉取，不落本地缓存）
// ---------------------------------------------------------------------------

export async function books(
  client: WikiClient,
  args: { keyword?: string; tags?: string; tagList?: boolean; showTags?: boolean; limit: number; refresh?: boolean },
): Promise<Row> {
  const rows = await guarded("取书目清单", async () => {
    const data = await client.call("GET", "v2/book-title", { timeout: READ_TIMEOUT });
    const r = rowsOf(data);
    if (r.length && !("tags" in r[0]!)) {
      throw new WpError("该站点返回的书目清单里没有 tags/toc 字段——服务端版本较旧，请用 WIKIPALI_API_URL 切到最新版（next）再试。");
    }
    return r;
  });

  if (args.tagList) {
    const counter: Record<string, number> = {};
    for (const r of rows) for (const t of r.tags ?? []) counter[t] = (counter[t] ?? 0) + 1;
    const out = Object.entries(counter)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, args.limit)
      .map(([name, n]) => ({ tag: name, count: n }));
    return { total: Object.keys(counter).length, rows: out, notes: ["多个 tag 用逗号连接是「且」的关系。"] };
  }

  let hits = rows;
  if (args.tags) {
    const want = args.tags.split(",").map((t) => t.trim()).filter(Boolean);
    hits = hits.filter((r) => want.every((t) => (r.tags ?? []).includes(t)));
  }
  if (args.keyword) {
    const kw = args.keyword.toLowerCase();
    hits = hits.filter(
      (r) => String(r.title ?? "").toLowerCase().includes(kw) || String(r.toc ?? "").toLowerCase().includes(kw),
    );
  }
  const out = hits.slice(0, args.limit).map((r) => ({
    book: r.book,
    paragraph: r.paragraph,
    toc: r.toc,
    relatedName: r.related_name,
    tags: args.showTags ? r.tags : undefined,
  }));
  return { count: hits.length, total: rows.length, rows: out };
}

export async function terms(
  client: WikiClient,
  args: { keyword?: string; lang: string; view: string; limit: number; refresh?: boolean },
): Promise<Row> {
  const rows = await guarded("取术语表", async () => {
    const data = await client.call("GET", "v2/term-vocabulary", {
      query: { view: args.view, lang: args.lang },
      timeout: 120_000,
    });
    return rowsOf(data);
  });
  const kw = (args.keyword ?? "").toLowerCase();
  const hits = kw ? rows.filter((r) => String(r.word ?? "").toLowerCase().includes(kw)) : rows;
  const out = hits.slice(0, args.limit).map((r) => ({
    word: r.word,
    meaning: r.meaning,
    other_meaning: r.other_meaning,
    tag: r.tag,
    guid: r.guid,
  }));
  return {
    count: hits.length,
    total: rows.length,
    rows: out,
    notes: [
      "术语表是权威译名对照，写译文或论文时的用词应与它一致；不一致时要说明理由。",
      "术语表没收录不代表语料里没有这个词。",
    ],
  };
}

// ---------------------------------------------------------------------------
// 词频合计
// ---------------------------------------------------------------------------

export async function count(client: WikiClient, args: { words: string[] }): Promise<Row> {
  const out: Row[] = [];
  for (const word of args.words) {
    const rows = await fetchForms(client, word);
    if (!rows.length) {
      out.push({ word, found: false });
      continue;
    }
    const top = rows[0]!;
    const forms = top.case ?? [];
    out.push({
      word,
      found: true,
      lemma: top.word,
      forms: forms.length,
      total: forms.reduce((s: number, f: Row) => s + (Number(f.count) || 0), 0),
      bold: forms.reduce((s: number, f: Row) => s + (Number(f.bold) || 0), 0),
    });
  }
  return { rows: out, notes: ["这里数的是词次，不是段落数。段落数用 wikipali_search 的 count。"] };
}
