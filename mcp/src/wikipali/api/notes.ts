/**
 * 注释书对应（commentary）：把义注 / 复注的句子挂到上一层译文句子的某个位置上（对应插件 lib/cmd_notes.py）。
 *
 * 一条对应 = 一条 `type='commentary'` 的 discussion：
 *  - target：上一层某句**译文**的 uid，加锚点 pos_start / pos_end / quote_exact / quote_prefix / quote_suffix；
 *  - content：下一层（义注 / 复注）句子的模板 `{{book-para-start-end}}`，不是译文本身；
 *    一个片段由多句解释时并列多个模板 `{{…}}{{…}}`，仍是一条记录。
 *
 * 字符位由服务端在译文句子的原始 content 第 pos_end 个字符处插入，所以位置只由本工具对着
 * 原始 content 数（anchors.ts），模型只给 quote_exact（原样摘录）。
 */

import { ApiError, WpError, explainApiError } from "../errors.ts";
import type { WikiClient } from "../client.ts";
import { READ_TIMEOUT } from "../client.ts";
import { v3Layer } from "../coords.ts";
import { rowText } from "../markup.ts";
import { anchor } from "../anchors.ts";
import { fetchRelatedCs, paliChannel } from "./read.ts";
import { callAsAgent, callAsModel, modelUidOf, resolveDiscussChannel, who } from "./discuss.ts";
import type { WriteCreds } from "./discuss.ts";

type Row = Record<string, any>;
type Sid = [number, number, number, number];

const COMMENTARY_TYPE = "commentary";
const LAYERS: [string, string][] = [["mūla", "根本"], ["aṭṭhakathā", "义注"], ["ṭīkā", "复注"]];
const LAYER_ALIAS: Record<string, string> = {
  mula: "mūla", mūla: "mūla", pāḷi: "mūla", pali: "mūla",
  att: "aṭṭhakathā", aṭṭhakathā: "aṭṭhakathā", atthakatha: "aṭṭhakathā",
  tika: "ṭīkā", ṭīkā: "ṭīkā",
};

function sidOf(row: Row): string {
  return `${row.book}-${row.paragraph}-${row.word_start}-${row.word_end}`;
}

function parseSid(text: unknown): Sid {
  let raw = String(text ?? "").trim();
  if (raw.startsWith("{{") && raw.endsWith("}}")) raw = raw.slice(2, -2);
  const parts = raw.split("-");
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) {
    throw new WpError(`「${String(text)}」不是句子坐标，应为 book-para-start-end，如 101-513-2-23`);
  }
  return parts.map(Number) as Sid;
}

