/**
 * 写端 API 封装（无状态版）。
 *
 * 凭据由客户端经 HTTP Authorization 头提供 userToken；server 用它瞬时派生
 * modelToken（GET /v2/ai-model-token/{uid}）与 accessToken（POST /v2/access-token），
 * 随用随弃，不落盘、不缓存。
 *
 * 三种 token 职责不混：
 *   userToken（人类，客户端持有）→ 查/建 ai-model、签 access token、列 channel
 *   modelToken（模型）→ 写句子/术语/批注时的 Authorization
 *   accessToken（channel 编辑权）→ 写句子/术语时的 body 字段
 */

import { ApiError, WpError, explainApiError } from "../errors.ts";
import type { CallOptions, WikiClient } from "../client.ts";
import { WRITE_TIMEOUT, READ_TIMEOUT } from "../client.ts";
import { fmtCoord, parseCoord } from "../coords.ts";
import { fmtTs, tokenExpiry } from "../creds.ts";
import { PALI_CHANNEL, stripMarkup } from "../markup.ts";

type Row = Record<string, any>;

async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (exc) {
    if (exc instanceof ApiError) throw explainApiError(exc, what);
    throw exc;
  }
}

const TERM_BOOK = 0; // 术语没有 book 概念，access token 一律签「不限 book」

function rowsOf(data: unknown): Row[] {
  return (data as Row)?.rows ?? [];
}

// ---------------------------------------------------------------------------
// 瞬时派生 token
// ---------------------------------------------------------------------------

export async function grantAccessToken(
  client: WikiClient,
  userToken: string,
  channelUid: string,
  book: number,
): Promise<{ token: string; exp?: number; book: number }> {
  // book 必须是整数：服务端用 !== 严格比较，"1" !== 1 恒真会导致鉴权失败
  const payload = [{ res_type: "channel", res_id: channelUid, power: "edit", book: Math.trunc(book) }];
  const data = await guarded("签发 access token", async () =>
    client.call("POST", "v2/access-token", { token: userToken, body: { payload }, timeout: READ_TIMEOUT }),
  );
  const rows = rowsOf(data);
  if (!rows.length) {
    throw new WpError(
      `签发 access token 返回 count: 0，说明当前账号对 channel ${channelUid} 没有编辑权。` +
        "不要继续写入。请确认选对了 channel，或让 owner 授予 ≥ editor 权限。",
    );
  }
  const row = rows[0]!;
  return { token: row.token, exp: row.payload?.exp, book: Math.trunc(book) };
}

// ---------------------------------------------------------------------------
// 身份 / 模型 / channel
// ---------------------------------------------------------------------------

export async function whoami(client: WikiClient, userToken: string): Promise<Row> {
  const data = await guarded("取当前用户信息", async () =>
    client.call("GET", "v2/auth/current", { token: userToken, timeout: READ_TIMEOUT }),
  );
  const d = data as Row;
  return {
    id: d.id,
    nickName: d.nickName,
    realName: d.realName,
    roles: d.roles,
    tokenExpires: fmtTs(tokenExpiry(userToken)),
  };
}

async function findModelByName(client: WikiClient, userToken: string, studioName: string, name: string): Promise<Row | null> {
  const listed = await guarded("查询模型列表", async () =>
    client.call("GET", "v2/ai-model", {
      token: userToken,
      query: { view: "studio", name: studioName, keyword: name },
      timeout: READ_TIMEOUT,
    }),
  );
  const rows = rowsOf(listed);
  return rows.find((r: Row) => r.name === name) ?? null;
}

