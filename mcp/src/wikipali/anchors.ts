/**
 * 批注锚点：按原文摘录在句子原始 content 里定位，算出 pos_start / pos_end 与前后缀（对应插件 lib/anchors.py）。
 *
 * 锚点是 W3C Web Annotation 的 TextPosition（`pos_start` / `pos_end`）+ TextQuote
 * （`quote_exact` / `quote_prefix` / `quote_suffix`）。位置按句子**原始 content** 的字符计
 * （0 起、含标点、`pos_end` 不含），与服务端 `mb_strlen` 同一口径——即 Unicode 码点，
 * 不是 JS 字符串的 UTF-16 下标，所以这里一律先展开成码点数组再数。
 *
 * 位置交给程序算，不让模型数：模型数中文字符位极易数错，而摘录（原样抄一段文字）很少出错。
 */

import { WpError } from "./errors.ts";

// 前后缀取多长：设计文档建议 32~64 字符
const CONTEXT_CHARS = 32;

// 外挂术语渲染成 `[[词头#原文]]`：原文与词头里有这些字符会把标记拆坏，服务端会直接放弃这条
// （api-v13 AnnotationLayout::GLOSSARY_FORBIDDEN）
const GLOSSARY_FORBIDDEN = /[[\]{}|#\r\n]/;
// 句子里已有的标记：模板、术语、行内注释、粗体、HTML 标签（AnnotationLayout::PROTECTED_PATTERN）。
// 外挂术语碰到它们，服务端也会放弃这条
const PROTECTED = /\[\[.*?\]\]|\{\{.*?\}\}|`[^`]*`|\*\*.+?\*\*|<[^<>]+>/gs;

export interface AnchorItem {
  quote_exact?: string | null;
  quote_prefix?: string | null;
  quote_suffix?: string | null;
}

export type Located = [number | null, number | null, string | null, string | null];

function chars(text: string): string[] {
  return Array.from(text);
}

function joinRange(cs: string[], start: number, end: number): string {
  return cs.slice(Math.max(0, start), Math.max(0, end)).join("");
}

/** 码点下标版的 indexOf：在 cs 里从 from 起找 needle（同为码点数组）。 */
function indexOfChars(cs: string[], needle: string[], from: number): number {
  outer: for (let i = from; i + needle.length <= cs.length; i++) {
    for (let j = 0; j < needle.length; j++) if (cs[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** pos 是否落在 {{…}} 或 [[…]] 里面——在那里插入会把模板劈开。 */
function inTemplate(cs: string[], pos: number): boolean {
  const before = cs.slice(0, pos).join("");
  const after = cs.slice(pos).join("");
  for (const [open, close] of [["{{", "}}"], ["[[", "]]"]] as const) {
    const start = before.lastIndexOf(open);
    if (start !== -1 && before.indexOf(close, start) === -1 && after.indexOf(close) !== -1) return true;
  }
  return false;
}

/**
 * 在句子原文里定位 quote_exact，返回 [pos_start, pos_end, prefix, suffix]。
 *
 * 摘录出现多次时用给的 prefix / suffix 消歧；仍不唯一就报错，不猜。
 * 不给 quote_exact ＝ 整句挂（四项都返回 null）。
 */
export function anchor(text: string, item: AnchorItem): Located {
  const exact = item.quote_exact ?? "";
  if (!exact) return [null, null, null, null];
  const cs = chars(text);
  const ex = chars(exact);
  let hits: number[] = [];
  for (let i = indexOfChars(cs, ex, 0); i !== -1; i = indexOfChars(cs, ex, i + 1)) hits.push(i);
  if (!hits.length) throw new WpError(`quote_exact「${exact}」不在该句原文里（必须原样摘录，含标点）`);
  if (hits.length > 1) {
    const pre = item.quote_prefix ?? "";
    const suf = item.quote_suffix ?? "";
    hits = hits.filter((h) => joinRange(cs, 0, h).endsWith(pre) && joinRange(cs, h + ex.length, cs.length).startsWith(suf));
    if (hits.length !== 1) throw new WpError(`quote_exact「${exact}」在句中出现多次，前后缀也无法唯一确定`);
  }
  const start = hits[0]!;
  const end = start + ex.length;
  if (inTemplate(cs, end)) throw new WpError(`「${exact}」的结束位落在模板 / 链接内部，插入会破坏它；换个摘录范围`);
  return [start, end, joinRange(cs, start - CONTEXT_CHARS, start), joinRange(cs, end, end + CONTEXT_CHARS)];
}

/** 句子原文在码点区间 [start, end) 上的文字。 */
export function sliceChars(text: string, start: number, end: number): string {
  return joinRange(chars(text), start, end);
}

/** 外挂术语能不能渲染成 `[[词头#原文]]`；不能就报错（服务端会静默放弃这条）。 */
export function checkGlossary(text: string, start: number | null | undefined, end: number | null | undefined, title: string | null | undefined): void {
  const word = (title ?? "").trim();
  if (!word) throw new WpError("外挂术语要给 title：术语的词头（巴利词，如 bhikkhu）。");
  if (GLOSSARY_FORBIDDEN.test(word)) throw new WpError(`词头「${word}」里不能有 [ ] { } | # 或换行。`);
  if (start == null || end == null) throw new WpError("外挂术语要指明挂在译文的哪一段：给 quote_exact（原样摘录）。");
  const covered = sliceChars(text, start, end);
  if (GLOSSARY_FORBIDDEN.test(covered)) {
    throw new WpError(`摘录「${covered}」里有 [ ] { } | # 或换行，渲染不了外挂术语；换个摘录范围。`);
  }
  // PROTECTED 的 match 下标是 UTF-16 的，换算成码点再比重叠
  for (const m of text.matchAll(PROTECTED)) {
    const mStart = chars(text.slice(0, m.index)).length;
    const mEnd = mStart + chars(m[0]).length;
    if (mStart < end && start < mEnd) {
      throw new WpError(`摘录「${covered}」与句中已有的标记「${m[0]}」重叠，外挂术语不能套在已有术语 / 模板 / 格式上；换个摘录范围。`);
    }
  }
}
