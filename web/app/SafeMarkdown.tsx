"use client";

/**
 * 回答 / 思考过程 / 会话历史的唯一 markdown 渲染入口。管线配置在 lib/markdownPolicy.mjs
 * （与 scripts/check-markdown-xss.mjs 共用），这里只负责接到 Streamdown 上，外加：
 * - 链接分两类：受信站点（wikipali）照常显示；外站链接后面标出域名，新窗口打开，
 *   `rel="noopener noreferrer nofollow ugc"`——让人一眼看出要离开本站；
 * - 不合法 / 危险协议的链接只留文字。
 *
 * 用户自己的提问、会话标题不经过这里，一律当纯文本显示。
 */
import { useMemo, type ReactNode } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import {
  isTrustedUrl,
  parseSafeUrl,
  safeRehypePlugins,
  safeRemarkPlugins,
  safeRemarkRehypeOptions,
  trustedHosts,
} from "@/lib/markdownPolicy.mjs";

/** 受信主机：wikipali.org / wikipali.cc 及子域，本地开发经 NEXT_PUBLIC_TRUSTED_HOSTS 追加。 */
export const TRUSTED_HOSTS = trustedHosts(process.env.NEXT_PUBLIC_TRUSTED_HOSTS);

function pageOrigin(): string {
  return typeof window === "undefined" ? "https://next.wikipali.org" : window.location.origin;
}

/** 链接判定：null 表示不能当链接用（不合法或危险协议）。 */
export function classifyLink(href: unknown): { url: URL; trusted: boolean } | null {
  if (typeof href !== "string") return null;
  const url = parseSafeUrl(href, pageOrigin());
  return url ? { url, trusted: isTrustedUrl(url, TRUSTED_HOSTS) } : null;
}

const externalHostStyle: React.CSSProperties = {
  marginLeft: 4,
  fontSize: "0.8em",
  color: "#8a7a5c",
  whiteSpace: "nowrap",
};

/** 非引用链接：受信站点照常；外站标域名；危险链接只留文字。 */
export function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  const link = classifyLink(href);
  if (!link) return <span>{children}</span>;
  if (link.trusted) {
    return (
      <a href={link.url.href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <a href={link.url.href} target="_blank" rel="noopener noreferrer nofollow ugc">
      {children}
      {link.url.protocol !== "mailto:" ? (
        <span style={externalHostStyle}>↗ {link.url.hostname}</span>
      ) : null}
    </a>
  );
}

export function SafeMarkdown({
  content,
  components,
  ...rest
}: {
  content?: string;
  components?: Record<string, unknown>;
  [key: string]: unknown;
}) {
  const rehypePlugins = useMemo(() => safeRehypePlugins(TRUSTED_HOSTS, pageOrigin()), []);
  return (
    <Streamdown
      {...rest}
      // 放在 rest 之后：调用方（CopilotKit）传进来的插件配置一律不认
      rehypePlugins={rehypePlugins as StreamdownProps["rehypePlugins"]}
      remarkPlugins={safeRemarkPlugins as StreamdownProps["remarkPlugins"]}
      remarkRehypeOptions={safeRemarkRehypeOptions}
      components={{ a: SafeLink, ...(components as object) }}
    >
      {content ?? ""}
    </Streamdown>
  );
}

/** CopilotChat 思考过程（reasoning）内容槽位：默认实现直接用 Streamdown 默认配置，这里换掉。 */
export function SafeReasoningContent({
  isStreaming,
  hasContent,
  children,
}: {
  isStreaming?: boolean;
  hasContent?: boolean;
  children?: ReactNode;
}) {
  if (!hasContent && !isStreaming) return null;
  return (
    <div style={{ padding: "4px 0 8px", fontSize: 13, color: "#8a7a5c" }}>
      <SafeMarkdown content={typeof children === "string" ? children : ""} />
    </div>
  );
}
