/**
 * 无状态 HTTP 客户端：JSON 请求、线上站点之间出声的 fallback（对应 lib/client.py 的去凭据部分）。
 *
 * 凭据由客户端经 HTTP Authorization 头提供，server 不落任何 token——
 * 这里只做「按 apiUrl 发请求」与「网络不可达时在线上四站间 fallback」。
 */

import { WpError } from "./errors.ts";
import { ApiError } from "./errors.ts";
import { DEFAULT_API_URL, ONLINE_URLS, SITES, siteLabel } from "./sites.ts";

export const DEFAULT_TIMEOUT = 30_000;
export const WRITE_TIMEOUT = 120_000;
export const READ_TIMEOUT = 60_000;
export const DEFAULT_BATCH = 50;

export interface CallOptions {
  token?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  timeout?: number;
}

/** 路径里可能有巴利词（parivāsa），先按段百分号编码，保留 "/"。 */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

async function httpJson(
  apiUrl: string,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<unknown> {
  let url = `${apiUrl}/${encodePath(path)}`;
  const query = opts.query;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "wikipali-mcp",
  };
  let data: string | undefined;
  if (opts.body !== undefined) {
    data = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? DEFAULT_TIMEOUT);
  const init: RequestInit = { method, headers, signal: controller.signal };
  if (data !== undefined) init.body = data;
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }

  const raw = await resp.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = raw;
  }
  const status = resp.status;

  if (!resp.ok) {
    const message =
      typeof payload === "object" && payload !== null && "message" in payload
        ? String((payload as Record<string, unknown>).message)
        : `HTTP ${status}`;
    throw new ApiError(status, message || `HTTP ${status}`, url, payload || raw);
  }
  if (typeof payload !== "object" || payload === null) {
    throw new ApiError(status, `响应不是 JSON：${raw.slice(0, 200)}`, url, raw);
  }
  const obj = payload as Record<string, unknown>;
  if (obj.ok !== true) {
    throw new ApiError(status, typeof obj.message === "string" ? obj.message : "请求失败", url, payload);
  }
  return obj.data;
}

export class WikiClient {
  apiUrl: string;
  allowFallback: boolean;

  constructor(apiUrl: string, allowFallback = true) {
    this.apiUrl = apiUrl;
    this.allowFallback = allowFallback && ONLINE_URLS.includes(apiUrl);
  }

  private fallbackOrder(): string[] {
    const cur = SITES.find((s) => s.url === this.apiUrl);
    if (!cur) return [];
    return SITES.filter((s) => s.key !== "local" && s.url !== this.apiUrl)
      .sort((a, b) => {
        const av = a.version === cur.version ? 0 : 1;
        const bv = b.version === cur.version ? 0 : 1;
        if (av !== bv) return av - bv;
        const ad = a.domain === cur.domain ? 0 : 1;
        const bd = b.domain === cur.domain ? 0 : 1;
        return ad - bd;
      })
      .map((s) => s.url);
  }

  async call(method: string, path: string, opts: CallOptions = {}): Promise<unknown> {
    const urls = [this.apiUrl, ...(this.allowFallback ? this.fallbackOrder() : [])];
    let last: unknown = null;
    for (let idx = 0; idx < urls.length; idx++) {
      const url = urls[idx]!;
      try {
        const data = await httpJson(url, method, path, opts);
        if (url !== this.apiUrl) {
          this.apiUrl = url; // fallback 成功后本次请求内沿用，不落盘
        }
        return data;
      } catch (exc) {
        if (exc instanceof ApiError) throw exc; // HTTP 错误是服务端的明确答复，不换站
        last = exc;
        if (idx + 1 < urls.length) {
          console.error(`⚠ ${url} 连接失败（${String(exc)}），改用 ${urls[idx + 1]}`);
        }
      }
    }
    throw new WpError(`所有可用站点都连不上，最后一次错误：${String(last)}`);
  }

  apiNote(): string {
    return `${this.apiUrl}（${siteLabel(this.apiUrl)}）`;
  }
}

/** 无状态客户端工厂：站点地址只来自环境变量 WIKIPALI_API_URL，不读任何本地凭据文件。 */
export function makeClient(): WikiClient {
  const url = process.env.WIKIPALI_API_URL?.trim() || DEFAULT_API_URL;
  return new WikiClient(url);
}