/** 幂等地建立模型记录，返回 uid/name（不再签发并缓存 token——token 由写操作瞬时派生）。 */
export async function ensureModel(
  client: WikiClient,
  userToken: string,
  args: { name?: string; model?: string; url?: string; description?: string; privacy: string },
): Promise<Row> {
  const name = args.name || process.env.WIKIPALI_MODEL_NAME;
  if (!name) throw new WpError("必须指定模型名 name（如 claude-opus-5）。该名字会成为句子的作者署名。");

  const current = await guarded("取当前用户信息", async () =>
    client.call("GET", "v2/auth/current", { token: userToken, timeout: READ_TIMEOUT }),
  );
  const studioName = (current as Row)?.realName;
  if (!studioName) throw new WpError("服务端没有返回 realName，无法确定 studio_name。");

  let found = await findModelByName(client, userToken, studioName, name);
  if (!found) {
    const body: Row = { name, studio_name: studioName, privacy: args.privacy };
    if (args.model !== undefined) body.model = args.model;
    if (args.url !== undefined) body.url = args.url;
    if (args.description !== undefined) body.description = args.description;
    try {
      found = (await client.call("POST", "v2/ai-model", { token: userToken, body, timeout: WRITE_TIMEOUT })) as Row;
    } catch (exc) {
      if (!(exc instanceof ApiError) || exc.status !== 409) throw explainApiError(exc as ApiError, "创建模型记录");
      found = await findModelByName(client, userToken, studioName, name);
      if (!found) throw new WpError(`服务端说 ${name} 已存在（409），但列表里查不到，无法继续。`);
    }
  }

  const patch: Row = {};
  for (const [field, value] of Object.entries({ model: args.model, url: args.url, description: args.description })) {
    if (value !== undefined && found[field] !== value) patch[field] = value;
  }
  if (args.privacy && found.privacy !== args.privacy) patch.privacy = args.privacy;
  if (Object.keys(patch).length) {
    found = (await client.call("PUT", `v2/ai-model/${found.uid}`, { token: userToken, body: patch, timeout: WRITE_TIMEOUT })) as Row;
  }

  // 取模型身份 token，交给客户端保存（写操作的 Authorization 用它，便于审计）
  const issued = await guarded("签发模型身份 token", async () =>
    client.call("GET", `v2/ai-model-token/${found.uid}`, { token: userToken, timeout: READ_TIMEOUT }),
  );
  const modelToken = (issued as Row)?.token;
  if (typeof modelToken !== "string" || !modelToken) throw new WpError("签发模型身份 token 失败：服务端未返回 token。");

  return {
    uid: found.uid,
    name: found.name,
    modelToken,
    expires: fmtTs(tokenExpiry(modelToken)),
    note: "把这个 modelToken 存到客户端凭据文件（modelToken 字段）；写句子/术语的 Authorization 用 Bearer <modelToken>，审计才会记到模型名下。",
  };
}

export async function revokeModel(client: WikiClient, userToken: string, uid: string): Promise<Row> {
  const data = await guarded("撤销模型 token", async () =>
    client.call("DELETE", `v2/ai-model-token/${uid}`, { token: userToken, timeout: WRITE_TIMEOUT }),
  );
  const d = data as Row;
  return { name: d.name, tokenVersion: d.token_version, note: "该模型已签出的全部 token 已作废。" };
}

export async function listChannels(client: WikiClient, userToken: string, search?: string): Promise<Row[]> {
  const rows = await guarded("获取可编辑 channel 列表", async () => {
    const data = await client.call("GET", "v2/channel", {
      token: userToken,
      query: { view: "user-edit", order: "updated_at", dir: "desc", limit: 200, search },
      timeout: READ_TIMEOUT,
    });
    return rowsOf(data);
  });
  return rows.map((ch, idx) => ({ index: idx + 1, uid: ch.uid, name: ch.name, lang: ch.lang, role: ch.role, type: ch.type }));
}

export async function fetchChannels(client: WikiClient, userToken: string): Promise<Row[]> {
  return guarded("获取可编辑 channel 列表", async () => {
    const data = await client.call("GET", "v2/channel", {
      token: userToken,
      query: { view: "user-edit", order: "updated_at", dir: "desc", limit: 200 },
      timeout: READ_TIMEOUT,
    });
    return rowsOf(data);
  });
}

