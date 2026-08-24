/**
 * Token 辅助（对应 lib/client.py 里的 mask / jwt_payload / token_expiry / fmt_ts）。
 *
 * 无状态设计：server 不落任何凭据。这里只保留展示与解析 token 的纯函数，
 * 不再有 credentials.json 的读写。
 */

export function mask(token: string | undefined): string {
  if (!token) return "(无)";
  if (token.length <= 16) return `${token.slice(0, 4)}…`;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

function b64UrlDecode(part: string): string {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  return Buffer.from(b64, "base64").toString("utf-8");
}

export function jwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1]!;
    return JSON.parse(b64UrlDecode(part)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function tokenExpiry(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const exp = jwtPayload(token).exp;
  return typeof exp === "number" ? Math.trunc(exp) : undefined;
}

export function fmtTs(ts: number | undefined): string {
  if (!ts) return "未知";
  return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
}

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
