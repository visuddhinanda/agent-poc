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

interface HistoryItem {
  id: string;
  title: string;
  time: string;
}

const MOCK_USER = {
  name: "贤友",
  avatar: "🙏",
  status: "已登录",
};

const MOCK_HISTORY: HistoryItem[] = [
  { id: "1", title: "什么是四圣谛？", time: "2 分钟前" },
  { id: "2", title: "缘起与十二因缘的关系？", time: "1 小时前" },
  { id: "3", title: "什么是无我（anattā）？", time: "昨天" },
  { id: "4", title: "慈经（Karaṇīyametta Sutta）讲了什么？", time: "3 天前" },
  { id: "5", title: "八正道的修行次第", time: "上周" },
];

export function Sidebar({
  open,
  isMobile,
  onClose,
}: {
  open: boolean;
  isMobile: boolean;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState("1");

  const container: React.CSSProperties = {
    background: colors.paperRaised,
    borderRight: `1px solid ${colors.hairline}`,
    display: "flex",
    flexDirection: "column",
    height: "100%",
    // 桌面：常驻栏，宽度 0/260 切换；手机：fixed 抽屉，translateX 切换
    ...(isMobile
      ? {
          position: "fixed",
          left: 0,
          top: 0,
          bottom: 0,
          width: 260,
          zIndex: 50,
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.25s ease",
          boxShadow: open ? "4px 0 20px rgba(58,49,40,.2)" : "none",
        }
      : {
          width: open ? 260 : 0,
          overflow: "hidden",
          transition: "width 0.25s ease",
        }),
  };

  return (
    <aside style={container}>
      {/* 用户信息 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "16px 16px 12px",
          borderBottom: `1px solid ${colors.hairline}`,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            background: colors.paperSunken,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 20,
          }}
        >
          {MOCK_USER.avatar}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: colors.ink }}>{MOCK_USER.name}</div>
          <div style={{ fontSize: 12, color: colors.inkFaint }}>{MOCK_USER.status}</div>
        </div>
        {isMobile && (
          <button
            onClick={onClose}
            aria-label="关闭侧边栏"
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              color: colors.inkSoft,
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* 新对话 */}
      <div style={{ padding: "12px 16px" }}>
        <button
          style={{
            width: "100%",
            padding: "10px",
            borderRadius: 8,
            background: colors.vermilion,
            color: "#fff",
            border: "none",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          ＋ 新对话
        </button>
      </div>

      {/* 历史列表 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 16px" }}>
        <div style={{ padding: "0 8px 8px", fontSize: 12, color: colors.inkFaint }}>
          我的历史问题
        </div>
        {MOCK_HISTORY.map((item) => {
          const active = item.id === activeId;
          return (
            <button
              key={item.id}
              onClick={() => {
                setActiveId(item.id);
                if (isMobile) onClose();
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                marginBottom: 4,
                borderRadius: 8,
                border: "none",
                background: active ? colors.paperSunken : "transparent",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  color: active ? colors.vermilion : colors.ink,
                  fontWeight: active ? 600 : 400,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {item.title}
              </div>
              <div style={{ fontSize: 11, color: colors.inkFaint, marginTop: 2 }}>
                {item.time}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
