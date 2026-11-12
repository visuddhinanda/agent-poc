/**
 * web chat 调 mint v3 的几个接口：当前用户、额度、会话历史。
 *
 * 线上同源（next.wikipali.org/api），本地开发用 NEXT_PUBLIC_MINT_API_URL 指到 mint（如
 * http://127.0.0.1:8000/api）。v3 成功看 HTTP 状态码，失败是 Problem Details。
 */
import { getToken, uiLocale } from "./session";

const API = (process.env.NEXT_PUBLIC_MINT_API_URL || "/api").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Accept-Language": uiLocale(),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    throw new ApiError(res.status, problem?.detail || problem?.title || `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface Me {
  id: string;
  nickName: string;
  userName: string;
  avatar: string | null;
  roles: string[] | null;
}

export async function fetchMe(): Promise<Me> {
  return (await call<{ data: Me }>("/v3/me")).data;
}

export interface Quota {
  account_type: "user" | "guest";
  free_remaining: number;
  earned_balance: number;
  cost: { normal: number; deep: number };
}

export async function fetchQuota(deviceId: string): Promise<Quota> {
  return (await call<{ data: Quota }>(`/v3/agent-quota?device_id=${encodeURIComponent(deviceId)}`)).data;
}

export interface Thread {
  thread_id: string;
  title: string;
  archived_at: string | null;
  last_run_at: string;
}

export interface ThreadRun {
  run_id: string;
  question: string;
  answer: string | null;
  citations: Record<string, unknown>[] | null;
  user_message_id: string | null;
  assistant_message_id: string | null;
}

export async function listThreads(archived: boolean, page = 1) {
  const res = await call<{ data: Thread[]; meta: { current_page: number; last_page: number } }>(
    `/v3/me/agent-threads?filter[archived]=${archived}&page=${page}&per_page=30`,
  );
  return { items: res.data, hasMore: res.meta.current_page < res.meta.last_page };
}

export async function fetchThread(threadId: string) {
  return (await call<{ data: Thread & { runs: ThreadRun[] } }>(`/v3/me/agent-threads/${threadId}`)).data;
}

export async function renameThread(threadId: string, title: string) {
  return (
    await call<{ data: Thread }>(`/v3/me/agent-threads/${threadId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    })
  ).data;
}

export async function setThreadArchived(threadId: string, archived: boolean) {
  return (
    await call<{ data: Thread }>(`/v3/me/agent-threads/${threadId}/archive`, {
      method: archived ? "PUT" : "DELETE",
    })
  ).data;
}

export async function deleteThread(threadId: string) {
  await call(`/v3/me/agent-threads/${threadId}`, { method: "DELETE" });
}

/** 评价一条回答（再次提交即更新）。`message_id` 是 AG-UI 的回答消息 id。 */
export async function rateAnswer(body: {
  message_id: string;
  thread_id?: string | null;
  rating: 1 | -1;
  tags?: string[];
  comment?: string;
  asked?: boolean;
  device_id: string;
}) {
  await call("/v3/agent-feedback", { method: "POST", body: JSON.stringify({ ...body, client: "web" }) });
}

export async function retractRating(messageId: string, deviceId: string) {
  await call(`/v3/agent-feedback/${encodeURIComponent(messageId)}?device_id=${deviceId}`, { method: "DELETE" });
}

/** 隐式信号：复制、点开引用、重新生成、主动询问显示过。失败不打扰用户。 */
export async function reportEvent(
  messageId: string,
  kind: "copy" | "citation_open" | "regenerate" | "ask_shown",
  deviceId: string,
) {
  await call("/v3/agent-events", {
    method: "POST",
    body: JSON.stringify({ message_id: messageId, kind, device_id: deviceId, client: "web" }),
  }).catch(() => undefined);
}
