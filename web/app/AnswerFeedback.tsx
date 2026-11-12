"use client";

/**
 * AI 回答下方的反馈栏（与 mobile 的 AnswerFeedback 同一套交互）：
 *
 * - 👍 一键完成，原地展开可选标签，不弹窗；再点一次撤回；
 * - 👎 按概率弹出原因表单（内测期 100%，beta 用户永远 100%），「其他」带文本框；再点一次撤回；
 * - 没评价时按概率问一句「这个回答有帮助吗？」（beta 用户永远问）；
 * - 复制、重新生成顺带记成隐式信号。
 *
 * 评价是给管理员改进回答用的：「用于改进回答」关着时，点赞 / 点踩先弹窗征得同意，同意就把开关打开再评价，
 * 不同意就不评价；开关关着时也不主动询问。服务端把被评价的那次提问记成 improve=true。
 * 内测期间不允许关闭（`IMPROVE_OPT_OUT_ALLOWED`），开关恒为开，这个弹窗不会出现；放开关闭后自动生效。
 */
import { useEffect, useRef, useState } from "react";
import { rateAnswer, reportEvent, retractRating } from "@/lib/mint";
import {
  DOWN_REASONS,
  TAG_LABELS,
  UP_TAGS,
  loadRatings,
  saveRating,
  shouldAsk,
  shouldShowDownvoteForm,
  type FeedbackTag,
} from "@/lib/feedback";
import { getDeviceId } from "@/lib/session";

const ink = "#3a3128";
const faint = "#9a8c76";
const vermilion = "#8c3b2e";

const iconBtn = (on: boolean): React.CSSProperties => ({
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 15,
  padding: "2px 4px",
  color: on ? vermilion : faint,
  filter: on ? "none" : "grayscale(1)",
  opacity: on ? 1 : 0.75,
});

const chipStyle = (on: boolean): React.CSSProperties => ({
  border: `1px solid ${on ? vermilion : "#d8cdb4"}`,
  background: on ? vermilion : "#efe8d8",
  color: on ? "#fdfaf1" : "#6b5f4e",
  borderRadius: 999,
  padding: "3px 10px",
  fontSize: 12,
  cursor: "pointer",
});

/** 同一页面里每条回答的「询问已显示」只报一次。 */
const askReported = new Set<string>();

