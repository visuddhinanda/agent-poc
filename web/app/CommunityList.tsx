"use client";

import { useCallback, useEffect, useState } from "react";
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2";

const colors = {
  paper: "#f7f3ea",
  paperRaised: "#fdfaf1",
  paperSunken: "#efe8d8",
  ink: "#3a3128",
  inkSoft: "#6b5f4e",
  inkFaint: "#9a8c76",
  vermilion: "#8c3b2e",
  ochre: "#a06b2c",
  hairline: "#e4dbc6",
  border: "#d8cdb4",
};

/** 对齐 mobile 的问答广场卡片字段：问题摘要 + 语言标签 + 引用经文标识。 */
interface CommunityItem {
  id: string;
  title: string;
  lang: string;
  cited: boolean;
}

/** 公开问题 mock（后续接 mint GET /chat?public=1，分页 + citations）。 */
const POOL: CommunityItem[] = [
  { id: "1", title: "什么是四圣谛？", lang: "中文", cited: true },
  { id: "2", title: "缘起与十二因缘的关系？", lang: "中文", cited: true },
  { id: "3", title: "什么是无我（anattā）？", lang: "中文", cited: true },
  { id: "4", title: "慈经（Karaṇīyametta Sutta）讲了什么？", lang: "中文", cited: true },
  { id: "5", title: "八正道如何落实在生活？", lang: "中文", cited: false },
  { id: "6", title: "涅槃是什么意思？", lang: "中文", cited: false },
  { id: "7", title: "What is anattā?", lang: "English", cited: true },
  { id: "8", title: "What is paṭiccasamuppāda?", lang: "English", cited: false },
  { id: "9", title: "Kammañca phalañca kathaṃ?", lang: "Pali", cited: false },
  { id: "10", title: "Mettā bhāvanā kathaṃ?", lang: "Pali", cited: false },
];

type Status = "loading" | "success" | "empty" | "error";

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: 12,
};

const skeletonStyle: React.CSSProperties = {
  background: colors.paperRaised,
  border: `1px solid ${colors.hairline}`,
  borderRadius: 10,
  height: 88,
  animation: "cpk-pulse 1.2s ease-in-out infinite",
};

export function CommunityList() {
  const { agent } = useAgent({ agentId: "pali_agent" });
  const { copilotkit } = useCopilotKit();
  const [status, setStatus] = useState<Status>("loading");
  const [items, setItems] = useState<CommunityItem[]>([]);

  const load = useCallback(() => {
    setStatus("loading");
    // mock 异步拉取；接入真实后端后替换为 fetch + try/catch（error 态）与空结果（empty 态）
    setTimeout(() => {
      if (POOL.length === 0) {
        setStatus("empty");
        return;
      }
      setItems(POOL);
      setStatus("success");
    }, 600);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 点击卡片 → 以该问题进入对话并立即发送（对齐 mobile 的 navigate("NewChat", { seedText })）
  const ask = (q: string) => {
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: q });
    copilotkit.runAgent({ agent });
  };

  return (
    <div
      style={{
        padding: "16px 16px 20px",
        borderTop: `1px solid ${colors.hairline}`,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: colors.ink }}>
          社区问答
        </h3>
      </div>

      {status === "loading" && (
        <div style={gridStyle}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={skeletonStyle} />
          ))}
        </div>
      )}

      {status === "empty" && (
        <div style={{ textAlign: "center", padding: "36px 16px", color: colors.inkFaint }}>
          <div style={{ fontSize: 14 }}>暂无公开问题，来提第一个问题吧</div>
        </div>
      )}

      {status === "error" && (
        <div style={{ textAlign: "center", padding: "36px 16px", color: colors.inkFaint }}>
          <div style={{ fontSize: 14, marginBottom: 12 }}>加载失败</div>
          <button
            onClick={load}
            style={{
              padding: "8px 16px",
              borderRadius: 999,
              border: `1px solid ${colors.border}`,
              background: colors.paperRaised,
              color: colors.vermilion,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            重试
          </button>
        </div>
      )}

      {status === "success" && (
        <div style={gridStyle}>
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => ask(item.title)}
              style={{
                textAlign: "left",
                background: colors.paperRaised,
                border: `1px solid ${colors.hairline}`,
                borderRadius: 10,
                padding: "14px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: colors.ink, lineHeight: 1.5 }}>
                {item.title}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    background: colors.paperSunken,
                    borderRadius: 999,
                    padding: "2px 10px",
                    fontSize: 12,
                    color: colors.inkSoft,
                  }}
                >
                  {item.lang}
                </span>
                {item.cited ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 12,
                      color: colors.ochre,
                    }}
                  >
                    📖 引用经文
                  </span>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
