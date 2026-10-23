/**
 * 句子批注（discussion）的读写，走 v3 `/v3/discussions`（对应插件 lib/cmd_discuss.py）。
 *
 * 批注挂在某一句上：`target_type = 'sentence'`、`target_id = sentences.uid`。uid 是逐句、
 * 逐 channel 的——同一段巴利原文和它的中译是两条不同的句子，挂错地方比写错内容更难发现。
 *
 * **写入要人类授权**（v3 agent 协作）：用人类 userToken 调 `POST /v3/agent-grants`，给模型签一张
 * 「某 channel、某 book」的写入授权；写入时 Authorization 是 modelToken，另带请求头 `X-Agent-Grant`。
 * 服务端记 editor = 授权人、co_editor = 模型，权限按授权人判断。
 * 无状态：授权每次写入时瞬时签发、用完即弃，不缓存（插件把它缓存在凭据文件里）。
 * 读（列表、单条、回复、经文范围）只要 modelToken。
 */

import { ApiError, WpError, explainApiError } from "../errors.ts";
import type { CallOptions, WikiClient } from "../client.ts";
import { READ_TIMEOUT, WRITE_TIMEOUT } from "../client.ts";
import { fmtCoord, parseCoord } from "../coords.ts";
import { jwtPayload } from "../creds.ts";
import { rowText } from "../markup.ts";
import { anchor, checkGlossary, sliceChars } from "../anchors.ts";
import { paliChannel } from "./read.ts";
import { resolveChannel } from "./write.ts";

type Row = Record<string, any>;

const TARGET_TYPE = "sentence";
const GRANT_HEADER = "X-Agent-Grant";

// 句子上的八类批注（按用户的说法选）：
//   note        批注 / 脚注——正文就是注解本身
//   commentary  注释对照 / 义注对照 / 复注对照——正文是下一层句子模板 {{book-para-start-end}}
//   discussion  审稿意见 / 讨论
//   qa          问答
//   help        求助
//   issue       问题报告（错误 / 待修）
//   glossary    外挂术语——不改译文，给一段译文临时挂上术语（标题是词头）；与术语表是两回事
//   assessment  译文评估——用某种方法给一句译文打分（0–100 的整数），一句只留一条，再评估就覆盖
// note / commentary 是批注（标题可省）；assessment 标题可省、不收锚点；其余五类是话题，必须有标题。
// 锚点只有 note / commentary / issue / glossary 收。v3 不带 type 时只列话题，批注与评估要显式给 type。
export const DISCUSS_TYPES = ["note", "commentary", "discussion", "qa", "help", "issue", "glossary", "assessment"] as const;
export type DiscussType = (typeof DISCUSS_TYPES)[number];
const ANNOTATION_TYPES = ["note", "commentary"];
const ANCHORED_TYPES = ["note", "commentary", "issue", "glossary"];
const GLOSSARY = "glossary";
const ASSESSMENT = "assessment";
// 评估方法存在 severity 列（varchar 16），与 api-v13 Discussion::ASSESSMENT_METHOD_PATTERN 一致
const ASSESSMENT_METHOD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;
// 严重 / 紧急程度，取值随 type（与 api-v13 Discussion::SEVERITIES 一致），其余类型不收
const SEVERITIES: Record<string, string[]> = { issue: ["error", "warning", "suggestion"], help: ["urgent", "normal"] };
export const SEVERITY_CHOICES = [...new Set(Object.values(SEVERITIES).flat())].sort();
const ANCHOR_FIELDS = ["pos_start", "pos_end", "quote_exact", "quote_prefix", "quote_suffix"] as const;

function checkSeverity(type: string, severity: string | undefined): void {
  if (severity == null) return;
  if (type === ASSESSMENT) throw new WpError("评估不用 severity，用 method 给评估方法。");
  const allowed = SEVERITIES[type] ?? [];
  if (!allowed.includes(severity)) {
    throw new WpError(`severity ${severity} 不适用于 ${type}：` + (allowed.length ? `可选 ${allowed.join(" / ")}` : "这一类没有严重程度"));
  }
}

function checkMethod(method: string | undefined): void {
  if (!ASSESSMENT_METHOD.test(method ?? "")) {
    throw new WpError(`method「${method ?? ""}」不合格：1–16 位字母、数字、点、下划线或连字符，以字母或数字开头，如 mqm、llm-judge。`);
  }
}

