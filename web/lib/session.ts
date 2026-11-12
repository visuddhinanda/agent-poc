/**
 * web chat 的「这次提问算谁的」：登录 token、游客设备 id、「用于改进回答」开关。
 *
 * web chat 部署在 next.wikipali.org/agent，与 dashboard-v6（/pcd-v2026/）同源：
 * - 登录走 dashboard-v6 的登录页，登录后它把 token 写进 localStorage / sessionStorage["token"]，
 *   这里直接读（读法与 dashboard-v6 的 reducers/session.ts 一致：sessionStorage 优先）；
 * - 本页面自己的键一律加 `agent/` 前缀，免得和 dashboard-v6 的键冲突。
 *
 * 设计见 docs/trace.md。
 */

const DEVICE_KEY = "agent/device_id";
const IMPROVE_KEY = "agent/improve";

/** dashboard-v6 的地址（同源路径）。本地开发跨端口时用绝对地址覆盖。 */
const DASHBOARD_URL = process.env.NEXT_PUBLIC_DASHBOARD_URL || "/pcd-v2026";

function storage(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return storage("session")?.getItem("token") ?? storage("local")?.getItem("token") ?? null;
}

/** 退出：与 dashboard-v6 的退出一样清两处（同源，两边一起退出）。 */
export function signOut(): void {
  storage("session")?.removeItem("token");
  storage("local")?.removeItem("token");
}

/**
 * dashboard-v6 登录页，登录后回到新对话页。它的 `safeReturnUrl` 只接受同源地址，
 * 所以线上必须同源部署（next.wikipali.org/agent ↔ next.wikipali.org/pcd-v2026）。
 */
export function signInUrl(): string {
  // 登录后回到「新对话」而不是当前会话：会话 id（AG-UI threadId）全局唯一、属于提问时的账号，
  // 游客的会话登录后不能接着问（mint 403），也不并入账号
  const back = `${window.location.origin}${process.env.NEXT_PUBLIC_BASE_PATH || ""}/chat`;
  return `${DASHBOARD_URL}/anonymous/sign-in?url=${encodeURIComponent(btoa(back))}`;
}

/** 游客设备匿名 id：本浏览器生成一次，存着复用。清掉浏览器数据就换一个（同 IP 另有额度上限）。 */
export function getDeviceId(): string {
  const store = storage("local");
  let id = store?.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    store?.setItem(DEVICE_KEY, id);
  }
  return id;
}

/**
 * 是否允许用户关闭「用于改进回答」。内测期间为 false：开关机制、数据库字段、统计照旧，
 * 只是一律按「开」处理（以前存下的「关」也不认），界面上只留提示、不给关闭按钮。
 * 与 mobile `src/settings/ai.ts` 的同名常量一起改。
 * TODO: 写好在线用户协议后，在提示里加协议链接，再决定是否放开关闭。
 */
export const IMPROVE_OPT_OUT_ALLOWED = false;

export function getImprove(): boolean {
  if (!IMPROVE_OPT_OUT_ALLOWED) return true;
  return storage("local")?.getItem(IMPROVE_KEY) !== "0";
}

export function setImprove(on: boolean): void {
  if (!IMPROVE_OPT_OUT_ALLOWED && !on) return;
  storage("local")?.setItem(IMPROVE_KEY, on ? "1" : "0");
}

/** 浏览器语言 → mint 支持的 8 个界面语言（Accept-Language / state.client.locale 用）。 */
export function uiLocale(): string {
  const lang = (typeof navigator !== "undefined" && navigator.language) || "zh-CN";
  const lower = lang.toLowerCase();
  if (lower.startsWith("zh")) {
    return /tw|hk|mo|hant/.test(lower) ? "zh-Hant" : "zh-Hans";
  }
  const base = lower.split("-")[0];
  return ["en", "my", "th", "si", "vi", "lo"].includes(base) ? base : "en";
}

/** 随每次提问经 AG-UI state.client 交给 agent（agent-poc docs/trace.md）。 */
export function clientState() {
  return {
    device_id: getDeviceId(),
    improve: getImprove(),
    client: "web" as const,
    app_version: process.env.NEXT_PUBLIC_APP_VERSION || null,
    locale: uiLocale(),
  };
}