/** 返回 (uid, name)。given 可以是 uid、序号或名字片段。 */
export async function resolveChannel(
  client: WikiClient,
  userToken: string,
  given?: string,
): Promise<{ uid: string; name: string | undefined }> {
  const rows = await fetchChannels(client, userToken);
  if (!rows.length) throw new WpError("当前账号没有任何可编辑的 channel，无法继续。");

  if (given) {
    for (const ch of rows) if (ch.uid === given) return { uid: ch.uid, name: ch.name };
    if (/^\d+$/.test(given)) {
      const idx = Number(given) - 1;
      if (idx >= 0 && idx < rows.length) return { uid: rows[idx]!.uid, name: rows[idx]!.name };
    }
    const matched = rows.filter((c) => String(c.name ?? "").toLowerCase().includes(given.toLowerCase()));
    if (matched.length === 1) return { uid: matched[0]!.uid, name: matched[0]!.name };
    if (matched.length > 1) {
      const names = matched.slice(0, 5).map((c) => c.name).join(", ");
      throw new WpError(`「${given}」匹配到多个 channel：${names}…… 请给完整 uid。`);
    }
    if (given.length >= 32) return { uid: given, name: undefined };
    throw new WpError(`找不到 channel：${given}`);
  }
  throw new WpError("未指定 channel。请先调用 wikipali_channels 再用 channel 字段指定。");
}

