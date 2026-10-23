"""运行日志：一次 agent 运行（AG-UI run）一个上下文，四层日志用同一个 request id 对得上。

- request id 用 AG-UI 的 run_id；经 X-Request-Id 头透传给 MCP（见 mcp_tools.py）。
- RunStats 记这一次运行的路由、LLM 调用次数、工具调用次数、补查次数与耗时，结束时打一行汇总：
      [run] rid=… route=question deep=false llm=3 tools=4 retries=0 ms=8123
- ObsCallback 是 LangChain 回调：每次 LLM 调用（模型、是否思考、token、耗时）
  和每次工具调用（名称、参数、结果大小、耗时）各一行。
- AGENT_LOG=0 关闭。
"""
from __future__ import annotations

import json
import logging
import os
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from langchain_core.callbacks import AsyncCallbackHandler

_enabled = os.getenv("AGENT_LOG", "1") != "0"

logger = logging.getLogger("agent")
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)
    logger.propagate = False


def brief(value: Any, limit: int = 200) -> str:
    """截断长值，日志里只要看得出是什么。"""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:  # noqa: BLE001
            text = str(value)
    return text if len(text) <= limit else f"{text[:limit]}…({len(text)})"


@dataclass
class RunStats:
    rid: str = "-"
    thread: str = "-"
    started: float = field(default_factory=time.monotonic)
    route: str = "-"
    deep: bool = False
    llm_calls: int = 0
    tool_calls: int = 0
    retries: int = 0


_run: ContextVar[RunStats | None] = ContextVar("agent_run", default=None)


def start_run(rid: str, thread: str) -> RunStats:
    stats = RunStats(rid=rid or "-", thread=thread or "-")
    _run.set(stats)
    return stats


def current_run() -> RunStats:
    stats = _run.get()
    if stats is None:
        stats = RunStats()
        _run.set(stats)
    return stats


def log(tag: str, **fields: Any) -> None:
    if not _enabled:
        return
    stats = _run.get()
    rid = stats.rid if stats else "-"
    parts = []
    for key, value in fields.items():
        if value is None:
            continue
        text = value if isinstance(value, str) and " " not in value else brief(value)
        parts.append(f"{key}={text}")
    logger.info(f"[{tag}] rid={rid} {' '.join(parts)}")


def end_run(error: BaseException | None = None) -> None:
    stats = _run.get()
    if stats is None:
        return
    log(
        "run",
        thread=stats.thread,
        route=stats.route,
        deep=str(stats.deep).lower(),
        llm=stats.llm_calls,
        tools=stats.tool_calls,
        retries=stats.retries,
        ms=int((time.monotonic() - stats.started) * 1000),
        error=brief(repr(error), 300) if error else None,
    )


class ObsCallback(AsyncCallbackHandler):
    """LLM / 工具调用计时。按 run_id 记开始时间，结束时出一行。"""

    def __init__(self) -> None:
        self._starts: dict[Any, tuple[float, str]] = {}

    async def on_chat_model_start(self, serialized, messages, *, run_id, metadata=None, invocation_params=None, **kwargs):
        if (metadata or {}).get("obs_skip"):
            return  # 程序发出的工具调用（routing._CallEmitter），不是真的 LLM 调用
        params = invocation_params or kwargs.get("invocation_params") or {}
        thinking = ((params.get("extra_body") or {}).get("thinking") or {}).get("type", "default")
        node = (metadata or {}).get("langgraph_node", "-")
        self._starts[run_id] = (time.monotonic(), f"{node}|{thinking}|{len(messages[0]) if messages else 0}")
        current_run().llm_calls += 1

    async def on_llm_end(self, response, *, run_id, **kwargs):
        if run_id not in self._starts:
            return
        started, info = self._starts.pop(run_id)
        node, thinking, n_msgs = info.split("|")
        usage = {}
        try:
            msg = response.generations[0][0].message
            usage = getattr(msg, "usage_metadata", None) or {}
            tool_calls = [tc.get("name") for tc in (getattr(msg, "tool_calls", None) or [])]
        except Exception:  # noqa: BLE001
            tool_calls = []
        log(
            "llm",
            node=node,
            thinking=thinking,
            msgs=n_msgs,
            ms=int((time.monotonic() - started) * 1000),
            tin=usage.get("input_tokens"),
            tout=usage.get("output_tokens"),
            tool_calls=",".join(tool_calls) if tool_calls else None,
        )

    async def on_llm_error(self, error, *, run_id, **kwargs):
        started, _ = self._starts.pop(run_id, (time.monotonic(), ""))
        log("llm", ms=int((time.monotonic() - started) * 1000), error=brief(repr(error), 300))

    async def on_tool_start(self, serialized, input_str, *, run_id, inputs=None, **kwargs):
        name = (serialized or {}).get("name", "?")
        self._starts[run_id] = (time.monotonic(), name)
        current_run().tool_calls += 1
        log("tool>", name=name, args=brief(inputs if inputs is not None else input_str, 300))

    async def on_tool_end(self, output, *, run_id, **kwargs):
        started, name = self._starts.pop(run_id, (time.monotonic(), "?"))
        content = getattr(output, "content", output)
        log("tool<", name=name, ms=int((time.monotonic() - started) * 1000), chars=len(str(content)))

    async def on_tool_error(self, error, *, run_id, **kwargs):
        started, name = self._starts.pop(run_id, (time.monotonic(), "?"))
        log("tool<", name=name, ms=int((time.monotonic() - started) * 1000), error=brief(repr(error), 300))
