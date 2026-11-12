/**
 * AI 回答的评价与主动询问（与 mobile src/ai/feedback.ts 同一套规则，改概率时两边一起改）：
 *
 * - 点踩按 DOWNVOTE_FORM_RATE 的概率弹出原因表单（内测期 100%）；
 * - 用户没评价的回答，按 ASK_RATE 的概率问一句「这个回答有帮助吗？」；
 * - beta 角色两项都固定 100%。
 *
 * 每条回答问不问由消息 id 的哈希决定（不是每次随机）：同一条回答在任何设备上结果一致。
 */
export const DOWNVOTE_FORM_RATE = 1;
export const ASK_RATE = 0.2;
export const BETA_ROLE = "beta";

export const UP_TAGS = ["accurate", "useful_citations", "clear", "inspiring"] as const;
export const DOWN_REASONS = ["citation_wrong", "missed", "off_topic", "incorrect", "too_long", "too_academic", "slow", "other"] as const;
export type FeedbackTag = (typeof UP_TAGS)[number] | (typeof DOWN_REASONS)[number];

export const TAG_LABELS: Record<FeedbackTag, string> = {
  accurate: "准确",
  useful_citations: "出处有用",
  clear: "讲得清楚",
  inspiring: "有启发",
  citation_wrong: "出处不对 / 引用不存在",
  missed: "其实有经文，它说没找到",
  off_topic: "答非所问",
  incorrect: "内容有错",
  too_long: "太长",
  too_academic: "太学术",
  slow: "太慢",
  other: "其他",
};

/** FNV-1a 32 位哈希 → [0, 1)，与 mobile 一致。 */
export function sampleOf(key: string, salt: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${salt}:${key}`) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

export const shouldShowDownvoteForm = (messageId: string, beta: boolean) =>
  beta || sampleOf(messageId, "down") < DOWNVOTE_FORM_RATE;

export const shouldAsk = (messageId: string, beta: boolean) => beta || sampleOf(messageId, "ask") < ASK_RATE;

/** 本浏览器记住自己评过哪些回答（键带 agent/ 前缀，不和 dashboard-v6 冲突）。 */
const STORE_KEY = "agent/ratings";
const MAX_ENTRIES = 500;

export function loadRatings(): Record<string, 1 | -1> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveRating(messageId: string, rating: 1 | -1 | null): void {
  const ratings = loadRatings();
  if (rating === null) delete ratings[messageId];
  else ratings[messageId] = rating;
  const keys = Object.keys(ratings);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete ratings[k];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(ratings));
  } catch {
    // 存不进去只影响刷新后的按钮状态
  }
}
