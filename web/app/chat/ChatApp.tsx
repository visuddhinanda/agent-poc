"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CopilotKit,
  CopilotChat,
  CopilotChatAssistantMessage,
  useAgent,
  useRenderTool,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { Sidebar } from "../Sidebar";
import { CommunityList } from "../CommunityList";
import { SafeLink, SafeMarkdown, SafeReasoningContent, classifyLink } from "../SafeMarkdown";
import { AnswerFeedback } from "../AnswerFeedback";
import {
  IMPROVE_OPT_OUT_ALLOWED,
  clientState,
  getDeviceId,
  getImprove,
  getToken,
  setImprove,
  signInUrl,
  signOut,
} from "@/lib/session";
import { ApiError, fetchMe, fetchQuota, fetchThread, reportEvent, type Me, type Quota } from "@/lib/mint";
import { BETA_ROLE } from "@/lib/feedback";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

// runtime 地址：默认本机 3001；部署时用 NEXT_PUBLIC_RUNTIME_URL 覆盖
const runtimeUrl =
  process.env.NEXT_PUBLIC_RUNTIME_URL || "http://localhost:3001/api/copilotkit";

interface Citation {
  /** mock 检索是出处字符串；wikipali_search 是服务端原样的印本页码数组，展示用 cite */
  ref: unknown;
  /** wikipali_search 的出处：「[citation](link)」Markdown 链接，citation 与 link 均取自服务端 */
  cite?: string;
  passageId: string;
  link: string;
  highlight: string;
}

/** popover 标题：优先 cite 的 citation 文字，其次 mock 的 ref 字符串 */
function citationLabel(c: Citation): string {
  if (c.cite) return c.cite.match(/^\[(.*)\]\(.*\)$/)?.[1] ?? c.cite;
  return typeof c.ref === "string" ? c.ref : c.passageId;
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
  background: "#e5e7eb",
  border: "1px solid #d1d5db",
  color: "#6b7280",
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

const TOOL_LABELS: Record<string, string> = {
  wikipali_forms: "展开词形",
  wikipali_search: "检索经文",
  wikipali_get: "取经文原文",
  wikipali_dist: "统计出处分布",
  wikipali_word: "查词典",
  wikipali_count: "词频统计",
  wikipali_terms: "查术语",
  wikipali_books: "分类目录",
  wikipali_toc: "章节目录",
  wikipali_paras: "段落清单",
  wikipali_chapter: "章节体量",
  wikipali_chapter_fetch: "整章取文",
  wikipali_versions: "查译本",
  wikipali_related: "关联段落",
  wikipali_articles: "文章列表",
  wikipali_article: "读文章",
  wikipali_anthology: "文集",
};

const toolBubbleStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  margin: "4px 0",
  padding: "4px 10px",
  borderRadius: 999,
  background: "#efe8d8",
  border: "1px solid #d8cdb4",
  fontSize: "0.8em",
  color: "#6b5f4e",
};

const spinnerStyle: React.CSSProperties = {
  display: "inline-block",
  width: 11,
  height: 11,
  borderRadius: "50%",
  border: "2px solid #a06b2c",
  borderTopColor: "transparent",
  animation: "cpk-spin 0.8s linear infinite",
  verticalAlign: "-1px",
};

const thinkingStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  margin: "4px 0",
  padding: "4px 10px",
  borderRadius: 999,
  background: "#efe8d8",
  border: "1px solid #d8cdb4",
  fontSize: "0.8em",
  color: "#6b5f4e",
};

function ToolCallBubble(props: any) {
  const { name, status } = props;
  const running = status === "inProgress" || status === "executing";
  const label = TOOL_LABELS[name] ?? name;
  return (
    <span style={toolBubbleStyle}>
      {running ? <span style={spinnerStyle} /> : <span>✓</span>}
      <span>{label}</span>
      <span style={{ color: running ? "#a06b2c" : "#4a7c59" }}>
        {running ? "进行中…" : "完成"}
      </span>
    </span>
  );
}

