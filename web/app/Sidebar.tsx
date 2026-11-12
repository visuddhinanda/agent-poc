"use client";

/**
 * 侧栏：当前用户 + 新对话 + 会话历史（docs/chat.md §3.1，与 mobile 的 ChatHistoryList 同一套交互）。
 *
 * - 历史只给登录用户（mint `/v3/me/agent-threads`）；游客显示「登录后可查看历史」；
 * - 「最近 / 已存档」两组，滚到底翻页；悬停出现菜单：存档 / 取消存档、改名、删除；
 * - 删除只是对自己隐藏，服务器为防滥用、改进回答永久保留记录，确认框里写明；
 * - 标题是用户的提问原文：一律纯文本渲染。
 */
import { useCallback, useEffect, useState } from "react";
import {
  deleteThread,
  listThreads,
  renameThread,
  setThreadArchived,
  type Me,
  type Thread,
} from "@/lib/mint";

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

function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!ts) return "";
  const diff = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

const tabStyle = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: "6px 0",
  border: "none",
  borderRadius: 6,
  background: active ? colors.paperRaised : "transparent",
  color: active ? colors.ink : colors.inkSoft,
  fontWeight: active ? 600 : 400,
  fontSize: 13,
  cursor: "pointer",
});

const menuItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "6px 12px",
  border: "none",
  background: "transparent",
  textAlign: "left",
  fontSize: 13,
  color: colors.ink,
  cursor: "pointer",
};

