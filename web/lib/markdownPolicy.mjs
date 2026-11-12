/**
 * 回答 markdown 的渲染安全策略（docs/trace.md「web 渲染安全」）。
 *
 * web chat 与 dashboard-v6 同源（next.wikipali.org），localStorage 里的登录 token 两边共用：
 * 这个页面上任何一段被注入的脚本都能读到它。回答内容来自 LLM，而 LLM 读的工具结果里有
 * 任何人都能写的批注、译文、术语——必须当作不可信输入渲染。
 *
 * 这里是 Streamdown 管线的唯一配置，SafeMarkdown 组件与 scripts/check-markdown-xss.mjs 共用：
 * - 不解析原始 HTML（remark-rehype 的 allowDangerousHtml 关掉，也不用 rehype-raw），HTML 一律丢弃；
 * - 链接只允许 http / https / mailto；图片只允许受信站点、不允许 data:（外链图片能把对话内容带出去）；
 * - mermaid 代码块降级成普通代码块（用不到，少一块攻击面）；KaTeX 保持默认 trust: false。
 *
 * 纯 JS（.mjs）是为了让 node 自检脚本不经编译就能直接 import。
 */
import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";

/** 受信站点：这些主机（及其子域）的链接直接点，图片可以加载。 */
const DEFAULT_TRUSTED_HOSTS = ["wikipali.org", "wikipali.cc"];

/**
 * @param {string | undefined} extra 逗号分隔的额外受信主机（本地开发如 127.0.0.1,localhost）
 * @returns {string[]}
 */
export function trustedHosts(extra) {
  return [
    ...DEFAULT_TRUSTED_HOSTS,
    ...String(extra || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  ];
}

/**
 * 解析链接；不合法、或协议不在白名单里返回 null。
 * @param {string} href
 * @param {string} base 相对链接的基准（页面 origin）
 * @returns {URL | null}
 */
export function parseSafeUrl(href, base) {
  try {
    const url = new URL(String(href), base);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/**
 * @param {URL} url
 * @param {string[]} hosts
 */
export function isTrustedUrl(url, hosts) {
  if (url.protocol === "mailto:") return false;
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** mermaid 代码块改成普通代码块：Streamdown 没有开关可关，只能在 mdast 里改语言。 */
export function remarkNoMermaid() {
  /** @param {any} node */
  const walk = (node) => {
    if (node.type === "code" && String(node.lang || "").toLowerCase() === "mermaid") {
      node.lang = "text";
    }
    (node.children || []).forEach(walk);
  };
  return walk;
}

export const safeRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkNoMermaid];

/** remark → rehype：不放行原始 HTML。 */
export const safeRemarkRehypeOptions = { allowDangerousHtml: false };

/**
 * @param {string[]} hosts 受信主机
 * @param {string} origin 页面 origin（相对链接、图片的基准）
 */
export function safeRehypePlugins(hosts, origin) {
  const [harden] = /** @type {any[]} */ (defaultRehypePlugins.harden);
  const imageOrigins = hosts.flatMap((h) => [`https://${h}/`, `https://www.${h}/`, `https://next.${h}/`, `http://${h}/`]);
  return [
    defaultRehypePlugins.katex,
    defaultRehypePlugins.sanitize,
    [
      harden,
      {
        allowedProtocols: ["http", "https", "mailto"],
        allowedLinkPrefixes: ["*"],
        allowedImagePrefixes: [`${origin}/`, ...imageOrigins],
        allowDataImages: false,
        defaultOrigin: origin,
      },
    ],
  ];
}
