/**
 * 站点清单与地址解析（对应插件 lib/sites.py）。
 *
 * 四个线上地址共享同一个数据库和同一把 jwt 密钥，凭据完全通用；
 * .org / .cc 是地区可达性，www / next 是代码版本（不是数据环境）。
 * staging 与开发机 local 各是另一个库、另一把密钥，自成一桶，且绝不参与自动 fallback。
 */

import { WpError } from "./errors.ts";

export interface SiteDef {
  key: string;
  url: string;
  version: string;
  domain: string;
  bucket: string;
}

export const SITES: SiteDef[] = [
  { key: "www", url: "https://www.wikipali.org/api", version: "稳定版", domain: ".org", bucket: "online" },
  { key: "www.cc", url: "https://www.wikipali.cc/api", version: "稳定版", domain: ".cc", bucket: "online" },
  { key: "next", url: "https://next.wikipali.org/api", version: "最新版", domain: ".org", bucket: "online" },
  { key: "next.cc", url: "https://next.wikipali.cc/api", version: "最新版", domain: ".cc", bucket: "online" },
  { key: "staging", url: "https://staging.wikipali.org/api", version: "预发布", domain: "独立库", bucket: "staging" },
  { key: "local", url: "http://127.0.0.1:8000/api", version: "开发机", domain: "独立库", bucket: "local" },
];

export const ONLINE_URLS: string[] = SITES.filter((s) => s.bucket === "online").map((s) => s.url);
export const LOCAL_URL: string = SITES.find((s) => s.key === "local")!.url;
export const DEFAULT_API_URL: string = SITES[0]!.url;

export function normalizeApiUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WpError(`API 地址无法解析：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WpError(`API 地址必须以 http:// 或 https:// 开头：${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "http:" && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new WpError(`只有 127.0.0.1 / localhost 允许用 http://，其余必须 https://：${url}`);
  }
  return trimmed;
}

export function expandSiteAlias(value: string): string {
  const v = value.trim();
  if (/^\d+$/.test(v)) {
    const idx = Number(v) - 1;
    if (idx >= 0 && idx < SITES.length) return SITES[idx]!.url;
    throw new WpError(`站点序号超出范围：${value}（可选 1-${SITES.length}）`);
  }
  const site = SITES.find((s) => s.key === v);
  if (site) return site.url;
  if (v.includes("://")) return v;
  throw new WpError(
    `无法识别的站点：${value}。可用简称：${SITES.map((s) => s.key).join(" / ")}，或直接给完整 url`,
  );
}

export function siteLabel(apiUrl: string): string {
  const site = SITES.find((s) => s.url === apiUrl);
  return site ? `${site.version} · ${site.domain}` : "自定义地址";
}