function CitationLink(props: any) {
  const { href, children } = props;
  const citations = useContext(CitationsContext);
  const passageId = typeof href === "string" ? passageIdFromHref(href) : null;
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tagRef = useRef<HTMLSpanElement>(null);

  // 服务端 link 指向章节起点（…/203-1677/read#1702），按完整 href 精确匹配，再退回坐标
  const citation = passageId ? (citations.get(href) ?? citations.get(passageId)) : undefined;
  // 引用卡片的链接也要过同一道检查：模型可能把外站地址伪装成经文链接的样子
  const link = classifyLink(citation?.link ?? href);

  const messageId = useContext(MessageIdContext);

  // 非经文引用链接、或不是受信站点：按普通链接（外站标域名）渲染
  if (!passageId || !link?.trusted) {
    return <SafeLink href={href}>{children}</SafeLink>;
  }

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
      <a
        href={link.url.href}
        target="_blank"
        rel="noopener noreferrer"
        style={tagStyle}
        // 点开引用是「回答有用」的隐式信号
        onClick={() => messageId && void reportEvent(messageId, "citation_open", getDeviceId())}
      >
        {children}
      </a>
      {hover && citation && pos
        ? createPortal(
            <span style={{ ...popoverStyle, top: pos.top, left: pos.left }}>
              <span style={{ display: "block", fontWeight: 700, color: "#a06b2c", marginBottom: 6 }}>
                📖 {citationLabel(citation)}
              </span>
              <span style={{ display: "block", color: "#6b5f4e" }}>{citation.highlight}</span>
            </span>,
            document.body
          )
        : null}
    </span>
  );
}

/** 当前渲染的是哪条回答（引用点击上报隐式信号用）。 */
const MessageIdContext = createContext<string | null>(null);

/** 反馈栏需要的对话状态（beta、会话、最后一条回答、重新生成）。 */
const FeedbackContext = createContext<{
  beta: boolean;
  threadId: string | null;
  lastAnswerId: string | null;
  running: boolean;
  regenerate: (() => void) | null;
  /** 「用于改进回答」开着没有；评价前要它开着 */
  improve: boolean;
  enableImprove: () => void;
}>({ beta: false, threadId: null, lastAnswerId: null, running: false, regenerate: null, improve: true, enableImprove: () => {} });

/**
 * 回答消息：CopilotKit 原组件（关掉内置工具栏）+ 我们的反馈栏。
 * 额度用完的说明（id 以 quota- 开头）、其他系统说明（notice-：会话属于别人、网络访问错误、请求无效）
 * 和正在生成的那条不给反馈栏。
 */
function AssistantWithFeedback(props: React.ComponentProps<typeof CopilotChatAssistantMessage>) {
  const ctx = useContext(FeedbackContext);
  const message = props.message;
  const id: string | undefined = message?.id;
  const content = typeof message?.content === "string" ? message.content : "";
  const showFeedback =
    !!id && !!content && !id.startsWith("quota-") && !id.startsWith("notice-") && !(ctx.running && id === ctx.lastAnswerId);
  return (
    <MessageIdContext.Provider value={id ?? null}>
      <CopilotChatAssistantMessage {...props} markdownRenderer={MarkdownRenderer} toolbarVisible={false} />
      {showFeedback ? (
        <AnswerFeedback
          messageId={id}
          threadId={ctx.threadId}
          text={content}
          beta={ctx.beta}
          improve={ctx.improve}
          onEnableImprove={ctx.enableImprove}
          onRegenerate={id === ctx.lastAnswerId && !ctx.running && ctx.regenerate ? ctx.regenerate : undefined}
        />
      ) : null}
    </MessageIdContext.Provider>
  );
}

/** 回答正文：一律走 SafeMarkdown（不解析 HTML、链接 / 图片白名单），引用链接换成引用卡片。 */
function MarkdownRenderer(props: any) {
  const { content, ...rest } = props;
  return <SafeMarkdown {...rest} content={content} components={{ ...(rest.components || {}), a: CitationLink }} />;
}

function WelcomeScreen({ input }: any) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "auto" }}>
      <div style={{ padding: "32px 16px 0", textAlign: "center" }}>
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: "#3a3128" }}>
          How can I help you today?
        </h2>
        <p style={{ margin: "8px 0 12px", color: "#8a7a5c", fontSize: 13 }}>
          基于三藏原文的 AI 问答，回答附经文出处，点击引用可跳转原文。
        </p>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            margin: "0 0 16px",
            padding: "6px 12px",
            borderRadius: 8,
            border: "1px solid #d8cdb4",
            background: "#fdfaf1",
            color: "#6b5f4e",
            fontSize: 12,
          }}
        >
          <span>ℹ️</span>
          <span>回答由 AI 生成，仅供参考，请以原典为准。</span>
        </div>
      </div>
      <div style={{ maxWidth: 760, width: "100%", margin: "0 auto", padding: "0 16px 16px" }}>
        {input}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <CommunityList />
      </div>
    </div>
  );
}

