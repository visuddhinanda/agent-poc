import { NextResponse, type NextRequest } from "next/server";

/**
 * 内容安全策略（CSP），每个请求一个 nonce（docs/trace.md「web 渲染安全」）。
 *
 * 这一层是 SafeMarkdown 之后的兜底：渲染层哪怕漏过一段脚本或一张外链图片，浏览器也不执行、
 * 不加载——img-src 只放行受信站点，把「用图片把对话内容带到外站」从根上堵住。
 *
 * 默认只报告不拦截（Content-Security-Policy-Report-Only）：先观察几天确认没误伤，
 * 再设 CSP_ENFORCE=1 改成强制。
 */
function originOf(url: string | undefined): string {
  try {
    return url && /^https?:/.test(url) ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const trusted = ["https://*.wikipali.org", "https://wikipali.org", "https://*.wikipali.cc", "https://wikipali.cc"];
  // 本地开发 runtime / mint 在别的端口；线上同源，这两项为空
  const connect = [originOf(process.env.NEXT_PUBLIC_RUNTIME_URL), originOf(process.env.NEXT_PUBLIC_MINT_API_URL)];

  const policy = [
    "default-src 'self'",
    // shiki 代码高亮用 WebAssembly；开发模式的热更新要 eval
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    // 代码高亮、公式渲染、组件内联样式都要 inline style；样式注入的危害远小于脚本
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${trusted.join(" ")}`,
    "font-src 'self' data:",
    `connect-src 'self' ${connect.filter(Boolean).join(" ")}${dev ? " ws: http://localhost:* http://127.0.0.1:*" : ""}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");

  const header = process.env.CSP_ENFORCE === "1" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
  // Next 从请求头里的 CSP 取 nonce，挂到它自己注入的脚本上
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(header, policy);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