function cmpSid(a: Sid, b: Sid): number {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

async function fetchSentences(client: WikiClient, book: number, paras: number[], channels: string[]): Promise<Row[]> {
  try {
    const data = await client.call("GET", "v2/sentence", {
      query: { view: "paragraph", book, para: paras.join(","), channels: channels.join(","), limit: 1000 },
      timeout: READ_TIMEOUT,
    });
    return (data as Row)?.rows ?? [];
  } catch (exc) {
    if (exc instanceof ApiError) throw explainApiError(exc, `取 ${book} 的句子`);
    throw exc;
  }
}

function channelOf(row: Row): string | undefined {
  return row.channel?.id ?? row.channel?.uid;
}

// ---------------------------------------------------------------------------
// note-context
// ---------------------------------------------------------------------------

/** (book_name, cs_para) → [{layer, book, title, paras}]，按 根本→义注→复注 排序；与 related_cs 同源。 */
async function locate(client: WikiClient, bookName: string, csPara: number): Promise<Row[]> {
  const found: Row[] = [];
  for (const r of await fetchRelatedCs(client, bookName, csPara)) {
    const paras = ((r.para ?? []) as unknown[]).map(Number).sort((a, b) => a - b);
    if (paras.length) found.push({ layer: v3Layer(r.tags) || null, book: Number(r.book), title: r.title, paras });
  }
  const order = Object.fromEntries(LAYERS.map(([name], i) => [name, i]));
  return found.sort((a, b) => (order[a.layer] ?? 9) - (order[b.layer] ?? 9) || a.book - b.book);
}

export async function noteContext(
  client: WikiClient,
  args: { book_name: string; cs_para: number; channel: string; layers?: string },
  userToken?: string,
): Promise<Row> {
  const pali = await paliChannel(client);
  const { uid: channelUid, name: channelName } = await resolveDiscussChannel(client, args.channel, userToken);
  if (channelUid === pali) throw new WpError("要给 channel（译文所在的版本）：对应挂在译文句子上，位置按译文数。");
  let wanted: string[] | undefined;
  if (args.layers) {
    wanted = args.layers.split(",").map((n) => {
      const key = LAYER_ALIAS[n.trim()];
      if (!key) throw new WpError(`不认识的层次：${n}（可用 mula / att / tika）`);
      return key;
    });
  }

  let located = await locate(client, args.book_name, args.cs_para);
  if (wanted) located = located.filter((e) => wanted!.includes(e.layer));
  const layers: Row[] = [];
  for (const entry of located) {
    const bySid = new Map<string, Row>();
    for (const r of await fetchSentences(client, entry.book, entry.paras, [pali, channelUid])) {
      const sid = sidOf(r);
      if (!bySid.has(sid)) bySid.set(sid, { sid, pali: null, translation: null, translation_uid: null });
      const item = bySid.get(sid)!;
      if (channelOf(r) === pali) item.pali = rowText(r);
      else if (channelOf(r) === channelUid) {
        item.translation = r.content ?? "";
        item.translation_uid = r.id;
      }
    }
    const sentences = [...bySid.values()].sort((a, b) => cmpSid(parseSid(a.sid), parseSid(b.sid)));
    layers.push({ ...entry, label: Object.fromEntries(LAYERS)[entry.layer] ?? entry.layer ?? "未标层次", sentences });
  }

  const missing = layers.slice(0, -1).flatMap((l) => l.sentences.filter((s: Row) => s.translation === null).map((s: Row) => s.sid));
  return {
    book_name: args.book_name,
    cs_para: args.cs_para,
    channel: { uid: channelUid, name: channelName },
    layers,
    notes: [
      layers.length
        ? "translation 是译文的原始 content（锚点按它数）；pali 保留黑体 **…**——黑体是被解释词的唯一线索，不要用 ti / nti 找被解释词。"
        : "各层都没有这个锚点下的正文段。这是正常结果（约 2% 的段落没有 CST 锚点），不要拿相邻段落凑。",
      ...(missing.length
        ? [`⚠ 上层有 ${missing.length} 句在该 channel 没有译文，这些句子上挂不了对应：${missing.slice(0, 8).join(" ")}${missing.length > 8 ? " …" : ""}`]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// note-push
// ---------------------------------------------------------------------------

export interface NoteItem {
  target: string;
  note: string | string[];
  quote_exact?: string;
  quote_prefix?: string;
  quote_suffix?: string;
}

function noteList(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** 校验 note 的每一句都是真实存在的单句，按原顺序去重。只校验、不改写：不合并成区间，也不拆成多条。 */
function noteSentences(values: unknown[], known: Set<string>): Sid[] {
  if (!values.length) throw new WpError("缺 note");
  const out: Sid[] = [];
  for (const value of values) {
    const sid = parseSid(value);
    const key = sid.join("-");
    if (!known.has(key)) throw new WpError(`${key} 不是一个真实句子（note 只能列单句，不能写区间；多句就列成数组）`);
    if (!out.some((o) => o.join("-") === key)) out.push(sid);
  }
  return out;
}

export async function notePush(
  client: WikiClient,
  creds: WriteCreds,
  args: { items: NoteItem[]; channel: string; replace: boolean; dryRun: boolean },
): Promise<Row> {
  modelUidOf(creds.modelToken);
  const pali = await paliChannel(client);
  const { uid: channelUid, name: channelName } = await resolveDiscussChannel(client, args.channel, creds.userToken);
  if (channelUid === pali) throw new WpError("要给 channel：对应挂在该 channel 的译文句子上。");
  if (!args.items.length) throw new WpError("items 为空：每条 {target, note, quote_exact}。");

  // 按 target 所在段批量取译文，按 note 所在段批量确认句子存在
  const need = new Map<string, Set<number>>();
  for (const it of args.items) {
    for (const key of ["target", "note"] as const) {
      for (const value of noteList(it[key])) {
        let sid: Sid;
        try {
          sid = parseSid(value);
        } catch {
          continue;
        }
        const k = `${key}|${sid[0]}`;
        if (!need.has(k)) need.set(k, new Set());
        need.get(k)!.add(sid[1]);
      }
    }
  }
  const targets = new Map<string, Row>();
  const notes = new Set<string>();
  for (const [k, paras] of need) {
    const [key, book] = k.split("|") as [string, string];
    const rows = await fetchSentences(client, Number(book), [...paras].sort((a, b) => a - b), [key === "target" ? channelUid : pali]);
    for (const r of rows) {
      if (key === "target") targets.set(sidOf(r), r);
      else notes.add(sidOf(r));
    }
  }

  const plan: Row[] = [];
  const problems: Row[] = [];
  const existing = new Map<string, Row[]>();
  for (const [idx, it] of args.items.entries()) {
    const n = idx + 1;
    try {
      if (Array.isArray(it.target)) throw new WpError("target 只能是一句（上一层的一个句子坐标），不能是列表");
      const tsid = parseSid(it.target).join("-");
      const row = targets.get(tsid);
      if (!row) throw new WpError(`target ${tsid} 在该 channel 没有译文句子`);
      const runs = noteSentences(noteList(it.note), notes);
      const [start, end, pre, suf] = anchor(String(row.content ?? ""), it);
      if (!existing.has(row.id)) {
        existing.set(row.id, ((await callAsModel(client, creds.modelToken, "GET", "v3/discussions", "列出已有对应", {
          query: { target_type: "sentence", target_id: row.id, type: COMMENTARY_TYPE, per_page: 200 },
        })) ?? []) as Row[]);
      }
      const tpl = runs.map((s) => `{{${s.join("-")}}}`).join("");
      const body: Row = { target_id: row.id, target_type: "sentence", type: COMMENTARY_TYPE, content: tpl, notify: false };
      if (start != null) Object.assign(body, { pos_start: start, pos_end: end, quote_exact: it.quote_exact, quote_prefix: pre, quote_suffix: suf });
      const dup = existing.get(row.id)!.filter((e) => String(e.content ?? "").trim() === tpl);
      // 写入授权按 (channel, book) 划范围：target 句子在 channel 里、book 取自坐标
      plan.push({ n, target: tsid, body, dup, notes: runs, scope: [channelUid, Number(tsid.split("-")[0])] });
    } catch (exc) {
      if (!(exc instanceof WpError)) throw exc;
      problems.push({ n, target: it.target, note: it.note, error: exc.message });
    }
  }

  // 覆盖率：下一层这些段里，没有被任何一条对应引到的句子
  const covered = new Set(plan.flatMap((p) => (p.notes as Sid[]).map((s) => s.join("-"))));
  const uncovered = [...notes].filter((s) => !covered.has(s)).sort((a, b) => cmpSid(parseSid(a), parseSid(b)));
  const todo = plan.filter((p) => !p.dup.length || args.replace);
  const summary = {
    api: client.apiNote(),
    modelUid: modelUidOf(creds.modelToken),
    channel: { uid: channelUid, name: channelName },
    plan: plan.map((p) => ({
      n: p.n,
      action: p.dup.length && !args.replace ? "已存在，跳过" : p.dup.length ? "替换" : "新增",
      target: p.target,
      anchor: p.body.pos_start == null ? "整句" : `[${p.body.pos_start}-${p.body.pos_end}] 「${p.body.quote_exact}」`,
      content: p.body.content,
    })),
    problems,
    uncovered,
    counts: { writable: todo.length, skipped: plan.length - todo.length, problems: problems.length, uncovered: uncovered.length },
    notes: [
      uncovered.length
        ? `⚠ 下一层有 ${uncovered.length} 句没有进任何一条对应。只有「段落第一个黑体之前的引子」允许不挂（那几句该挂在章节标题句上）；其余是漏了，补进对应的 note 数组。`
        : "下一层句子全部覆盖。",
      "写入署名为授权人（X-Wikipali-User-Token 的账号），模型记为协作者。",
    ],
  };
  if (args.dryRun || !todo.length) return { dryRun: args.dryRun, ...summary, ...(todo.length ? {} : { note: "没有要写的。" }) };

  const written: Row[] = [];
  for (const p of todo) {
    for (const old of p.dup) {
      await callAsAgent(client, creds, "DELETE", `v3/discussions/${old.id}`, "删除旧对应", p.scope);
    }
    const saved = await callAsAgent(client, creds, "POST", "v3/discussions", "写入对应", p.scope, p.body);
    written.push({ n: p.n, id: saved?.id, author: who(saved ?? {}) });
  }
  return { dryRun: false, ...summary, written };
}
