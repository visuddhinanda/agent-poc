"""研究过程入库：一次运行结束后，把 RunStats 整份送 mint（`POST /v3/agent-traces`）。

- 异步发送，不阻塞也不影响对话；mint 按 run_id 幂等，重发安全；
- 发送失败（网络、超时、5xx）就追加到本地补发队列 `TRACE_SPOOL`（默认 logs/trace-spool.jsonl），
  下一次发送成功后顺带补发。这批记录要用来防滥用，不能因为 mint 一时不可达就丢；
- 用户关掉「用于改进回答」（state.client.improve=false）也照样入库，只是记 improve=false，
  改进回答 / 评测抽题时跳过。

字段对应 mint 的 agent_runs / agent_run_steps，见 docs/trace.md。
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Optional

import mint
from obs import RunStats, logger
from routing import PROMPT_VERSION

_SPOOL = Path(os.getenv("TRACE_SPOOL", Path(__file__).resolve().parent.parent / "logs" / "trace-spool.jsonl"))
_lock = asyncio.Lock()
_tasks: set[asyncio.Task] = set()


def payload(stats: RunStats, ctx: mint.ClientContext, status: str, error: Optional[str]) -> dict:
    return {
        "run_id": stats.rid,
        "thread_id": stats.thread,
        "device_id": ctx.device_id,
        "client_ip": ctx.client_ip,
        "client": ctx.client,
        "app_version": ctx.app_version,
        "locale": ctx.locale,
        "question": stats.question or "（空）",
        "passage": stats.passage,
        "deep": stats.deep,
        "improve": ctx.improve,
        "route": None if stats.route == "-" else stats.route,
        "route_raw": stats.route_raw,
        "confidence": stats.confidence,
        "plan": stats.plan,
        "evidence": stats.evidence,
        "answer": stats.answer,
        "citations": list(stats.citations.values()) or None,
        "model": os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
        "prompt_version": PROMPT_VERSION,
        "llm_calls": stats.llm_calls,
        "tool_calls": stats.tool_calls,
        "retries": stats.retries,
        "tokens_in": stats.tokens_in or None,
        "tokens_out": stats.tokens_out or None,
        "latency_ms": stats.latency_ms(),
        "status": status,
        "error": error,
        "user_message_id": stats.user_message_id,
        "assistant_message_id": stats.assistant_message_id,
        "replaces_message_id": ctx.replaces_message_id,
        "started_at": stats.started_at,
        "steps": stats.steps[:500],
    }


def submit(stats: RunStats, ctx: mint.ClientContext, status: str, error: Optional[str] = None) -> None:
    """在后台发出去（运行结束时调用；不等结果）。"""
    if not mint.enabled():
        return
    body = {"ctx": ctx.__dict__, "body": payload(stats, ctx, status, error)}
    task = asyncio.get_running_loop().create_task(_send(body))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _send(item: dict) -> None:
    if await _post(item):
        await _drain()
    else:
        await _spool(item)


async def _post(item: dict) -> bool:
    ctx = mint.ClientContext(**item["ctx"])
    try:
        resp = await mint.post("/v3/agent-traces", ctx, item["body"])
    except Exception as exc:  # noqa: BLE001
        logger.info(f"[trace] rid={item['body']['run_id']} send failed: {exc!r}"[:300])
        return False
    if resp.status_code in (200, 201):
        return True
    if resp.status_code in (403, 422):
        # 数据本身有问题（422）或会话属于别的账号（403），重发也没用：记日志，不进补发队列。
        # 401（服务密钥不对）照样进队列：改好配置后还能补发
        logger.info(f"[trace] rid={item['body']['run_id']} rejected status={resp.status_code} body={resp.text[:300]}")
        return True
    logger.info(f"[trace] rid={item['body']['run_id']} send failed status={resp.status_code}")
    return False


async def _spool(item: dict) -> None:
    async with _lock:
        _SPOOL.parent.mkdir(parents=True, exist_ok=True)
        with _SPOOL.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(item, ensure_ascii=False) + "\n")


async def _drain() -> None:
    """补发队列里的记录逐条重发，发不出去的留着。"""
    async with _lock:
        if not _SPOOL.exists() or _SPOOL.stat().st_size == 0:
            return
        lines = _SPOOL.read_text(encoding="utf-8").splitlines()
        left = []
        for line in lines:
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if not await _post(item):
                left.append(line)
        _SPOOL.write_text("".join(f"{line}\n" for line in left), encoding="utf-8")
        if len(lines) != len(left):
            logger.info(f"[trace] spool drained {len(lines) - len(left)}, left {len(left)}")
