"use client";

import { createContext, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CopilotKit, CopilotChat, useAgent } from "@copilotkit/react-core/v2";
import { Streamdown } from "streamdown";

// runtime 地址：默认本机 3001；部署时用 NEXT_PUBLIC_RUNTIME_URL 覆盖
const runtimeUrl =
  process.env.NEXT_PUBLIC_RUNTIME_URL || "http://localhost:3001/api/copilotkit";

// WikiPali 阅读器跳转基地址：配置文件 .env.local 可覆盖（NEXT_PUBLIC_WIKIPALI_BASE_URL）
const wikipaliBaseUrl =
  process.env.NEXT_PUBLIC_WIKIPALI_BASE_URL || "https://next.wikipali.org";

interface Citation {
  ref: string;
  passageId: string;
  pali: string;
  zh: string;
}

/** passageId（如 188-459）→ 阅读器页面 URL */
function readerUrl(passageId: string): string {
  return `${wikipaliBaseUrl}/library/tipitaka/${passageId}/read?channel=translation`;
}

/** 从 /library/tipitaka/188-459/... 提取 passageId */
function passageIdFromHref(href: string): string | null {
  const m = href.match(/\/library\/tipitaka\/([^/]+)\//);
  return m ? m[1] : null;
}

// passageId → citation 映射，供引用 tag 的 popover 查询经文内容
const CitationsContext = createContext<Map<string, Citation>>(new Map());

const tagStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 8px",
  borderRadius: 999,
  background: "#efe8d8",
  border: "1px solid #d8cdb4",
  color: "#8c3b2e",
  fontSize: "0.85em",
  fontWeight: 600,
  textDecoration: "none",
  cursor: "pointer",
};

const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT_EST = 200;
const POPOVER_GAP = 8;
const POPOVER_MARGIN = 8;

const popoverStyle: React.CSSProperties = {
  position: "fixed",
  zIndex: 9999,
  width: POPOVER_WIDTH,
  maxWidth: "calc(100vw - 16px)",
  maxHeight: 320,
  overflowY: "auto",
  background: "#fdfaf1",
  border: "1px solid #d8cdb4",
  borderRadius: 10,
  boxShadow: "0 4px 16px rgba(138,122,90,.28)",
  padding: "10px 12px",
  fontSize: "0.85em",
  color: "#3a3128",
  lineHeight: 1.6,
  textAlign: "left",
};

function CitationLink(props: any) {
  const { href, children, node, ...rest } = props;
  const citations = useContext(CitationsContext);
  const passageId = typeof href === "string" ? passageIdFromHref(href) : null;
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tagRef = useRef<HTMLSpanElement>(null);

  // 非经文引用链接：原样渲染
  if (!passageId) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }

  const citation = citations.get(passageId);

  const handleMouseEnter = () => {
    const el = tagRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    // 水平：默认左对齐 tag，超出右边界则向左收
    let left = rect.left;
    if (left + POPOVER_WIDTH > vw - POPOVER_MARGIN) {
      left = vw - POPOVER_WIDTH - POPOVER_MARGIN;
    }
    left = Math.max(POPOVER_MARGIN, left);
    // 垂直：默认在 tag 上方，上方空间不够则放到下方
    let top = rect.top - POPOVER_HEIGHT_EST - POPOVER_GAP;
    if (top < POPOVER_MARGIN) {
      top = rect.bottom + POPOVER_GAP;
    }
    setPos({ top, left });
    setHover(true);
  };

  return (
    <span
      ref={tagRef}
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setHover(false)}
    >
      <a href={readerUrl(passageId)} target="_blank" rel="noopener noreferrer" style={tagStyle}>
        {children}
      </a>
      {hover && citation && pos
        ? createPortal(
            <span style={{ ...popoverStyle, top: pos.top, left: pos.left }}>
              <span style={{ display: "block", fontWeight: 700, color: "#a06b2c", marginBottom: 6 }}>
                📖 {citation.ref}
              </span>
              <span style={{ display: "block", fontStyle: "italic", color: "#4a3d2d", marginBottom: 4 }}>
                {citation.pali}
              </span>
              <span style={{ display: "block", color: "#6b5f4e" }}>{citation.zh}</span>
            </span>,
            document.body
          )
        : null}
    </span>
  );
}

function MarkdownRenderer(props: any) {
  const { content, ...rest } = props;
  return (
    <Streamdown {...rest} components={{ ...(rest.components || {}), a: CitationLink }}>
      {content ?? ""}
    </Streamdown>
  );
}

function Chat() {
  const { agent } = useAgent({ agentId: "pali_agent" });

  // 从工具返回结果里收集 passageId → citation 映射
  const citations = new Map<string, Citation>();
  for (const m of agent.messages ?? []) {
    if (m.role === "tool" && typeof m.content === "string") {
      try {
        const arr = JSON.parse(m.content);
        for (const c of arr) {
          if (c && c.passageId) citations.set(c.passageId, c);
        }
      } catch {
        // 非 JSON 工具结果忽略
      }
    }
  }

  return (
    <CitationsContext.Provider value={citations}>
      <CopilotChat
        agentId="pali_agent"
        chatView={{
          messageView: {
            assistantMessage: {
              markdownRenderer: MarkdownRenderer,
              toolCallsView: () => null,
            },
          },
        }}
      />
    </CitationsContext.Provider>
  );
}

export default function Home() {
  return (
    <CopilotKit runtimeUrl={runtimeUrl} agent="pali_agent" useSingleEndpoint={false}>
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          minHeight: "100vh",
          background: "#f7f3ea",
        }}
      >
        <h1 style={{ margin: "18px 0 4px", fontSize: 22, color: "#3a3128" }}>
          巴利经文 AI 问答助手（POC）
        </h1>
        <p style={{ margin: 0, color: "#8a7a5c", fontSize: 14 }}>
          Runtime: {runtimeUrl} · 试试问「什么是四圣谛？」「缘起是什么？」「慈经讲了什么？」
        </p>
        <div
          style={{
            flex: 1,
            width: "100%",
            maxWidth: 760,
            padding: 16,
            boxSizing: "border-box",
            minHeight: 0,
          }}
        >
          <Chat />
        </div>
      </main>
    </CopilotKit>
  );
}
