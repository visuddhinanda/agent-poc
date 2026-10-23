/**
 * 坐标与引用（对应 lib/coords.py）。
 *
 * WikiPali 的最小可引用单位是 (book, paragraph)，句子再细分 word_start/word_end。
 * 坐标书写形式统一为 `book-paragraph`（横杠），例如 `216-35`；解析时冒号/下划线也接受。
 */

import { WpError } from "./errors.ts";

const COORD_RE = /^\s*(\d+)\s*[-:_]\s*(\d+)\s*$/;

export function parseCoord(text: string | number): [number, number] {
  const m = COORD_RE.exec(String(text));
  if (!m) {
    throw new WpError(`坐标格式不对：${text}（应为 book-paragraph，如 216-35）`);
  }
  return [Number(m[1]), Number(m[2])];
}

/** 解析一串坐标，按 book 分组，返回 {book: [paragraph, ...]}（去重、保序）。 */
export function parseCoords(items: string[]): Record<number, number[]> {
  const grouped: Record<number, number[]> = {};
  for (const item of items) {
    for (const part of String(item).split(",")) {
      if (!part.trim()) continue;
      const [book, para] = parseCoord(part);
      const paras = (grouped[book] ??= []);
      if (!paras.includes(para)) paras.push(para);
    }
  }
  return grouped;
}

export function fmtCoord(book: number | undefined, paragraph: number | undefined): string {
  return `${book}-${paragraph}`;
}

// 检索结果 ref[].type → 显示名；WP 另行处理（它的 page 就是段落号）
const REF_EDITIONS: [string, string][] = [["My", "缅"], ["PTS", "PTS"], ["VRI", "VRI"], ["Thai", "泰"]];

/**
 * 出处 = citation + WikiPali 链接，合成一个 Markdown 链接（对应插件 coords.fmt_cite）：
 *
 *     [dī.ni.ṭī.2. 186-1411; 缅 dī-ṭī 2 p.340; PTS DnT II p.429](https://…/read#1411)
 *
 * citation 与链接**全部取自服务端**（检索结果的 ref / link）：WP 缩写 + 坐标，再加该段真有的
 * 印本页码。没有链接时只给 citation 文字——不自己拼链接、不自己编缩写。
 */
export function fmtCite(book: unknown, paragraph: unknown, refs: unknown, link?: unknown): string {
  const byType = new Map<string, Record<string, any>>();
  for (const r of Array.isArray(refs) ? refs : []) {
    if (typeof r === "object" && r !== null) byType.set(String((r as Record<string, any>).type), r as Record<string, any>);
  }
  const wp = byType.get("WP");
  const head = wp?.title ? `${wp.title} ` : "";
  const parts = [`${head}${fmtCoord(book as number, paragraph as number)}`];
  for (const [key, label] of REF_EDITIONS) {
    const r = byType.get(key);
    if (r && r.page != null) parts.push(`${label}${r.title ? ` ${r.title}` : ""} p.${r.page}`);
  }
  const text = parts.join("; ");
  return typeof link === "string" && link ? `[${text}](${link})` : text;
}

export interface PathItem {
  book?: number | string;
  paragraph?: number | string;
  title?: string;
  level?: number | string;
}

export function fmtPath(path: unknown, sep = " › ", maxItems = 4): string {
  if (!Array.isArray(path)) return "";
  const titles = path
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => p.title)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  if (titles.length > maxItems) {
    return [titles[0]!, "…", ...titles.slice(-(maxItems - 2))].join(sep);
  }
  return titles.join(sep);
}

export interface TagItem {
  name?: string;
}

/** v3 的 tags 是字符串数组（不是 v2 的 {id,name,color} 对象数组）；复注类都并入 ṭīkā。 */
export function v3Layer(tags: unknown): "" | "mūla" | "aṭṭhakathā" | "ṭīkā" {
  const names = new Set((Array.isArray(tags) ? tags : []).map(String));
  if (["ṭīkā", "mūlaṭīkā", "anuṭīkā"].some((t) => names.has(t))) return "ṭīkā";
  if (names.has("aṭṭhakathā")) return "aṭṭhakathā";
  if (names.has("mūla") || names.has("pāḷi")) return "mūla";
  return "";
}

/** 按 tags 判断文献层次：根本 / 义注 / 复注。 */
export function textLayer(tags: unknown): "" | "mūla" | "aṭṭhakathā" | "ṭīkā" {
  const names = new Set(
    (Array.isArray(tags) ? tags : [])
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => (t as TagItem).name)
      .filter((n): n is string => typeof n === "string"),
  );
  if (names.has("ṭīkā")) return "ṭīkā";
  if (names.has("aṭṭhakathā")) return "aṭṭhakathā";
  if (names.has("mūla")) return "mūla";
  return "";
}