/**
 * 消息流末尾的「思考中…」指示（对齐 mobile 的 NewChatScreen 逻辑）：
 * AI 在跑、但既没在流式输出正文、也没在跑工具时显示。挂到
 * CopilotChat 的 messageView.cursor 槽位（默认是个脉冲小圆点，这里换成文字气泡）。
 */
function ThinkingCursor() {
  const { agent } = useAgent({ agentId: "pali_agent" });
  const { executingToolCallIds } = useCopilotKit();
  const isRunning = agent.isRunning;
  const messages = agent.messages ?? [];
  const lastMsg = messages[messages.length - 1];
  const assistantStreaming =
    lastMsg?.role === "assistant" &&
    typeof lastMsg.content === "string" &&
    lastMsg.content.length > 0;
  const runningTool = executingToolCallIds.size > 0;
  if (!isRunning || assistantStreaming || runningTool) return <></>;
  return (
    <span style={thinkingStyle}>
      <span style={spinnerStyle} />
      <span>思考中…</span>
    </span>
  );
}

/** 深度思考开关：关时 agent 走快速路径，开时多查几轮再作答（docs/agent-routing.md）。 */
function DeepToggle({
  on,
  onChange,
  multiplier,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  /** 深度思考是普通提问的几倍价（额度拿不到时不标）。 */
  multiplier: number | null;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        padding: "4px 12px",
        borderRadius: 999,
        border: `1px solid ${on ? "#a33a2b" : "#d8cdb4"}`,
        background: on ? "#a33a2b" : "#f3ecdc",
        color: on ? "#fdfaf1" : "#6b5f4e",
        fontSize: 13,
        cursor: "pointer",
      }}
    >
      {on ? "◉" : "○"} 深度思考{multiplier ? ` ×${multiplier}` : ""}
    </button>
  );
}

/** 侧栏 → 对话区的请求：打开某个历史会话，或开新对话。nonce 让同一个请求能重复发。 */
type ThreadRequest = { kind: "open"; id: string; nonce: number } | { kind: "new"; nonce: number };

const quotaBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  margin: "0 0 8px",
  fontSize: 12,
  color: "#8a7a5c",
};

const linkButtonStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  color: "#8c3b2e",
  cursor: "pointer",
  fontSize: 12,
};

