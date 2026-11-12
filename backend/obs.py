"""运行日志：一次 agent 运行（AG-UI run）一个上下文，四层日志用同一个 request id 对得上。

- request id 用 AG-UI 的 run_id；经 X-Request-Id 头透传给 MCP（见 mcp_tools.py）。
- RunStats 记这一次运行的路由、LLM 调用次数、工具调用次数、补查次数与耗时，结束时打一行汇总：
      [run] rid=… route=question deep=false llm=3 tools=4 retries=0 ms=8123
- ObsCallback 是 LangChain 回调：每次 LLM 调用（模型、是否思考、token、耗时）
  和每次工具调用（名称、参数、结果大小、耗时）各一行。
- AGENT_LOG=0 关闭。

同一份 RunStats 也是研究过程入库的底稿（agent_trace.py 在运行结束后整份送 mint）：
LLM / 工具调用与 route、plan、retry、judge 等节点事件逐条记进 steps，
问题、计划、证据、回答、引用由 main.py 与 routing.py 填进对应字段。
"""
from __future__ import annotations

import json
import logging
import os
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

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


# 节点事件：log() 打这些 tag 时同时记一步进 steps（与 mint agent_run_steps.kind 一致）；
# EVENT_TAGS 记成 kind=event、name=tag
STEP_KINDS = {"route", "plan", "retry", "judge", "passage", "answer", "budget"}
EVENT_TAGS = {"quota"}

# 单步结果送库前截断到多少字（原长另记 result_chars）
STEP_RESULT_CHARS = 8000


@dataclass
class RunStats:
    rid: str = "-"
    thread: str = "-"
    started: float = field(default_factory=time.monotonic)
    started_at: str = ""
    route: str = "-"
    deep: bool = False
    llm_calls: int = 0
    tool_calls: int = 0
    retries: int = 0
    # —— 研究过程入库用（agent_trace.py）——
    question: str = ""
    user_message_id: Optional[str] = None
    passage: Optional[dict] = None
    route_raw: Optional[str] = None
    confidence: Optional[float] = None
    plan: Optional[dict] = None
    evidence: Optional[str] = None
    answer: Optional[str] = None
    assistant_message_id: Optional[str] = None
    tokens_in: int = 0
    tokens_out: int = 0
    steps: list = field(default_factory=list)
    citations: dict = field(default_factory=dict)  # link -> 引用摘要，按出现顺序去重

    def latency_ms(self) -> int:
        return int((time.monotonic() - self.started) * 1000)

    def step(self, kind: str, **fields: Any) -> None:
        self.steps.append({"seq": len(self.steps), "kind": kind, **{k: v for k, v in fields.items() if v is not None}})


_run: ContextVar[RunStats | None] = ContextVar("agent_run", default=None)


def start_run(rid: str, thread: str) -> RunStats:
    stats = RunStats(rid=rid or "-", thread=thread or "-", started_at=datetime.now(timezone.utc).isoformat())
    _run.set(stats)
    return stats


def current_run() -> RunStats:
    stats = _run.get()
    if stats is None:
        stats = RunStats()
        _run.set(stats)
    return stats


def log(tag: str, **fields: Any) -> None:
    stats = _run.get()
    if stats is not None and (tag in STEP_KINDS or tag in EVENT_TAGS):
        args = {k: v for k, v in fields.items() if v is not None}
        if tag in STEP_KINDS:
            stats.step(tag, args=args)
        else:
            stats.step("event", name=tag, args=args)
    if not _enabled:
        return
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
        self._args: dict[Any, Any] = {}

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
        model = None
        try:
            msg = response.generations[0][0].message
            usage = getattr(msg, "usage_metadata", None) or {}
            model = (getattr(msg, "response_metadata", None) or {}).get("model_name")
            tool_calls = [tc.get("name") for tc in (getattr(msg, "tool_calls", None) or [])]
        except Exception:  # noqa: BLE001
            tool_calls = []
        ms = int((time.monotonic() - started) * 1000)
        stats = current_run()
        stats.tokens_in += int(usage.get("input_tokens") or 0)
        stats.tokens_out += int(usage.get("output_tokens") or 0)
        stats.step("llm", name=model, args={"node": node, "thinking": thinking}, ms=ms,
                   tokens_in=usage.get("input_tokens"), tokens_out=usage.get("output_tokens"))
        log(
            "llm",
            node=node,
            thinking=thinking,
            msgs=n_msgs,
            ms=ms,
            tin=usage.get("input_tokens"),
            tout=usage.get("output_tokens"),
            tool_calls=",".join(tool_calls) if tool_calls else None,
        )

    async def on_llm_error(self, error, *, run_id, **kwargs):
        started, _ = self._starts.pop(run_id, (time.monotonic(), ""))
        ms = int((time.monotonic() - started) * 1000)
        current_run().step("llm", ms=ms, error=brief(repr(error), 2000))
        log("llm", ms=ms, error=brief(repr(error), 300))

    async def on_tool_start(self, serialized, input_str, *, run_id, inputs=None, **kwargs):
        name = (serialized or {}).get("name", "?")
        self._starts[run_id] = (time.monotonic(), name)
        self._args[run_id] = inputs if inputs is not None else {"input": input_str}
        current_run().tool_calls += 1
        log("tool>", name=name, args=brief(inputs if inputs is not None else input_str, 300))

    async def on_tool_end(self, output, *, run_id, **kwargs):
        started, name = self._starts.pop(run_id, (time.monotonic(), "?"))
        args = self._args.pop(run_id, None)
        content = getattr(output, "content", output)
        text = _content_text(content)
        ms = int((time.monotonic() - started) * 1000)
        stats = current_run()
        stats.step("tool", name=name, args=_as_dict(args), result=text[:STEP_RESULT_CHARS],
                   result_chars=len(text), ms=ms)
        _collect_citations(stats, text)
        log("tool<", name=name, ms=ms, chars=len(text))

    async def on_tool_error(self, error, *, run_id, **kwargs):
        started, name = self._starts.pop(run_id, (time.monotonic(), "?"))
        args = self._args.pop(run_id, None)
        ms = int((time.monotonic() - started) * 1000)
        current_run().step("tool", name=name, args=_as_dict(args), ms=ms, error=brief(repr(error), 2000))
        log("tool<", name=name, ms=ms, error=brief(repr(error), 300))


def _content_text(content: Any) -> str:
    if isinstance(content, list):
        return "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in content)
    return str(content)


def _as_dict(value: Any) -> Optional[dict]:
    if value is None:
        return None
    return value if isinstance(value, dict) else {"input": value}


def _collect_citations(stats: RunStats, text: str) -> None:
    """wikipali_search 结果里带 link 的行就是回答里会出现的出处；会话历史回放时，
    web 的引用悬浮卡片靠这份摘要（与 web/app/page.tsx 收集 citations 的口径一致）。"""
    try:
        data = json.loads(text)
    except ValueError:
        return
    rows = data if isinstance(data, list) else (data.get("rows") if isinstance(data, dict) else None)
    for row in rows or []:
        if isinstance(row, dict) and row.get("link") and row["link"] not in stats.citations and len(stats.citations) < 200:
            stats.citations[row["link"]] = {
                key: (str(row[key])[:500] if key == "highlight" else row[key])
                for key in ("coord", "passageId", "link", "cite", "ref", "highlight", "book", "paragraph", "title")
                if row.get(key) is not None
            }
