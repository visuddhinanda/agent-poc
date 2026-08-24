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

/** 按 tags 判断文献层次：本文 / 义注 / 复注。 */
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
