"use client";

import { useState } from "react";

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

interface CommunityItem {
  id: string;
  title: string;
  askers: number;
  avatar: string;
}

const POOL: CommunityItem[] = [
  { id: "1", title: "什么是四圣谛？", askers: 128, avatar: "🧘" },
  { id: "2", title: "缘起与十二因缘的关系？", askers: 96, avatar: "🌿" },
  { id: "3", title: "什么是无我（anattā）？", askers: 87, avatar: "🪷" },
  { id: "4", title: "慈经（Karaṇīyametta Sutta）讲了什么？", askers: 74, avatar: "🕊️" },
  { id: "5", title: "八正道如何落实在生活？", askers: 63, avatar: "☸️" },
  { id: "6", title: "涅槃是什么意思？", askers: 55, avatar: "🌅" },
  { id: "7", title: "五蕴与五取蕴的区别？", askers: 48, avatar: "🍃" },
  { id: "8", title: "无常观怎么修？", askers: 42, avatar: "🌙" },
  { id: "9", title: "苦集灭道的含义？", askers: 39, avatar: "🌊" },
  { id: "10", title: "止观双运怎么修？", askers: 33, avatar: "⛰️" },
  { id: "11", title: "轮回与业力的关系？", askers: 28, avatar: "♻️" },
  { id: "12", title: "什么是正念？", askers: 25, avatar: "🎐" },
];

const BATCH_SIZE = 6;

export function CommunityList() {
  const [batch, setBatch] = useState(0);
  const start = (batch * BATCH_SIZE) % POOL.length;
  const items = POOL.slice(start, start + BATCH_SIZE).concat(
    POOL.slice(0, Math.max(0, start + BATCH_SIZE - POOL.length)),
  );

  return (
    <div style={{ padding: "16px 16px 20px", borderTop: `1px solid ${colors.hairline}`, overflowY: "auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: colors.ink }}>社区问答</h3>
        <button
          onClick={() => setBatch((b) => b + 1)}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            border: `1px solid ${colors.border}`,
            background: colors.paperRaised,
            color: colors.vermilion,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          ⟳ 换一批
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        {items.map((item) => (
          <div
            key={`${batch}-${item.id}`}
            style={{
              background: colors.paperRaised,
              border: `1px solid ${colors.hairline}`,
              borderRadius: 10,
              padding: "14px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: colors.ink, lineHeight: 1.5 }}>
              {item.title}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  background: colors.paperSunken,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                }}
              >
                {item.avatar}
              </span>
              <span style={{ fontSize: 12, color: colors.inkFaint }}>
                {item.askers} 人问了同样的问题
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