export function Sidebar({
  open,
  isMobile,
  onClose,
  me,
  signedIn,
  activeThreadId,
  refreshKey,
  onOpen,
  onNewChat,
  onSignIn,
  onSignOut,
}: {
  open: boolean;
  isMobile: boolean;
  onClose: () => void;
  me: Me | null;
  signedIn: boolean;
  activeThreadId: string | null;
  /** 变化时重新拉第一页（一轮问答结束、刚开了新会话）。 */
  refreshKey: number;
  onOpen: (threadId: string) => void;
  onNewChat: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const [group, setGroup] = useState<"recent" | "archived">("recent");
  const [items, setItems] = useState<Thread[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const load = useCallback(
    async (nextPage: number) => {
      if (!signedIn) return;
      setLoading(true);
      setFailed(false);
      try {
        const res = await listThreads(group === "archived", nextPage);
        setItems((prev) => (nextPage === 1 ? res.items : [...prev, ...res.items]));
        setPage(nextPage);
        setHasMore(res.hasMore);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [signedIn, group],
  );

  useEffect(() => {
    void load(1);
  }, [load, refreshKey]);

  const removeLocally = (id: string) => setItems((prev) => prev.filter((x) => x.thread_id !== id));
  const reloadOnError = () => {
    alert("操作失败，请稍后再试。");
    void load(1);
  };

  const toggleArchive = (thread: Thread) => {
    setMenuFor(null);
    removeLocally(thread.thread_id);
    setThreadArchived(thread.thread_id, !thread.archived_at).catch(reloadOnError);
  };
  const rename = (thread: Thread) => {
    setMenuFor(null);
    const title = window.prompt("修改会话标题", thread.title)?.trim();
    if (!title || title === thread.title) return;
    setItems((prev) => prev.map((x) => (x.thread_id === thread.thread_id ? { ...x, title } : x)));
    renameThread(thread.thread_id, title.slice(0, 255)).catch(reloadOnError);
  };
  const remove = (thread: Thread) => {
    setMenuFor(null);
    if (!window.confirm("删除这个会话？\n删除后你将看不到它。为防止滥用和改进回答，服务器仍会保留这份记录。")) {
      return;
    }
    removeLocally(thread.thread_id);
    deleteThread(thread.thread_id).catch(reloadOnError);
    if (thread.thread_id === activeThreadId) onNewChat();
  };

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
          🙏
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {signedIn ? (
            <>
              <div style={{ fontWeight: 600, color: colors.ink, overflow: "hidden", textOverflow: "ellipsis" }}>
                {me?.nickName ?? "…"}
              </div>
              <button
                type="button"
                onClick={onSignOut}
                style={{ border: "none", background: "transparent", padding: 0, fontSize: 12, color: colors.inkFaint, cursor: "pointer" }}
              >
                退出登录
              </button>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 600, color: colors.ink }}>未登录</div>
              <button
                type="button"
                onClick={onSignIn}
                style={{ border: "none", background: "transparent", padding: 0, fontSize: 12, color: colors.vermilion, cursor: "pointer" }}
              >
                登录 / 注册
              </button>
            </>
          )}
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
          onClick={onNewChat}
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
      {!signedIn ? (
        <div style={{ padding: "16px", fontSize: 13, color: colors.inkSoft, textAlign: "center" }}>
          登录后可查看和同步提问历史
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 4, margin: "0 16px 8px", padding: 3, borderRadius: 8, background: colors.paperSunken }}>
            <button type="button" style={tabStyle(group === "recent")} onClick={() => setGroup("recent")}>
              最近
            </button>
            <button type="button" style={tabStyle(group === "archived")} onClick={() => setGroup("archived")}>
              已存档
            </button>
          </div>
          <div
            style={{ flex: 1, overflowY: "auto", padding: "0 8px 16px" }}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (hasMore && !loading && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
                void load(page + 1);
              }
            }}
          >
            {items.map((item) => {
              const active = item.thread_id === activeThreadId;
              const showMenu = menuFor === item.thread_id;
              return (
                <div
                  key={item.thread_id}
                  style={{ position: "relative" }}
                  onMouseEnter={() => setHoverId(item.thread_id)}
                  onMouseLeave={() => setHoverId(null)}
                >
                  <button
                    onClick={() => onOpen(item.thread_id)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 32px 10px 12px",
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
                      {relativeTime(item.last_run_at)}
                    </div>
                  </button>
                  {(hoverId === item.thread_id || showMenu || isMobile) && (
                    <button
                      type="button"
                      aria-label="会话操作"
                      onClick={() => setMenuFor(showMenu ? null : item.thread_id)}
                      style={{
                        position: "absolute",
                        right: 6,
                        top: 10,
                        width: 22,
                        height: 22,
                        border: "none",
                        borderRadius: 4,
                        background: "transparent",
                        color: colors.inkSoft,
                        cursor: "pointer",
                      }}
                    >
                      ⋯
                    </button>
                  )}
                  {showMenu && (
                    <div
                      style={{
                        position: "absolute",
                        right: 6,
                        top: 34,
                        zIndex: 5,
                        minWidth: 120,
                        padding: "4px 0",
                        borderRadius: 8,
                        border: `1px solid ${colors.border}`,
                        background: colors.paperRaised,
                        boxShadow: "0 4px 12px rgba(58,49,40,.18)",
                      }}
                    >
                      <button type="button" style={menuItemStyle} onClick={() => toggleArchive(item)}>
                        {item.archived_at ? "取消存档" : "存档"}
                      </button>
                      <button type="button" style={menuItemStyle} onClick={() => rename(item)}>
                        改名
                      </button>
                      <button type="button" style={{ ...menuItemStyle, color: colors.vermilion }} onClick={() => remove(item)}>
                        删除
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {!loading && items.length === 0 && (
              <div style={{ padding: 16, fontSize: 13, color: colors.inkSoft, textAlign: "center" }}>
                {failed ? (
                  <button type="button" onClick={() => void load(1)} style={{ border: "none", background: "transparent", color: colors.vermilion, cursor: "pointer" }}>
                    加载失败，点此重试
                  </button>
                ) : group === "archived" ? (
                  "没有已存档的会话"
                ) : (
                  "还没有提问记录"
                )}
              </div>
            )}
            {loading && <div style={{ padding: 12, fontSize: 12, color: colors.inkFaint, textAlign: "center" }}>加载中…</div>}
          </div>
        </>
      )}
    </aside>
  );
}