function checkScore(score: number | undefined): void {
  if (score == null || !Number.isInteger(score) || score < 0 || score > 100) throw new WpError("score 要给 0–100 的整数。");
}

// ---------------------------------------------------------------------------
// 调用与授权
// ---------------------------------------------------------------------------

/** 模型 token 的 payload 里 uid 就是模型 uid（typ = ai-model）；签写入授权要用它。 */
export function modelUidOf(modelToken: string): string {
  const payload = jwtPayload(modelToken);
  const uid = payload.uid;
  if (payload.typ !== "ai-model" || typeof uid !== "string" || !uid) {
    throw new WpError("Authorization 里的不是模型身份 token（payload 没有 typ=ai-model 的 uid）。先用 wikipali_ensure_model 取 modelToken。");
  }
  return uid;
}

function explainDiscussError(exc: ApiError, what: string): WpError {
  // 403 / 409 / 422 带上服务端的说明（v3 Problem 的 detail），其余按通用口径
  if ([403, 409, 422].includes(exc.status)) return new WpError(`${what}：HTTP ${exc.status} ${exc.message}`);
  return explainApiError(exc, what);
}

async function callAsModel(
  client: WikiClient,
  modelToken: string,
  method: string,
  path: string,
  what: string,
  opts: { body?: Row; query?: Row; headers?: Record<string, string>; envelope?: boolean; timeout?: number } = {},
): Promise<any> {
  const callOpts: CallOptions = { token: modelToken, v3: true, timeout: opts.timeout ?? READ_TIMEOUT };
  if (opts.body !== undefined) callOpts.body = opts.body;
  if (opts.query !== undefined) callOpts.query = opts.query;
  if (opts.headers !== undefined) callOpts.headers = opts.headers;
  if (opts.envelope) callOpts.envelope = true;
  try {
    return await client.call(method, path, callOpts);
  } catch (exc) {
    if (exc instanceof ApiError && exc.status === 401) {
      throw new WpError(`${what}：401 模型 token 失效或被撤销。请重新运行 wikipali_ensure_model 更新客户端侧的 modelToken。不要自动重试。`);
    }
    if (exc instanceof ApiError) throw explainDiscussError(exc, what);
    throw exc;
  }
}

/** 用人类 userToken 给模型签 (channel, book) 的写入授权，瞬时使用、不缓存。 */
async function signAgentGrant(client: WikiClient, userToken: string, modelUid: string, channelUid: string, book: number): Promise<string> {
  let data: Row;
  try {
    data = (await client.call("POST", "v3/agent-grants", {
      token: userToken,
      v3: true,
      body: { ai_model: modelUid, target_type: "channel", target_id: channelUid, book },
      timeout: READ_TIMEOUT,
    })) as Row;
  } catch (exc) {
    if (exc instanceof ApiError && exc.status === 403) {
      throw new WpError(
        `签发写入授权：403 ${exc.message}\n当前登录账号对 channel ${channelUid} 没有编辑权，或模型 ${modelUid} 不归它所有。\n` +
          "不要继续写入。确认选对了 channel，或让 owner 授予编辑权限。",
      );
    }
    if (exc instanceof ApiError) throw explainDiscussError(exc, "签发写入授权");
    throw exc;
  }
  if (!data?.token) throw new WpError("签发写入授权失败：服务端未返回 token。");
  return data.token;
}

export interface WriteCreds {
  modelToken: string;
  userToken: string;
}

/** 以模型身份、带人类授权写 v3。 */
async function callAsAgent(
  client: WikiClient,
  creds: WriteCreds,
  method: string,
  path: string,
  what: string,
  scope: [string, number],
  body?: Row,
): Promise<any> {
  const grant = await signAgentGrant(client, creds.userToken, modelUidOf(creds.modelToken), scope[0], scope[1]);
  return callAsModel(client, creds.modelToken, method, path, what, {
    ...(body !== undefined ? { body } : {}),
    headers: { [GRANT_HEADER]: grant },
    timeout: WRITE_TIMEOUT,
  });
}

// ---------------------------------------------------------------------------
// 句子定位
// ---------------------------------------------------------------------------

export async function fetchSentence(client: WikiClient, sentUid: string): Promise<Row> {
  try {
    return ((await client.call("GET", `v2/sentence/${sentUid}`, { timeout: READ_TIMEOUT })) as Row) ?? {};
  } catch (exc) {
    if (exc instanceof ApiError) throw explainApiError(exc, `取句子 ${sentUid}`);
    throw exc;
  }
}