export function AnswerFeedback({
  messageId,
  threadId,
  text,
  beta,
  improve,
  onEnableImprove,
  onRegenerate,
}: {
  messageId: string;
  threadId: string | null;
  text: string;
  beta: boolean;
  improve: boolean;
  onEnableImprove: () => void;
  onRegenerate?: () => void;
}) {
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [upTags, setUpTags] = useState<FeedbackTag[]>([]);
  const [chipsOpen, setChipsOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [reasons, setReasons] = useState<FeedbackTag[]>([]);
  const [other, setOther] = useState("");
  const [note, setNote] = useState("");
  const askedRef = useRef(false);
  const asking = loaded && improve && rating === null && shouldAsk(messageId, beta);
  // 等用户同意后要做的那一步（点赞或点踩）
  const [pending, setPending] = useState<(() => void) | null>(null);

  /** 「用于改进」关着时先征得同意。撤回评价不用问。 */
  const withConsent = (then: () => void) => {
    if (improve) then();
    else setPending(() => then);
  };

  useEffect(() => {
    setRating(loadRatings()[messageId] ?? null);
    setLoaded(true);
  }, [messageId]);

  useEffect(() => {
    if (!asking) return;
    askedRef.current = true;
    if (askReported.has(messageId)) return;
    askReported.add(messageId);
    void reportEvent(messageId, "ask_shown", getDeviceId());
  }, [asking, messageId]);

  const submit = async (value: 1 | -1 | null, tags: FeedbackTag[] = [], comment?: string) => {
    const previous = rating;
    setRating(value);
    try {
      if (value === null) {
        await retractRating(messageId, getDeviceId());
      } else {
        await rateAnswer({
          message_id: messageId,
          thread_id: threadId,
          rating: value,
          tags,
          comment,
          asked: askedRef.current,
          device_id: getDeviceId(),
        });
      }
      saveRating(messageId, value);
      return true;
    } catch {
      setRating(previous);
      setNote("提交失败，请稍后再试");
      return false;
    }
  };

  const tapUp = () => {
    setNote("");
    if (rating === 1) {
      setChipsOpen(false);
      setUpTags([]);
      void submit(null);
      return;
    }
    withConsent(() => {
      setUpTags([]);
      setChipsOpen(true);
      void submit(1);
    });
  };

  const toggleUpTag = (tag: FeedbackTag) => {
    const next = upTags.includes(tag) ? upTags.filter((x) => x !== tag) : [...upTags, tag];
    setUpTags(next);
    void submit(1, next);
  };

  const tapDown = () => {
    setNote("");
    setChipsOpen(false);
    if (rating === -1) {
      void submit(null);
      return;
    }
    withConsent(() => {
      if (shouldShowDownvoteForm(messageId, beta)) {
        setReasons([]);
        setOther("");
        setFormOpen(true);
      } else {
        void submit(-1);
      }
    });
  };

  const sendForm = async (withReasons: boolean) => {
    setFormOpen(false);
    const tags = withReasons ? reasons : [];
    if (await submit(-1, tags, tags.includes("other") ? other.trim() || undefined : undefined)) {
      setNote("谢谢反馈");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNote("已复制");
    } catch {
      setNote("复制失败");
    }
    void reportEvent(messageId, "copy", getDeviceId());
  };

  const regenerate = () => {
    onRegenerate?.();
    void reportEvent(messageId, "regenerate", getDeviceId());
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "4px 0 12px" }}>
      {asking ? <div style={{ fontSize: 13, color: "#6b5f4e" }}>这个回答有帮助吗？</div> : null}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button type="button" aria-label="有帮助" aria-pressed={rating === 1} style={iconBtn(rating === 1)} onClick={tapUp}>
          👍
        </button>
        <button type="button" aria-label="没帮助" aria-pressed={rating === -1} style={iconBtn(rating === -1)} onClick={tapDown}>
          👎
        </button>
        <button type="button" aria-label="复制" style={{ ...iconBtn(false), fontSize: 13 }} onClick={() => void copy()}>
          复制
        </button>
        {onRegenerate ? (
          <button type="button" aria-label="重新生成" style={{ ...iconBtn(false), fontSize: 13 }} onClick={regenerate}>
            重新生成
          </button>
        ) : null}
        {note ? <span style={{ fontSize: 12, color: faint }}>{note}</span> : null}
      </div>

      {chipsOpen && rating === 1 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {UP_TAGS.map((tag) => (
            <button key={tag} type="button" style={chipStyle(upTags.includes(tag))} aria-pressed={upTags.includes(tag)} onClick={() => toggleUpTag(tag)}>
              {TAG_LABELS[tag]}
            </button>
          ))}
          <button type="button" aria-label="收起" style={iconBtn(false)} onClick={() => setChipsOpen(false)}>
            ✕
          </button>
        </div>
      ) : null}

      {pending ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="质量反馈将用于改进"
          style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(58,49,40,.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={(e) => e.target === e.currentTarget && setPending(null)}
        >
          <div style={{ background: "#fdfaf1", borderRadius: 12, padding: 20, width: "100%", maxWidth: 400, display: "flex", flexDirection: "column", gap: 12, color: ink }}>
            <div style={{ fontWeight: 600 }}>质量反馈将用于改进</div>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: "#6b5f4e" }}>
              评价会连同这次的提问和回答，交给管理员用来改进回答，同时会打开「提问用于改进回答」。不同意就不能评价。
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 16, alignItems: "center" }}>
              <button type="button" style={{ border: "none", background: "transparent", color: "#6b5f4e", cursor: "pointer" }} onClick={() => setPending(null)}>
                不同意
              </button>
              <button
                type="button"
                style={{ border: "none", background: vermilion, color: "#fdfaf1", borderRadius: 999, padding: "6px 16px", cursor: "pointer" }}
                onClick={() => {
                  const then = pending;
                  setPending(null);
                  onEnableImprove();
                  then();
                }}
              >
                同意
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {formOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="哪里不好"
          style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(58,49,40,.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={(e) => e.target === e.currentTarget && void sendForm(false)}
        >
          <div style={{ background: "#fdfaf1", borderRadius: 12, padding: 20, width: "100%", maxWidth: 440, display: "flex", flexDirection: "column", gap: 12, color: ink }}>
            <div style={{ fontWeight: 600 }}>哪里不好？（可多选）</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {DOWN_REASONS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  style={chipStyle(reasons.includes(tag))}
                  aria-pressed={reasons.includes(tag)}
                  onClick={() => setReasons((r) => (r.includes(tag) ? r.filter((x) => x !== tag) : [...r, tag]))}
                >
                  {TAG_LABELS[tag]}
                </button>
              ))}
            </div>
            {reasons.includes("other") ? (
              <textarea
                id="feedback-other"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                maxLength={1000}
                rows={3}
                autoFocus
                placeholder="说说哪里不好"
                style={{ width: "100%", borderRadius: 8, border: "1px solid #d8cdb4", padding: 8, fontSize: 14, background: "#fff", color: ink }}
              />
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 16, alignItems: "center" }}>
              <button type="button" style={{ border: "none", background: "transparent", color: "#6b5f4e", cursor: "pointer" }} onClick={() => void sendForm(false)}>
                跳过
              </button>
              <button
                type="button"
                style={{ border: "none", background: vermilion, color: "#fdfaf1", borderRadius: 999, padding: "6px 16px", cursor: "pointer" }}
                onClick={() => void sendForm(true)}
              >
                提交
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
