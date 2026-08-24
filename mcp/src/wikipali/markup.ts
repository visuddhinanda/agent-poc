/**
 * HTML 清洗与展示辅助（对应 lib/cmd_read.py 里的 strip_markup / snippet 等）。
 *
 * 关键保留项：
 *  - 命中词 <span class='hl'> → 【…】
 *  - 黑体 <span class="bld"> → **…**（注释书标出词条的地方，判断「是不是定义」靠它）
 *  - <code>M1.1</code> → [M1.1]（版本页码，必须留在原位；M=缅甸版 V=VRI P=PTS T=泰版）
 */

const HL_RE = /<span class='hl'>(.*?)<\/span>/gs;
const BLD_RE = /<span class="bld">(.*?)<\/span>/gs;
const CODE_RE = /<code>([^<]*)<\/code>/gs;
const TPL_RE = /<MdTpl[^>]*><\/MdTpl>/gs;
const TAG_RE = /<[^>]+>/gs;
const WS_RE = /\s+/g;

export function stripMarkup(raw: unknown, hl: [string, string] = ["【", "】"], bold = "**"): string {
  if (!raw) return "";
  let text = String(raw);
  text = text.replace(HL_RE, `${hl[0]}$1${hl[1]}`);
  text = text.replace(BLD_RE, `${bold}$1${bold}`);
  text = text.replace(CODE_RE, "[$1]");
  text = text.replace(TPL_RE, "");
  text = text.replace(TAG_RE, "");
  text = decodeHtmlEntities(text);
  return text.replace(WS_RE, " ").trim();
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
  };
  return text
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => named[m] ?? m)
    .replace(/&#(\d+);/g, (_m, code: string) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return "";
      }
    });
}

export function snippet(text: string, width: number, around?: string): string {
  if (text.length <= width) return text;
  if (around) {
    const pos = text.indexOf(around);
    if (pos > width / 2) {
      const start = Math.max(0, pos - Math.floor(width / 3));
      return `…${text.slice(start, start + width)}…`;
    }
  }
  return `${text.slice(0, width)}…`;
}

// 巴利原文本身就是一个 channel。取原文、取译文、取逐词解析是同一个调用换 channel。
export const PALI_CHANNEL = "00b577c0-13b9-11ee-a05a-b7307efd9ee6";

// 靠 channel 名字判断机器译文很脆弱，仅用于「提醒去核实」，不作为判定依据。
export const MACHINE_HINTS = [
  "ai", "gpt", "chatgpt", "claude", "deepseek", "gemini", "qwen", "grok",
  "llama", "mistral", "kimi", "norbu", "豆包", "文心", "ernie", "通义",
];

export function looksMachine(channelName: unknown): boolean {
  const n = String(channelName ?? "").toLowerCase();
  return MACHINE_HINTS.some((h) => n.includes(h));
}