/** 句子所在的 (channel uid, book)——agent 授权按这两样划范围。 */
async function sentenceScope(client: WikiClient, sentUid: string, data?: Row): Promise<[string, number]> {
  const d = data ?? (await fetchSentence(client, sentUid));
  const ch = d.channel ?? {};
  if (!ch.id) throw new WpError(`句子 ${sentUid} 查不到所在的 channel，无法申请写入授权。`);
  return [ch.id, Number(d.book) || 0];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 把 channel 参数化成 uid：缺省是巴利原文；uuid 直接用；名字片段 / 序号要按可编辑列表找，
 * 这一步需要 userToken（X-Wikipali-User-Token）。
 */
export async function resolveDiscussChannel(
  client: WikiClient,
  given: string | undefined,
  userToken: string | undefined,
): Promise<{ uid: string; name: string | undefined }> {
  if (!given) return { uid: await paliChannel(client), name: "巴利原文" };
  if (UUID_RE.test(given)) return { uid: given, name: undefined };
  if (!userToken) {
    throw new WpError(`channel「${given}」不是 uid。按名字找 channel 需要请求头 X-Wikipali-User-Token；或直接给 channel 的 uid。`);
  }
  return resolveChannel(client, userToken, given);
}

export interface SentenceArgs {
  coord?: string;
  sent?: string;
  channel?: string;
  words?: string;
}

/** 定位要批注的那一句，返回 uid 与回显描述。给 sent 就直接用；按坐标命中多于一句时不猜。 */
async function resolveSentence(client: WikiClient, args: SentenceArgs, userToken?: string): Promise<{ uid: string; desc: string }> {
  if (args.sent) return { uid: args.sent, desc: `句子 ${args.sent}` };
  if (!args.coord) throw new WpError("要么给坐标 coord（如 216-35），要么用 sent 直接给句子 uid。");

  const [book, para] = parseCoord(args.coord);
  const { uid: channelUid, name: channelName } = await resolveDiscussChannel(client, args.channel, userToken);
  let data: unknown;
  try {
    data = await client.call("GET", "v2/sentence", {
      query: { view: "paragraph", book, para, channels: channelUid, limit: 200 },
      timeout: READ_TIMEOUT,
    });
  } catch (exc) {
    if (exc instanceof ApiError) throw explainApiError(exc, `取 ${args.coord} 的句子`);
    throw exc;
  }
  let rows: Row[] = (data as Row)?.rows ?? [];
  if (!rows.length) {
    throw new WpError(`${fmtCoord(book, para)} 在该 channel 下没有句子，无法批注。这是「该 channel 在此处没有文本」，不是查询失败——换个 channel，或先确认坐标。`);
  }
  if (args.words) {
    const m = /^(\d+)-(\d+)$/.exec(args.words.trim());
    if (!m) throw new WpError("words 的格式是 起-止，如 2-17");
    rows = rows.filter((r) => Number(r.word_start) === Number(m[1]) && Number(r.word_end) === Number(m[2]));
    if (!rows.length) throw new WpError(`${fmtCoord(book, para)} 下没有 [${args.words}] 这一句。`);
  }
  if (rows.length > 1) {
    const lines = rows.map((r) => `  words ${r.word_start}-${r.word_end}   ${rowText(r).slice(0, 60)}`);
    throw new WpError(`${fmtCoord(book, para)} 有 ${rows.length} 句，用 words 指明是哪一句（或用 sent 直接给 uid）：\n${lines.join("\n")}`);
  }
  const row = rows[0]!;
  const ch = row.channel ?? {};
  const desc = `${fmtCoord(book, para)} [${row.word_start}-${row.word_end}] ${ch.name || channelName || ""}\n${rowText(row).slice(0, 100)}`;
  return { uid: row.id, desc };
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

function actorName(actor: Row | undefined): string {
  return actor?.nickName || actor?.userName || "(未知)";
}

/** 署名：AI 凭授权代写的显示「授权人（与 模型）」；v2 时期模型直接署名的显示「模型（AI）」。 */
export function who(row: Row): string {
  const editor = row.editor ?? {};
  if (row.co_editor) return `${actorName(editor)}（与 ${actorName(row.co_editor)}）`;
  return (editor.roles ?? []).includes("ai") ? `${actorName(editor)}（AI）` : actorName(editor);
}

export function fmtAnchor(row: Row): string {
  if (row.pos_start == null && row.pos_end == null && !row.quote_exact) return "";
  let text = `[${row.pos_start}-${row.pos_end}]`;
  if (row.quote_exact) text += ` 「${row.quote_exact}」`;
  return text;
}

function fmtScore(row: Row): string {
  if (row.type !== ASSESSMENT || row.score == null) return "";
  return `${row.score} 分` + (row.severity ? `（${row.severity}）` : "");
}

function view(row: Row): Row {
  return {
    id: row.id,
    type: row.type,
    title: row.title || undefined,
    status: row.status,
    severity: row.severity || undefined,
    score: row.type === ASSESSMENT ? row.score : undefined,
    scoreText: fmtScore(row) || undefined,
    anchor: fmtAnchor(row) || undefined,
    author: who(row),
    createdAt: String(row.created_at ?? "").slice(0, 10),
    replyCount: row.reply_count ?? 0,
    content: row.content,
  };
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

export async function discussList(
  client: WikiClient,
  modelToken: string,
  args: SentenceArgs & { status: string; type: DiscussType; limit: number; page: number },
  userToken?: string,
): Promise<Row> {
  const { uid, desc } = await resolveSentence(client, args, userToken);
  const target = { target_type: TARGET_TYPE, target_id: uid, type: args.type };
  const pageData = ((await callAsModel(client, modelToken, "GET", "v3/discussions", "列出批注", {
    envelope: true,
    query: { ...target, status: args.status, per_page: args.limit, page: args.page },
  })) ?? {}) as Row;
  const rows: Row[] = pageData.data ?? [];
  const summary = ((await callAsModel(client, modelToken, "GET", "v3/discussions/summary", "统计批注", { query: target })) ?? {}) as Row;
  const topics: Row[] = [];
  for (const row of rows) {
    const replies: Row[] = row.reply_count
      ? ((await callAsModel(client, modelToken, "GET", `v3/discussions/${row.id}/replies`, "取批注的回复", { query: { per_page: 200 } })) ?? [])
      : [];
    topics.push({
      ...view(row),
      replies: replies.map((r) => ({ id: r.id, author: who(r), createdAt: String(r.created_at ?? "").slice(0, 10), content: r.content })),
    });
  }
  const meta = pageData.meta ?? {};
  const counts = summary.status_counts ?? {};
  return {
    target: desc,
    sentenceUid: uid,
    type: args.type,
    page: { current: meta.current_page ?? 1, last: meta.last_page ?? 1, total: meta.total ?? rows.length },
    statusCounts: { active: counts.active ?? 0, close: counts.close ?? 0 },
    topics,
    notes: [rows.length ? "回复某条用 wikipali_discuss_reply_*，id 用 topics[].id（不能回复一条回复）。" : "这一句还没有这一类批注。"],
  };
}

function parseTypes(value: string | undefined): string[] {
  const types = String(value ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const bad = types.filter((t) => !(DISCUSS_TYPES as readonly string[]).includes(t));
  if (bad.length) throw new WpError(`type 不认识：${bad.join(", ")}（可选 ${DISCUSS_TYPES.join(" / ")}）`);
  return types;
}

/** 一段经文（一章 / 段落区间 / 一本书 / 整个 channel）里的批注：GET v3/tipitaka-discussions/{channel}。 */
export async function discussRange(
  client: WikiClient,
  modelToken: string,
  args: {
    channel: string; coord?: string; chapter: boolean; to?: number; book?: number;
    type?: string; status?: string; severity?: string; limit: number; page: number; all: boolean;
  },
  userToken?: string,
): Promise<Row> {
  if (!args.channel) throw new WpError("要给 channel：批注挂在哪个版本的句子上（uid 或名字片段）。");
  const query: Row = { per_page: args.limit };
  if (args.coord) {
    if (args.book != null) throw new WpError("给了坐标就不要再给 book。");
    const [book, para] = parseCoord(args.coord);
    query.book = book;
    if (args.chapter) {
      if (args.to != null) throw new WpError("chapter 与 to 不能同用：chapter 取整章，to 取段落区间。");
      query.chapter = para;
    } else {
      query.para = para;
      if (args.to != null) query.to = args.to;
    }
  } else if (args.book != null) {
    if (args.chapter || args.to != null) throw new WpError("chapter / to 要配坐标用，如 coord=169-893 chapter=true。");
    query.book = args.book;
  } else if (args.chapter || args.to != null) {
    throw new WpError("chapter / to 要配坐标用，如 coord=169-893 chapter=true。");
  }
  const types = parseTypes(args.type);
  if (types.length) query.type = types.join(",");
  if (args.status) query.status = args.status;
  if (args.severity) query.severity = args.severity;

  const { uid: channelUid, name: channelName } = await resolveDiscussChannel(client, args.channel, userToken);
  const rows: Row[] = [];
  let meta: Row = {};
  for (let page = args.page; ; page++) {
    const result = ((await callAsModel(client, modelToken, "GET", `v3/tipitaka-discussions/${channelUid}`, "列出经文范围内的批注", {
      envelope: true,
      query: { ...query, page },
    })) ?? {}) as Row;
    rows.push(...(result.data ?? []));
    meta = result.meta ?? {};
    if (!args.all || page >= Number(meta.last_page ?? 1)) break;
  }

  const scope = args.coord
    ? args.coord + (args.chapter ? "（整章）" : args.to != null ? `–${args.to}` : "")
    : args.book != null ? `book ${args.book}` : "整个 channel";
  const more = !args.all && Number(meta.last_page ?? 1) > Number(meta.current_page ?? 1);
  return {
    scope,
    channel: { uid: channelUid, name: channelName },
    types: types.length ? types : "话题（discussion / qa / help / issue / glossary）",
    total: meta.total ?? rows.length,
    page: { current: meta.current_page ?? 1, last: meta.last_page ?? 1 },
    rows: rows.map((row) => {
      const s = row.sentence ?? {};
      return { sentence: `${fmtCoord(s.book, s.paragraph)} [${s.word_start}-${s.word_end}]`, sentenceUid: row.target_id, ...view(row) };
    }),
    notes: [
      rows.length ? "按经文顺序（书、段、句起始词）排列。" : "这个范围里没有符合条件的批注。",
      ...(more ? ["还有下一页：给 page，或 all=true 一次取完。"] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// 新建 / 回复 / 修改 / 删除
// ---------------------------------------------------------------------------

export interface AnchorArgs {
  quote_exact?: string;
  quote_prefix?: string;
  quote_suffix?: string;
  pos_start?: number | null;
  pos_end?: number | null;
}

/** 显式给了的锚点字段。只收给了的——编辑时没给的字段要原样保留；pos 给 null 表示清空。 */
function anchorBody(args: AnchorArgs): Row {
  const body: Row = {};
  for (const field of ANCHOR_FIELDS) {
    const value = args[field];
    if (value === undefined) continue;
    if (field.startsWith("pos_") && value !== null && (!Number.isInteger(value) || (value as number) < 0)) {
      throw new WpError(`${field} 要给非负整数（给 null 表示清空）`);
    }
    body[field] = value;
  }
  if (body.pos_start != null && body.pos_end != null && body.pos_start > body.pos_end) throw new WpError("pos_start 不能大于 pos_end");
  return body;
}

/**
 * 按摘录补全锚点：给了 quote_exact 没给位置，就在句子原文里找出位置与前后缀。
 * 两样都给了就核对：位置上的文字必须就是摘录。补出的前后缀不覆盖显式给的。
 */
function locateAnchors(text: string, anchors: Row): Row {
  const exact = anchors.quote_exact;
  if (!exact) return anchors;
  const start = anchors.pos_start;
  const end = anchors.pos_end;
  if (start != null && end != null) {
    const at = sliceChars(text, start, end);
    if (at !== exact) throw new WpError(`pos_start/pos_end 处的文字是「${at}」，与 quote_exact「${exact}」不符。只给摘录就行，位置由程序算。`);
    return anchors;
  }
  if (start != null || end != null) throw new WpError("pos_start / pos_end 要么都给、要么都不给（只给摘录时程序会算）。");
  const [s, e, prefix, suffix] = anchor(text, anchors);
  return { ...anchors, pos_start: s, pos_end: e, quote_prefix: anchors.quote_prefix ?? prefix, quote_suffix: anchors.quote_suffix ?? suffix };
}

function preview(client: WikiClient, creds: { modelToken: string }, scope: [string, number], header: Row, body: Row, anchorView?: Row): Row {
  return {
    api: client.apiNote(),
    modelUid: modelUidOf(creds.modelToken),
    grantScope: `channel ${scope[0]}，book ${scope[1]}（署名为授权人，模型记为协作者）`,
    ...header,
    title: body.title,
    score: "score" in body ? `${body.score}` + (body.severity ? `（${body.severity}）` : "") : undefined,
    anchor: fmtAnchor(anchorView ?? body) || undefined,
    content: body.content,
    notify: "notify" in body ? (body.notify ? "会发站内通知" : "不发") : undefined,
  };
}

function saved(row: Row): Row {
  return {
    id: row.id,
    author: who(row),
    ...(row.type === ASSESSMENT && row.created_at !== row.updated_at ? { overwritten: "这一句原来已有评估，已覆盖为本次的分数、方法与理由。" } : {}),
  };
}

export async function discussAdd(
  client: WikiClient,
  creds: WriteCreds,
  args: SentenceArgs & AnchorArgs & {
    type: DiscussType; title?: string; content?: string; severity?: string; score?: number; method?: string; notify: boolean; dryRun: boolean;
  },
): Promise<Row> {
  modelUidOf(creds.modelToken);
  const isAssessment = args.type === ASSESSMENT;
  if (isAssessment) {
    checkScore(args.score);
    checkMethod(args.method);
  } else if (args.score != null || args.method) {
    throw new WpError("score / method 只给 type=assessment（译文评估）用。");
  }
  // 评估的理由可以不写
  const content = args.content?.trim() ? args.content : isAssessment ? undefined : null;
  if (content === null) throw new WpError("批注内容为空。给 content。");
  let anchors = anchorBody(args);
  if (!ANNOTATION_TYPES.includes(args.type) && !isAssessment && !args.title) {
    if (args.type === GLOSSARY) throw new WpError("外挂术语必须给 title：术语的词头（巴利词，如 bhikkhu）。");
    throw new WpError(`${args.type} 类话题必须给 title（审稿意见 / 问答 / 求助 / 问题是要被列出来讨论的）。`);
  }
  if (Object.keys(anchors).length && !ANCHORED_TYPES.includes(args.type)) {
    throw new WpError(`锚点（pos_* / quote_*）只有 note / commentary / issue / glossary 收，${args.type} 是整句的。`);
  }
  checkSeverity(args.type, args.severity);

  const { uid, desc } = await resolveSentence(client, args, creds.userToken);
  const sentence = await fetchSentence(client, uid);
  const text = String(sentence.content ?? "");
  anchors = locateAnchors(text, anchors);
  if (args.type === GLOSSARY) checkGlossary(text, anchors.pos_start, anchors.pos_end, args.title);

  const body: Row = { target_type: TARGET_TYPE, target_id: uid, type: args.type, content: content ?? null, notify: args.notify, ...anchors };
  if (args.title) body.title = args.title;
  if (args.severity) body.severity = args.severity;
  if (isAssessment) {
    body.severity = args.method;
    body.score = args.score;
  }
  const scope = await sentenceScope(client, uid, sentence);
  const pv = preview(client, creds, scope, {
    target: desc,
    sentenceUid: uid,
    type: args.type + (args.severity ? `（${args.severity}）` : ""),
    ...(isAssessment ? { warning: "一句只留一条评估，这一句已有评估的话会被本次覆盖。" } : {}),
  }, body);
  if (args.dryRun) return { dryRun: true, preview: pv };
  const row = await callAsAgent(client, creds, "POST", "v3/discussions", "新建批注", scope, body);
  return { dryRun: false, preview: pv, ...saved(row) };
}

async function getDiscussion(client: WikiClient, modelToken: string, id: string): Promise<Row> {
  const data = await callAsModel(client, modelToken, "GET", `v3/discussions/${id}`, "取批注");
  if (!data) throw new WpError(`找不到批注 ${id}`);
  return data as Row;
}

export async function discussReply(
  client: WikiClient,
  creds: WriteCreds,
  args: { id: string; content?: string; notify: boolean; dryRun: boolean },
): Promise<Row> {
  modelUidOf(creds.modelToken);
  if (!args.content?.trim()) throw new WpError("回复内容为空。给 content。");
  const topic = await getDiscussion(client, creds.modelToken, args.id);
  if (topic.parent_id) throw new WpError(`${args.id} 本身是一条回复；回复它所在的话题 ${topic.parent_id}。`);
  // 类型、挂靠对象由服务端从话题继承；回复只有正文
  const body: Row = { content: args.content, notify: args.notify };
  const scope = await sentenceScope(client, topic.target_id);
  const pv = preview(client, creds, scope, { replyTo: `${args.id}（${topic.type}）${topic.title ?? ""}` }, body);
  if (args.dryRun) return { dryRun: true, preview: pv };
  const row = await callAsAgent(client, creds, "POST", `v3/discussions/${args.id}/replies`, "回复批注", scope, body);
  return { dryRun: false, preview: pv, ...saved(row) };
}

/** 改一条批注 / 对应 / 评估：只把改了的字段发出去（v3 是 PATCH，没传的字段原样保留）。 */
export async function discussEdit(
  client: WikiClient,
  creds: WriteCreds,
  args: AnchorArgs & {
    id: string; title?: string; content?: string; status?: string; severity?: string; score?: number; method?: string; dryRun: boolean;
  },
): Promise<Row> {
  modelUidOf(creds.modelToken);
  const old = await getDiscussion(client, creds.modelToken, args.id);
  const body: Row = {};
  if (args.title !== undefined && args.title !== old.title) body.title = args.title;
  if (args.content !== undefined) {
    if (!args.content.trim()) throw new WpError("新正文为空；不改正文就别给 content。");
    if (args.content !== old.content) body.content = args.content;
  }
  if (args.status && args.status !== old.status) body.status = args.status;
  if (args.severity && args.severity !== old.severity) {
    checkSeverity(old.type, args.severity);
    body.severity = args.severity;
  }
  if (args.score != null || args.method) {
    if (old.type !== ASSESSMENT) throw new WpError("score / method 只能改译文评估（assessment）。");
    if (args.score != null && args.score !== old.score) {
      checkScore(args.score);
      body.score = args.score;
    }
    if (args.method && args.method !== old.severity) {
      checkMethod(args.method);
      body.severity = args.method;
    }
  }
  let anchors = anchorBody(args);
  let sentence: Row | undefined;
  if (anchors.quote_exact || old.type === GLOSSARY) sentence = await fetchSentence(client, old.target_id);
  if (anchors.quote_exact) anchors = locateAnchors(String(sentence?.content ?? ""), anchors);
  const merged: Row = Object.fromEntries(ANCHOR_FIELDS.map((f) => [f, f in anchors ? anchors[f] : old[f]]));
  if (old.type === GLOSSARY && (Object.keys(anchors).length || "title" in body)) {
    checkGlossary(String(sentence?.content ?? ""), merged.pos_start, merged.pos_end, body.title ?? old.title);
  }
  if (merged.pos_start != null && merged.pos_end != null && merged.pos_start > merged.pos_end) throw new WpError("改完后 pos_start 大于 pos_end");
  for (const [f, v] of Object.entries(anchors)) if (v !== old[f]) body[f] = v;
  if (!Object.keys(body).length) return { dryRun: args.dryRun, changed: false, note: "没有要改的字段。" };

  const scope = await sentenceScope(client, old.target_id, sentence);
  const pv = preview(client, creds, scope, {
    edit: `${args.id}（${old.type}）`,
    oldAnchor: fmtAnchor(old) || "（无）",
    changedFields: Object.keys(body),
  }, body, Object.keys(anchors).length ? merged : undefined);
  if (args.dryRun) return { dryRun: true, preview: pv };
  const row = await callAsAgent(client, creds, "PATCH", `v3/discussions/${args.id}`, "修改批注", scope, body);
  return { dryRun: false, preview: pv, ...saved(row) };
}

export async function discussDelete(client: WikiClient, creds: WriteCreds, args: { id: string; dryRun: boolean }): Promise<Row> {
  modelUidOf(creds.modelToken);
  const old = await getDiscussion(client, creds.modelToken, args.id);
  const pv = { delete: `${args.id}（${old.type}）`, author: who(old), title: old.title || undefined, anchor: fmtAnchor(old) || undefined };
  if (args.dryRun) return { dryRun: true, preview: pv };
  const scope = await sentenceScope(client, old.target_id);
  await callAsAgent(client, creds, "DELETE", `v3/discussions/${args.id}`, "删除批注", scope);
  return { dryRun: false, preview: pv, note: "已删除（软删除；有回复的话题会以「已删除」占位保留，回复照常显示）。" };
}

// ---------------------------------------------------------------------------
// 供 notes.ts（注释对照）复用
// ---------------------------------------------------------------------------

export { callAsAgent, callAsModel };