function Chat({
  request,
  signedIn,
  beta,
  onThread,
  onRunFinished,
}: {
  request: ThreadRequest | null;
  signedIn: boolean;
  beta: boolean;
  /** 当前会话换了（新对话 / 打开历史）。 */
  onThread: (threadId: string, persisted: boolean) => void;
  /** 一轮问答结束：会话已入库（异步，可能晚几秒）。 */
  onRunFinished: (threadId: string) => void;
}) {
  const { agent } = useAgent({ agentId: "pali_agent" });
  const { copilotkit } = useCopilotKit();
  useRenderTool({ name: "*", render: ToolCallBubble }, []);

  // 深度思考默认关。CopilotChat 自带输入框、拦不到「发送」，所以开关一变就写进 agent state，
  // 下次发送随 RunAgentInput.state 带给后端；每次运行结束后后端会回灌整份 state（消息、
  // 检索计划等），这里收回成只剩自己的几项，免得下次请求把它们原样带回去。
  // client：这次提问算谁的、是否允许用于改进回答（docs/trace.md）。
  const [deep, setDeep] = useState(false);
  const [improve, setImproveState] = useState(true);
  const deepRef = useRef(deep);
  deepRef.current = deep;
  const syncState = useCallback(() => {
    agent.setState({ deep_thinking: deepRef.current, client: clientState() });
  }, [agent]);
  useEffect(() => setImproveState(getImprove()), []);
  useEffect(syncState, [syncState, deep, improve]);

  const [quota, setQuota] = useState<Quota | null>(null);
  const refreshQuota = useCallback(() => {
    fetchQuota(getDeviceId())
      .then(setQuota)
      .catch(() => setQuota(null)); // 拿不到额度就不显示；真去提问时 agent 会如实回「网络访问错误」
  }, []);
  useEffect(refreshQuota, [refreshQuota, signedIn]);

  const onRunFinishedRef = useRef(onRunFinished);
  onRunFinishedRef.current = onRunFinished;
  useEffect(() => {
    const sub = agent.subscribe({
      onRunFinalized: () => {
        syncState();
        refreshQuota();
        onRunFinishedRef.current(agent.threadId);
      },
    });
    return () => sub.unsubscribe();
  }, [agent, syncState, refreshQuota]);

  // 历史会话回放时没有工具消息，引用卡片的摘要来自入库时存下的 citations
  const [restoredCitations, setRestoredCitations] = useState<Map<string, Citation>>(new Map());

  const onThreadRef = useRef(onThread);
  onThreadRef.current = onThread;
  useEffect(() => {
    if (!request) return;
    const startNew = () => {
      agent.setMessages([]);
      agent.threadId = crypto.randomUUID();
      setRestoredCitations(new Map());
      onThreadRef.current(agent.threadId, false);
    };
    if (request.kind === "new") {
      startNew();
      return;
    }
    let alive = true;
    // 续聊：问答按原来的 AG-UI 消息 id 回灌，threadId 换成那个会话的。
    // 后端对话状态只在内存里，重启后就靠这份回灌接上上下文。
    fetchThread(request.id)
      .then((thread) => {
        if (!alive) return;
        const messages = thread.runs.flatMap((run) => [
          { id: run.user_message_id ?? `u-${run.run_id}`, role: "user" as const, content: run.question },
          ...(run.answer
            ? [{ id: run.assistant_message_id ?? `a-${run.run_id}`, role: "assistant" as const, content: run.answer }]
            : []),
        ]);
        const map = new Map<string, Citation>();
        for (const run of thread.runs) {
          for (const c of (run.citations ?? []) as unknown as Array<Citation & { coord?: string }>) {
            const key = c?.passageId ?? c?.coord;
            if (key && c?.link) {
              map.set(key, c);
              map.set(c.link, c);
            }
          }
        }
        agent.setMessages(messages as Parameters<typeof agent.setMessages>[0]);
        agent.threadId = thread.thread_id;
        setRestoredCitations(map);
        onThreadRef.current(thread.thread_id, true);
      })
      .catch((e) => {
        if (!alive) return;
        // 打不开（不是我的、已清理、没登录、链接写错）就开新会话，不能停在这个 id 上：
        // threadId 全局唯一，接着用别人的 id 提问会被 mint 拒绝
        startNew();
        alert(e instanceof ApiError && e.status !== 404 && e.status !== 401 ? "会话加载失败，已为你开一个新会话。" : "找不到这个会话，已为你开一个新会话。");
      });
    return () => {
      alive = false;
    };
  }, [request, agent]);

  // 从工具返回结果里收集坐标 → citation 映射。
  // 兼容两种结构：mock 的 [{passageId, ...}] 数组，与 wikipali_search 的 {rows:[{coord, ...}]} 对象。
  const citations = new Map<string, Citation>(restoredCitations);
  for (const m of agent.messages ?? []) {
    if (m.role === "tool" && typeof m.content === "string") {
      try {
        const parsed = JSON.parse(m.content);
        const rows = Array.isArray(parsed) ? parsed : parsed?.rows;
        if (!Array.isArray(rows)) continue;
        for (const c of rows) {
          const key = c?.passageId ?? c?.coord;
          // 只存带 link 的 citation（wikipali_search 的结果），忽略 get/dist/forms 等其他工具结果
          if (key && c?.link) {
            citations.set(key, c);
            citations.set(c.link, c);
          }
        }
      } catch {
        // 非 JSON 工具结果忽略
      }
    }
  }

  // 重新生成＝把最后一个问题再问一遍
  const messages = agent.messages ?? [];
  const lastQuestion = [...messages].reverse().find((m) => m.role === "user")?.content;
  const lastAnswerId = [...messages].reverse().find((m) => m.role === "assistant" && m.content)?.id ?? null;
  const feedbackCtx = {
    beta,
    threadId: agent.threadId ?? null,
    lastAnswerId,
    running: agent.isRunning,
    regenerate:
      typeof lastQuestion === "string"
        ? () => {
            // 告诉服务端这一轮替换的是哪条回答：会话历史回放时只留新的那轮（docs/trace.md §6）。
            // 只对这一轮有效，运行结束时 syncState() 会把它清掉
            agent.setState({
              deep_thinking: deepRef.current,
              client: { ...clientState(), replaces_message_id: lastAnswerId },
            });
            agent.addMessage({ id: crypto.randomUUID(), role: "user", content: lastQuestion });
            void copilotkit.runAgent({ agent });
          }
        : null,
    improve,
    enableImprove: () => {
      setImprove(true);
      setImproveState(true);
    },
  };

  const normal = Math.max(1, quota?.cost.normal ?? 10);
  const left = quota ? Math.floor((quota.free_remaining + quota.earned_balance) / normal) : null;

  return (
    <CitationsContext.Provider value={citations}>
      <FeedbackContext.Provider value={feedbackCtx}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={quotaBarStyle}>
        <DeepToggle
          on={deep}
          onChange={setDeep}
          multiplier={quota ? Math.max(1, Math.round(quota.cost.deep / normal)) : null}
        />
        {left !== null ? (
          <span style={{ marginLeft: "auto" }}>
            今日剩余 {left} 次{quota && quota.earned_balance > 0 ? ` · 积分 ${quota.earned_balance}` : ""}
            {left === 0 && !signedIn ? (
              <>
                {" · "}
                <a href={signInUrl()} style={{ color: "#8c3b2e" }}>
                  登录后每天有更多次数
                </a>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
      <CopilotChat
        agentId="pali_agent"
        // 文案与 App 一致（wikipali-mobile docs/chat.md §5）
        labels={{
          chatInputPlaceholder: messages.some((m) => m.role === "user") ? "继续追问…" : "提出一个新问题…",
          chatDisclaimerText: "回答由 AI 生成，仅供参考，请以原典为准。",
        }}
        chatView={{
          messageView: {
            // 槽位类型要求带静态成员，运行时只要是组件就行（renderSlot 直接 createElement）
            assistantMessage: AssistantWithFeedback as unknown as typeof CopilotChatAssistantMessage,
            reasoningMessage: {
              contentView: SafeReasoningContent,
            },
            cursor: ThinkingCursor,
          },
          welcomeScreen: WelcomeScreen,
        }}
      />
      </div>
      {/* 关掉不是私密会话：提问照样保存（会话历史 + 防滥用），只是不用于改进回答。
          内测期间不允许关闭（IMPROVE_OPT_OUT_ALLOWED）：只留提示、不给关闭按钮。
          TODO: 在线用户协议写好后，在这行提示后面加协议链接 */}
      <div
        style={{ margin: "6px 0 0", fontSize: 12, color: "#8a7a5c", textAlign: "center" }}
        title={
          IMPROVE_OPT_OUT_ALLOWED
            ? "提问会保存为你的会话记录，并用于防止滥用；关闭后不会用于改进回答。未登录时只关联本浏览器的匿名 ID。"
            : "内测期间，提问会保存为你的会话记录，用于防止滥用和改进回答，暂时不能关闭。未登录时只关联本浏览器的匿名 ID。"
        }
      >
        {improve ? "提问会被用于改进回答" : "提问不会用于改进回答"}
        {IMPROVE_OPT_OUT_ALLOWED ? (
          <>
            {" · "}
            <button
              type="button"
              style={linkButtonStyle}
              onClick={() => {
                setImprove(!improve);
                setImproveState(!improve);
              }}
            >
              {improve ? "关闭" : "开启"}
            </button>
          </>
        ) : null}
      </div>
      </div>
      </FeedbackContext.Provider>
    </CitationsContext.Provider>
  );
}

function AppLayout({ initialThreadId }: { initialThreadId: string | null }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThreadId);
  const [historyKey, setHistoryKey] = useState(0);
  const [request, setRequest] = useState<ThreadRequest | null>(() =>
    initialThreadId ? { kind: "open", id: initialThreadId, nonce: 0 } : null,
  );

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 断点切换时重置侧栏：手机默认收起为抽屉，桌面默认常驻展开
  useEffect(() => {
    setSidebarOpen(!isMobile);
  }, [isMobile]);

  // 登录态：token 是 dashboard-v6 登录后写进同源 storage 的；失效就当没登录
  useEffect(() => {
    if (!getToken()) return;
    setSignedIn(true);
    fetchMe()
      .then(setMe)
      .catch(() => setSignedIn(false));
  }, []);

  /** 地址栏跟着当前会话走：/agent/chat/<threadId>，刷新、收藏都能回到这个会话。 */
  const showThreadInUrl = (threadId: string | null) => {
    window.history.replaceState(null, "", `${BASE_PATH}/chat${threadId ? `/${threadId}` : ""}`);
  };

  return (
    <div style={{ display: "flex", height: "100vh", background: "#f7f3ea", overflow: "hidden" }}>
      {isMobile && sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(58,49,40,.35)",
            zIndex: 40,
          }}
        />
      )}
      <Sidebar
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        me={me}
        signedIn={signedIn}
        activeThreadId={activeThreadId}
        refreshKey={historyKey}
        onOpen={(id) => {
          setRequest({ kind: "open", id, nonce: Date.now() });
          if (isMobile) setSidebarOpen(false);
        }}
        onNewChat={() => {
          setRequest({ kind: "new", nonce: Date.now() });
          if (isMobile) setSidebarOpen(false);
        }}
        onSignIn={() => {
          window.location.href = signInUrl();
        }}
        onSignOut={() => {
          signOut();
          window.location.href = `${BASE_PATH}/chat`;
        }}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 16px",
            borderBottom: "1px solid #e4dbc6",
            background: "#fdfaf1",
          }}
        >
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            style={{
              width: 34,
              height: 34,
              borderRadius: 6,
              border: "1px solid #d8cdb4",
              background: "#fdfaf1",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
              color: "#3a3128",
            }}
          >
            ☰
          </button>
          <h1 style={{ margin: 0, fontSize: 17, color: "#3a3128", fontWeight: 600 }}>
            法音 · 巴利经文问答
          </h1>
        </header>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "16px",
          }}
        >
          <div style={{ flex: 1, width: "100%", maxWidth: 760, minHeight: 0 }}>
            <Chat
              request={request}
              signedIn={signedIn}
              beta={!!me?.roles?.includes(BETA_ROLE)}
              onThread={(id, persisted) => {
                setActiveThreadId(id);
                showThreadInUrl(persisted ? id : null);
              }}
              onRunFinished={(id) => {
                setActiveThreadId(id);
                // 只有登录用户能重新打开会话（历史接口只给登录用户），游客的地址栏不带会话 id，
                // 免得刷新时打不开（docs/trace.md §6）
                showThreadInUrl(signedIn ? id : null);
                // 研究过程是运行结束后异步入库的，晚一点再刷新历史列表
                setTimeout(() => setHistoryKey((k) => k + 1), 1500);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 从浏览器 localStorage 读取 WikiPali 写端凭据，转成请求头。
 *
 * 后端无状态：写句子/术语/批注的 modelToken / userToken 只能随请求头传入。
 * 这里约定 `localStorage["token"]` 存一个 token，两个头都用它（Authorization
 * 用 Bearer 形式）。CopilotKit 把这些头逐请求发给 runtime，runtime 再透传给
 * backend（backend 读头后转发给 wikipali MCP server）。未登录（无 token）时
 * 返回空对象，即纯读模式。
 */
function wikipaliHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = getToken();
  if (!token) return {};
  return {
    Authorization: `Bearer ${token}`,
    "X-Wikipali-User-Token": token,
  };
}

export default function ChatApp({ initialThreadId }: { initialThreadId: string | null }) {
  return (
    <CopilotKit
      runtimeUrl={runtimeUrl}
      agent="pali_agent"
      useSingleEndpoint={false}
      headers={wikipaliHeaders}
      // 开发调试面板与 web inspector（localhost 上默认出现）会去外站拉字体和公告，
      // CSP 不放行，也用不到
      showDevConsole={false}
      enableInspector={false}
    >
      <AppLayout initialThreadId={initialThreadId} />
    </CopilotKit>
  );
}