export async function channelDisplayName(client: WikiClient, userToken: string, uid: string): Promise<string | undefined> {
  try {
    const data = await client.call("GET", `v2/channel/${uid}`, { token: userToken, timeout: READ_TIMEOUT });
    return typeof data === "object" && data !== null ? (data as Row).name : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 写入句子
// ---------------------------------------------------------------------------

export interface SentenceInput {
  book_id: number;
  paragraph: number;
  word_start: number;
  word_end: number;
  content: string;
  content_type?: string;
  channel_uid?: string;
}

const SENT_REQUIRED = ["book_id", "paragraph", "word_start", "word_end", "content"] as const;

function normalizeSentences(rows: Row[], channelUid: string | undefined, defaultContentType: string): Row[] {
  const out: Row[] = [];
  rows.forEach((row, idx) => {
    const missing = SENT_REQUIRED.filter((f) => row[f] == null);
    if (missing.length) throw new WpError(`第 ${idx + 1} 条缺字段：${missing.join(", ")}`);
    const sent: Row = {
      book_id: Math.trunc(Number(row.book_id)),
      paragraph: Math.trunc(Number(row.paragraph)),
      word_start: Math.trunc(Number(row.word_start)),
      word_end: Math.trunc(Number(row.word_end)),
      content: String(row.content),
      content_type: row.content_type || defaultContentType,
      channel_uid: row.channel_uid || channelUid,
    };
    if (!sent.channel_uid) throw new WpError(`第 ${idx + 1} 条没有 channel_uid，且未通过 channel 指定。`);
    out.push(sent);
  });
  return out;
}

export async function writeSentences(
  client: WikiClient,
  modelToken: string,
  userToken: string,
  args: {
    sentences: SentenceInput[];
    channel?: string;
    book?: number;
    batch: number;
    contentType: string;
    dryRun: boolean;
  },
): Promise<Row> {
  const raw: Row[] = args.sentences;

  let uid: string | undefined;
  let name: string | undefined;
  if (args.channel || !raw.some((r) => r.channel_uid)) {
    const resolved = await resolveChannel(client, userToken, args.channel);
    uid = resolved.uid;
    name = resolved.name;
  }
  const sentences = normalizeSentences(raw, uid, args.contentType);

  const channels = [...new Set(sentences.map((s) => s.channel_uid as string))];
  const books = [...new Set(sentences.map((s) => s.book_id as number))];
  const names: Record<string, string | undefined> = { [uid ?? ""]: name };
  for (const cuid of channels) {
    if (!(cuid in names)) names[cuid] = await channelDisplayName(client, userToken, cuid);
  }

  const preview = {
    api: client.apiNote(),
    channels: channels.map((c) => ({ uid: c, name: names[c] })),
    books,
    count: sentences.length,
    batch: args.batch,
    samples: sentences.slice(0, 5).map((s) => ({
      coord: `${s.book_id}-${s.paragraph}-${s.word_start}-${s.word_end}`,
      content: String(s.content).replace(/\n/g, " ").slice(0, 50),
      channel_uid: s.channel_uid,
    })),
    warning: "⚠ 相同位置（book/paragraph/word_start/word_end/channel）的已有句子将被覆盖。",
  };

  if (args.dryRun) return { dryRun: true, preview };

  // 瞬时签发 access token（每个 channel 一张，用 userToken 的人类授权）；modelToken 原样透传给写请求
  const tokens: Record<string, string> = {};
  for (const cuid of channels) {
    const bookScope = args.book ?? (books.length > 1 ? 0 : books[0]!);
    tokens[cuid] = (await grantAccessToken(client, userToken, cuid, bookScope)).token;
  }

  const written: Record<string, Row> = {};
  const failed: Row[] = [];
  for (let start = 0; start < sentences.length; start += args.batch) {
    const batch = sentences.slice(start, start + args.batch);
    const body = {
      sentences: batch.map((s) => ({
        book_id: s.book_id,
        paragraph: s.paragraph,
        word_start: s.word_start,
        word_end: s.word_end,
        channel_uid: s.channel_uid,
        content: s.content,
        content_type: s.content_type,
        access_token: tokens[s.channel_uid as string],
      })),
    };
    const data = await guarded("写入句子", async () =>
      client.call("POST", "v2/sentence", { token: modelToken, body, timeout: WRITE_TIMEOUT }),
    );
    const returned = rowsOf(data);
    for (const row of returned) {
      const ch = row.channel ?? {};
      written[[row.book, row.paragraph, row.word_start, row.word_end, ch.uid].join("|")] = row;
    }
    if (returned.length < batch.length) {
      for (const s of batch) {
        if (!([s.book_id, s.paragraph, s.word_start, s.word_end, s.channel_uid].join("|") in written)) failed.push(s);
      }
    }
  }

  const sample = Object.values(written)[0];
  const editor = sample?.editor?.nickName || sample?.editor?.name;
  return {
    dryRun: false,
    preview,
    submitted: sentences.length,
    written: Object.keys(written).length,
    failed: failed.slice(0, 10).map((s) => `${s.book_id}-${s.paragraph}-${s.word_start}-${s.word_end} channel=${String(s.channel_uid).slice(0, 8)}…`),
    failedCount: failed.length,
    editor,
    note: failed.length
      ? "⚠ 有句子未写入（服务端逐句鉴权失败会静默跳过），差集见 failed——不要声称「已全部写入」。"
      : "全部提交的句子都已被服务端确认。",
  };
}

// ---------------------------------------------------------------------------
// 术语（自己的术语表 v2/terms）
// ---------------------------------------------------------------------------

export async function myTerms(
  client: WikiClient,
  userToken: string,
  args: { channel?: string; studio?: string; keyword?: string; tag?: string; order: string; dir: string; limit: number; offset: number },
): Promise<Row> {
  let query: Row;
  let scope: string;
  if (args.channel) {
    const { uid, name } = await resolveChannel(client, userToken, args.channel);
    query = { view: "channel", id: uid };
    scope = `channel ${name ?? uid}`;
  } else if (args.studio) {
    query = { view: "studio", name: args.studio };
    scope = `studio ${args.studio}`;
  } else {
    query = { view: "user" };
    scope = "当前账号名下全部";
  }
  Object.assign(query, { search: args.keyword, order: args.order, dir: args.dir, offset: args.offset, limit: args.limit });
  const data = await guarded(`列出术语（${scope}）`, async () =>
    client.call("GET", "v2/terms", { token: userToken, query, timeout: READ_TIMEOUT }),
  );
  let rows = rowsOf(data);
  const total = (data as Row)?.count ?? rows.length;
  if (args.tag) {
    const tagLower = args.tag.toLowerCase();
    rows = rows.filter((r: Row) => String(r.tag ?? "").toLowerCase().includes(tagLower));
  }
  return {
    scope,
    total,
    rows: rows.map((r: Row) => ({
      guid: r.guid, word: r.word, meaning: r.meaning, other_meaning: r.other_meaning, tag: r.tag, channel: r.channel?.name ?? "",
    })),
    notes: ["改术语用完整 guid（wikipali_term_edit）。"],
  };
}

function termByGuid(client: WikiClient, userToken: string, guid: string): Promise<Row> {
  return guarded(`读取术语 ${guid}`, async () => {
    try {
      return (await client.call("GET", `v2/terms/${guid}`, { token: userToken, timeout: READ_TIMEOUT })) as Row;
    } catch (exc) {
      if (exc instanceof ApiError && (exc.status === 404 || String(exc).includes("没有查询到"))) {
        throw new WpError(`找不到术语 ${guid}。guid 要给完整的，用 wikipali_my_terms 查。`);
      }
      throw exc;
    }
  });
}

async function postAsModel(
  client: WikiClient,
  modelToken: string,
  method: string,
  path: string,
  body: Row,
  what: string,
): Promise<Row> {
  try {
    return (await client.call(method, path, { token: modelToken, body, timeout: WRITE_TIMEOUT })) as Row;
  } catch (exc) {
    if (exc instanceof ApiError && exc.status === 403) {
      throw new WpError(`${what}：403 无权限。人类账号对这个 channel 没有编辑权；access token 签给了别的 channel；或目标术语不属于任何 channel（AI 只能改 channel 内的术语）。`);
    }
    if (exc instanceof ApiError && exc.status === 200 && String(exc).includes("existed")) {
      throw new WpError(`${what}：该 channel 下已有同 word + tag 的术语。要改就用 wikipali_term_edit。`);
    }
    if (exc instanceof ApiError && exc.status === 401) {
      throw new WpError(`${what}：401 模型 token 失效或被撤销。请重新运行 wikipali_ensure_model 更新客户端侧的 modelToken。`);
    }
    throw explainApiError(exc as ApiError, what);
  }
}

export async function termAdd(
  client: WikiClient,
  modelToken: string,
  userToken: string,
  args: { word: string; meaning: string; channel?: string; other_meaning?: string; note?: string; tag?: string; language?: string; dryRun: boolean },
): Promise<Row> {
  const { uid, name } = await resolveChannel(client, userToken, args.channel);
  const body: Row = { word: args.word, meaning: args.meaning, channel: uid };
  for (const [field, value] of Object.entries({ other_meaning: args.other_meaning, note: args.note, tag: args.tag, language: args.language })) {
    if (value !== undefined) body[field] = value;
  }
  const preview = {
    api: client.apiNote(),
    channel: { uid, name },
    fields: { word: args.word, meaning: args.meaning, other_meaning: args.other_meaning, note: args.note, tag: args.tag, language: args.language },
    warning: "⚠ 同 channel 下 word + tag 相同的术语已存在时，服务端会拒绝而不是覆盖。",
  };
  if (args.dryRun) return { dryRun: true, preview };

  const access = await grantAccessToken(client, userToken, uid, TERM_BOOK);
  body.access_token = access.token;
  const saved = await postAsModel(client, modelToken, "POST", "v2/terms", body, "新建术语");
  return {
    dryRun: false,
    preview,
    guid: saved.guid, word: saved.word, meaning: saved.meaning,
    editor: saved.editor?.nickName || saved.editor?.name,
  };
}

const TERM_EDITABLE = ["meaning", "other_meaning", "note", "tag", "language"] as const;

export async function termEdit(
  client: WikiClient,
  modelToken: string,
  userToken: string,
  args: { guid: string; word?: string; meaning?: string; other_meaning?: string; note?: string; tag?: string; language?: string; dryRun: boolean },
): Promise<Row> {
  const old = await termByGuid(client, userToken, args.guid);
  const channelUid = old.channel_id || old.channal;
  if (!channelUid) {
    throw new WpError(`术语 ${args.guid}（${old.word}）不属于任何 channel，AI 改不了（access token 是 channel 级的）。这类术语只能由 studio 本人在网站上修改。`);
  }
  const channelName = old.channel?.name;

  const patch: Row = {};
  if (args.word !== undefined) patch.word = args.word;
  for (const field of TERM_EDITABLE) {
    const value = args[field];
    if (value !== undefined) patch[field] = value;
  }
  if (!Object.keys(patch).length) throw new WpError("没有要改的字段。");
  for (const [f, v] of Object.entries(patch)) {
    if ((old[f] ?? "") === (v ?? "")) delete patch[f];
  }
  if (!Object.keys(patch).length) throw new WpError("提交的字段与原值完全相同，无需修改。");

  const preview = {
    api: client.apiNote(),
    channel: { uid: channelUid, name: channelName },
    guid: args.guid,
    word: old.word,
    changes: patch,
  };
  if (args.dryRun) return { dryRun: true, preview };

  const access = await grantAccessToken(client, userToken, channelUid, TERM_BOOK);
  const body: Row = { ...patch, access_token: access.token };
  const saved = await postAsModel(client, modelToken, "PUT", `v2/terms/${args.guid}`, body, "修改术语");
  return {
    dryRun: false,
    preview,
    guid: saved.guid, word: saved.word, meaning: saved.meaning,
    editor: saved.editor?.nickName || saved.editor?.name,
  };
}

// ---------------------------------------------------------------------------
// 批注（discussion）
// ---------------------------------------------------------------------------

const RES_TYPE = "sentence";
const DISCUSS_TYPE = "discussion";

async function callAsModel(
  client: WikiClient,
  modelToken: string,
  method: string,
  path: string,
  what: string,
  opts: { body?: Row; query?: Row } = {},
): Promise<Row> {
  const callOpts: CallOptions = { token: modelToken, timeout: READ_TIMEOUT };
  if (opts.body !== undefined) callOpts.body = opts.body;
  if (opts.query !== undefined) callOpts.query = opts.query;
  try {
    return (await client.call(method, path, callOpts)) as Row;
  } catch (exc) {
    if (exc instanceof ApiError && exc.status === 401) {
      throw new WpError(`${what}：401 模型 token 失效或被撤销。请重新运行 wikipali_ensure_model 更新客户端侧的 modelToken。`);
    }
    throw explainApiError(exc as ApiError, what);
  }
}

async function resolveSentence(
  client: WikiClient,
  args: { coord?: string; sent?: string; channel?: string; words?: string },
): Promise<{ uid: string; desc: string }> {
  if (args.sent) return { uid: args.sent, desc: `句子 ${args.sent}` };
  if (!args.coord) throw new WpError("要么给坐标（如 216-35），要么用 sent 直接指定句子 uid。");

  const [book, para] = parseCoord(args.coord);
  // 讨论的 channel 缺省为巴利原文；要挂到某译本就给该 channel 的 uid（不做名字解析，避免需要 userToken）
  const channelUid = args.channel ?? PALI_CHANNEL;
  const channelName = args.channel ?? "巴利原文";
  const data = await guarded(`取 ${args.coord} 的句子`, async () =>
    client.call("GET", "v2/sentence", {
      query: { view: "paragraph", book: String(book), para: String(para), channels: channelUid, limit: 200 },
      timeout: READ_TIMEOUT,
    }),
  );
  let rows: Row[] = rowsOf(data);
  if (!rows.length) {
    throw new WpError(`${fmtCoord(book, para)} 在该 channel 下没有句子，无法批注——换个 channel，或先确认坐标。`);
  }
  if (args.words) {
    const [start, end] = args.words.split("-").map(Number);
    rows = rows.filter((r) => Number(r.word_start ?? -1) === start && Number(r.word_end ?? -1) === end);
    if (!rows.length) throw new WpError(`${fmtCoord(book, para)} 下没有 [${args.words}] 这一句。`);
  }
  if (rows.length > 1) {
    const lines = rows.map((r) => `--words ${r.word_start}-${r.word_end}  ${stripMarkup(r.content).slice(0, 60)}`);
    throw new WpError(`${fmtCoord(book, para)} 有 ${rows.length} 句，指明是哪一句再批注（或用 sent 直接给 uid）：\n${lines.join("\n")}`);
  }
  const row = rows[0]!;
  const ch = row.channel ?? {};
  const desc = `${fmtCoord(book, para)} [${row.word_start}-${row.word_end}] ${ch.name || channelName}\n${stripMarkup(row.content).slice(0, 100)}`;
  return { uid: row.id, desc };
}

export async function discussList(
  client: WikiClient,
  modelToken: string,
  args: { coord?: string; sent?: string; channel?: string; words?: string; status: string; limit: number; offset: number },
): Promise<Row> {
  const { uid, desc } = await resolveSentence(client, args);
  const data = await callAsModel(client, modelToken, "GET", "v2/discussion", "列出批注", {
    query: { view: "question", res_type: RES_TYPE, id: uid, type: DISCUSS_TYPE, status: args.status, limit: args.limit, offset: args.offset },
  });
  const rows = rowsOf(data);
  for (const row of rows) {
    if (row.children_count) {
      const replies = await callAsModel(client, modelToken, "GET", "v2/discussion", "取批注的回复", {
        query: { view: "answer", id: row.id, status: "active", limit: 200 },
      });
      row.replies = replies.rows ?? [];
    } else {
      row.replies = [];
    }
  }
  const who = (r: Row) => {
    const e = r.editor ?? {};
    const n = e.nickName || e.userName || "(未知)";
    return (e.roles ?? []).includes("ai") ? `${n}（AI）` : n;
  };
  return {
    target: desc,
    sentenceUid: uid,
    active: data.active ?? 0,
    close: data.close ?? 0,
    topics: rows.map((r) => ({
      id: r.id, title: r.title, author: who(r), status: r.status,
      createdAt: String(r.created_at ?? "").slice(0, 10), content: r.content,
      replies: (r.replies ?? []).map((reply: Row) => ({
        author: who(reply), createdAt: String(reply.created_at ?? "").slice(0, 10), content: reply.content,
      })),
    })),
    note: "回复某条用 wikipali_discuss_reply，参数 id 用 topics[].id。",
  };
}

async function readContent(args: { content?: string; content_file?: string }): Promise<string> {
  if (args.content_file) {
    const { readFile } = await import("node:fs/promises");
    try {
      return await readFile(args.content_file, "utf-8");
    } catch (exc) {
      throw new WpError(`读不了内容文件：${String(exc)}`);
    }
  }
  const content = args.content ?? "";
  if (!content.trim()) throw new WpError("批注内容为空。给 content 字段。");
  return content;
}

export async function discussAdd(
  client: WikiClient,
  modelToken: string,
  args: { coord?: string; sent?: string; channel?: string; words?: string; title: string; content?: string; content_file?: string; contentType: string; notify: boolean; dryRun: boolean },
): Promise<Row> {
  const { uid, desc } = await resolveSentence(client, args);
  const content = await readContent(args);
  const body: Row = { res_id: uid, res_type: RES_TYPE, type: DISCUSS_TYPE, title: args.title, content, content_type: args.contentType, notification: args.notify };
  const preview = { api: client.apiNote(), target: desc, sentenceUid: uid, title: args.title, content, notify: args.notify };
  if (args.dryRun) return { dryRun: true, preview };

  const saved = await callAsModel(client, modelToken, "POST", "v2/discussion", "新建批注", { body });
  return { dryRun: false, preview, id: saved.id, editor: saved.editor?.nickName || saved.editor?.userName };
}

export async function discussReply(
  client: WikiClient,
  modelToken: string,
  args: { id: string; content?: string; content_file?: string; contentType: string; notify: boolean; dryRun: boolean },
): Promise<Row> {
  const content = await readContent(args);
  const body: Row = { parent: args.id, content, content_type: args.contentType, notification: args.notify };
  const preview = { api: client.apiNote(), replyTo: args.id, content, notify: args.notify };
  if (args.dryRun) return { dryRun: true, preview };

  const saved = await callAsModel(client, modelToken, "POST", "v2/discussion", "回复批注", { body });
  return { dryRun: false, preview, id: saved.id, editor: saved.editor?.nickName || saved.editor?.userName };
}
