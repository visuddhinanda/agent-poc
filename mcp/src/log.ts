/**
 * 结构化运行日志：一行一条，带上游传来的 request id（X-Request-Id）。
 *
 * 工具层把 request id 放进 AsyncLocalStorage，下游的 WikiPali HTTP 请求日志就能自动带上，
 * 不必层层传参。backend 用 AG-UI 的 run_id 作 request id，四层日志用同一个 id 对得上。
 * MCP_LOG=0 关闭。
 */

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<{ rid: string }>();
const enabled = process.env.MCP_LOG !== "0";

export function withRequestId<T>(rid: string | undefined, fn: () => Promise<T>): Promise<T> {
  return store.run({ rid: rid || "-" }, fn);
}

export function currentRequestId(): string {
  return store.getStore()?.rid ?? "-";
}

/** 截断长字符串，日志里只要看得出是什么。 */
export function brief(value: unknown, max = 200): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return "";
  return text.length > max ? `${text.slice(0, max)}…(${text.length})` : text;
}

export function log(tag: string, fields: Record<string, unknown>): void {
  if (!enabled) return;
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" && !/\s/.test(v) ? v : brief(v)}`);
  console.log(`${new Date().toISOString()} [${tag}] rid=${currentRequestId()} ${parts.join(" ")}`);
}
