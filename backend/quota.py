"""提问前扣费（mint `POST /v3/agent-charges`）。规则在 mint 的积分策略里，见 docs/credits.md。

- 额度够 → 放行；
- 402 → 不跑 agent，发一个 AG-UI CUSTOM 事件 `quota_exceeded`（带 mint 的 Problem Details，
  客户端据此显示「额度用完」卡片）和一条文字回复（不认识这个事件的旧客户端也能看到原因）；
- 403 → 这个 threadId 已经属于别的账号（threadId 由客户端生成、全局唯一）：不跑 agent、不扣费、
  不入库，只回一条文字说明（不发 `quota_exceeded`，免得客户端显示成「额度用完」）；
- mint 不可达 / 超时 / 5xx → **不放行**：回「网络访问错误，请稍后重试」，这次记 denied 入库（mint 恢复后
  由补发队列补上）。放行的提问既不扣费、也记不下来，所以不做 fail-open；
- 其余 4xx（422 参数不对等），以及游客没带设备 id 或拿不到客户端 IP → 不放行，回「请求无效」。
- 不是额度用完的说明，消息 id 用 `notice-` 前缀（客户端当普通提示显示）；额度用完用 `quota-`（客户端画额度卡片）。
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Optional

from ag_ui.core import (
    CustomEvent,
    EventType,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)

import mint
from obs import log

QUOTA_EVENT = "quota_exceeded"


@dataclass
class Charge:
    status: str  # charged / denied / forbidden / unavailable / invalid / skipped
    data: Optional[dict] = None


# 不跑研究时回给用户的说明（mint 连不上就拿不到它的文案，所以 backend 自带）
NOTICES = {
    "unavailable": {
        "zh-Hans": "网络访问错误，请稍后重试。",
        "zh-Hant": "網路存取錯誤，請稍後重試。",
        "en": "Network error. Please try again later.",
    },
    "invalid": {
        "zh-Hans": "请求无效，请刷新页面或更新 App 后重试。",
        "zh-Hant": "請求無效，請重新整理頁面或更新 App 後重試。",
        "en": "Invalid request. Please refresh the page or update the app and try again.",
    },
}


def notice(kind: str, locale: Optional[str]) -> dict:
    texts = NOTICES[kind]
    lang = locale if locale in texts else ("zh-Hans" if (locale or "").startswith("zh") else "en")
    return {"reason": kind, "detail": texts[lang]}


async def charge(ctx: mint.ClientContext, run_id: str, thread_id: str, deep: bool) -> Charge:
    if not mint.enabled():
        return Charge("skipped")
    # 游客全靠设备 id 认人、算额度：没带就不是正常客户端，不必问 mint
    if not ctx.user_token and not ctx.device_id:
        log("quota", result="invalid", reason="no-device-id")
        return Charge("invalid", notice("invalid", ctx.locale))
    # 游客的同 IP 每日上限靠 runtime 写入的 IP：拿不到（绕过 runtime 直连 backend 等）就不让问
    if not ctx.user_token and not ctx.client_ip:
        log("quota", result="invalid", reason="no-client-ip")
        return Charge("invalid", notice("invalid", ctx.locale))
    body = {"run_id": run_id, "thread_id": thread_id, "deep": deep, "device_id": ctx.device_id, "client_ip": ctx.client_ip}
    try:
        resp = await mint.post("/v3/agent-charges", ctx, body)
    except Exception as exc:  # noqa: BLE001
        # 不放行：放行的提问既不扣费、mint 那边也记不下来
        log("quota", result="unavailable", error=repr(exc)[:200])
        return Charge("unavailable", notice("unavailable", ctx.locale))
    if resp.status_code in (200, 201):
        data = resp.json().get("data") or {}
        log("quota", result="charged", cost=data.get("cost"), free=data.get("free_remaining"), earned=data.get("earned_balance"))
        return Charge("charged", data)
    if resp.status_code == 402:
        problem = resp.json()
        log("quota", result="denied", reason=problem.get("reason"))
        return Charge("denied", problem)
    if resp.status_code == 403:
        problem = resp.json()
        log("quota", result="forbidden", thread=thread_id)
        return Charge("forbidden", problem)
    if resp.status_code >= 500:
        log("quota", result="unavailable", status=resp.status_code, body=resp.text[:200])
        return Charge("unavailable", notice("unavailable", ctx.locale))
    # 其余 4xx（422 参数不对、401 服务密钥不对……）：mint 明确说这个请求不合格，同样不跑
    log("quota", result="invalid", status=resp.status_code, body=resp.text[:200])
    return Charge("invalid", notice("invalid", ctx.locale))


def denied_events(thread_id: str, run_id: str, problem: dict, quota_card: bool = True) -> list:
    """不跑 agent 时代替整次运行的事件序列：额度不足（带 `quota_exceeded`，消息 id `quota-…`，客户端画额度卡片），
    或其他拒绝（`quota_card=False`：会话属于别的账号、网络错误、请求无效——只回文字，消息 id `notice-…`）。"""
    message_id = f"{'quota' if quota_card else 'notice'}-{uuid.uuid4()}"
    text = problem.get("detail") or "Not enough credits for this question."
    return [
        RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id),
        *([CustomEvent(type=EventType.CUSTOM, name=QUOTA_EVENT, value=problem)] if quota_card else []),
        TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=message_id, role="assistant"),
        TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=text),
        TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id),
        RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id),
    ]
