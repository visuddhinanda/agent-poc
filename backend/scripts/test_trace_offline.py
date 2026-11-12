"""研究过程入库 / 提问扣费的离线自检（不连网、不调 LLM；mint 用 httpx.MockTransport 假装）。

用法：.venv/bin/python scripts/test_trace_offline.py
"""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEEPSEEK_API_KEY", "offline")
os.environ["AGENT_MINT_API_URL"] = "http://mint.test/api"
os.environ["AGENT_SERVICE_KEY"] = "k"
os.environ["TRACE_SPOOL"] = str(Path(tempfile.mkdtemp()) / "spool.jsonl")

import httpx  # noqa: E402

import agent_trace  # noqa: E402
import mint  # noqa: E402
import quota  # noqa: E402
from obs import ObsCallback, log, start_run  # noqa: E402


def use_mint(handler) -> list:
    """把 mint 换成本地处理函数，返回收到的请求列表。"""
    seen = []

    def wrapped(request: httpx.Request):
        seen.append(request)
        return handler(request)

    mint._client = httpx.AsyncClient(transport=httpx.MockTransport(wrapped))
    return seen


def test_client_context():
    headers = httpx.Headers({"X-Wikipali-User-Token": "tok", "X-Wikipali-Client-IP": "203.0.113.5", "X-Forwarded-For": "10.9.9.9"})
    ctx = mint.ClientContext.from_request(headers, {"client": {"device_id": "d", "improve": False, "client": "web", "locale": "zh-Hans"}})
    assert (ctx.user_token, ctx.client_ip, ctx.device_id, ctx.improve, ctx.client) == ("tok", "203.0.113.5", "d", False, "web"), ctx
    h = ctx.headers()
    assert h["Authorization"] == "Bearer tok" and h["X-Agent-Service-Key"] == "k" and h["Accept-Language"] == "zh-Hans"
    # 缺省：允许改进、未知客户端名丢弃
    ctx = mint.ClientContext.from_request(httpx.Headers({}), {"client": {"client": "evil"}})
    assert ctx.improve is True and ctx.client is None and "Authorization" not in ctx.headers()


async def test_steps_and_citations():
    stats = start_run("r1", "t1")
    log("route", route="term", raw="term")
    log("quota", result="charged", cost=10)
    log("start", q="不进 steps")
    cb = ObsCallback()
    await cb.on_tool_start({"name": "wikipali_search"}, "", run_id="x", inputs={"lemma": "mettā"})
    rows = {"count": 1, "rows": [{"coord": "1-2", "link": "https://w/1-2", "cite": "[a](https://w/1-2)", "highlight": "h" * 900, "path": "p"}]}
    await cb.on_tool_end(json.dumps(rows), run_id="x")
    kinds = [(s["kind"], s.get("name")) for s in stats.steps]
    assert kinds == [("route", None), ("event", "quota"), ("tool", "wikipali_search")], kinds
    tool = stats.steps[2]
    assert tool["args"] == {"lemma": "mettā"} and tool["result_chars"] > 900
    cite = stats.citations["https://w/1-2"]
    assert cite["cite"] == "[a](https://w/1-2)" and len(cite["highlight"]) == 500 and "path" not in cite


async def test_charge_paths():
    ctx = mint.ClientContext(device_id="d", client_ip="192.0.2.1")
    use_mint(lambda r: httpx.Response(201, json={"data": {"cost": 10, "free_remaining": 90}}))
    assert (await quota.charge(ctx, "r", "t", False)).status == "charged"
    problem = {"type": "urn:problem:quota-exceeded", "status": 402, "detail": "用完了", "reason": "insufficient"}
    use_mint(lambda r: httpx.Response(402, json=problem))
    denied = await quota.charge(ctx, "r", "t", True)
    assert denied.status == "denied" and denied.data["reason"] == "insufficient"
    events = quota.denied_events("t", "r", denied.data)
    assert [e.type.value for e in events] == ["RUN_STARTED", "CUSTOM", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]
    assert events[1].name == "quota_exceeded" and events[3].delta == "用完了"

    # 别人的会话：明确拒绝，不放行；只回文字，不发 quota_exceeded
    sent = {}

    def forbidden(request):
        sent.update(json.loads(request.content))
        return httpx.Response(403, json={"status": 403, "detail": "这个会话属于别的账号，请新开一个会话。"})

    use_mint(forbidden)
    refused = await quota.charge(ctx, "r", "t-other", False)
    assert refused.status == "forbidden" and sent["thread_id"] == "t-other"
    events = quota.denied_events("t-other", "r", refused.data, quota_card=False)
    assert [e.type.value for e in events] == ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]

    # mint 连不上 / 5xx：不放行，回「网络访问错误」（按界面语言），说明消息不是额度卡片
    def down(request):
        raise httpx.ConnectError("down")

    use_mint(down)
    gone = await quota.charge(mint.ClientContext(device_id="d", client_ip="192.0.2.1", locale="zh-Hans"), "r", "t", False)
    assert gone.status == "unavailable" and gone.data["detail"] == "网络访问错误，请稍后重试。", gone
    use_mint(lambda r: httpx.Response(503, json={"status": 503}))
    assert (await quota.charge(ctx, "r", "t", False)).status == "unavailable"
    notice_events = quota.denied_events("t", "r", gone.data, quota_card=False)
    assert notice_events[1].message_id.startswith("notice-") and "CUSTOM" not in [e.type.value for e in notice_events]

    # mint 说请求不合格（422 等）：不放行
    use_mint(lambda r: httpx.Response(422, json={"status": 422, "errors": {"device_id": ["x"]}}))
    assert (await quota.charge(ctx, "r", "t", False)).status == "invalid"

    # 游客没带设备 id：不问 mint，直接拒绝
    def must_not_call(request):
        raise AssertionError("不该请求 mint")

    use_mint(must_not_call)
    assert (await quota.charge(mint.ClientContext(), "r", "t", False)).status == "invalid"
    # 游客拿不到客户端 IP（绕过 runtime）：同样不问 mint，直接拒绝
    assert (await quota.charge(mint.ClientContext(device_id="d"), "r", "t", False)).status == "invalid"
    # 登录用户（带 token）不需要设备 id
    use_mint(lambda r: httpx.Response(201, json={"data": {"cost": 10}}))
    assert (await quota.charge(mint.ClientContext(user_token="tok"), "r", "t", False)).status == "charged"


async def test_trace_spool_and_drain():
    stats = start_run("r-spool", "t")
    stats.question = "q"
    ctx = mint.ClientContext(device_id="d", improve=False)
    body = agent_trace.payload(stats, ctx, "ok", None)
    assert body["improve"] is False and body["route"] is None and body["prompt_version"]

    def down(request):
        raise httpx.ConnectError("down")

    use_mint(down)
    await agent_trace._send({"ctx": ctx.__dict__, "body": body})
    spool = Path(os.environ["TRACE_SPOOL"])
    assert len(spool.read_text().splitlines()) == 1

    seen = use_mint(lambda r: httpx.Response(201, json={"data": {}}))
    other = {**body, "run_id": "r-next"}
    await agent_trace._send({"ctx": ctx.__dict__, "body": other})
    assert spool.read_text() == "", "补发后队列应清空"
    assert [json.loads(r.content)["run_id"] for r in seen] == ["r-next", "r-spool"]

    # 422 是数据问题：不进队列
    use_mint(lambda r: httpx.Response(422, json={"errors": {}}))
    await agent_trace._send({"ctx": ctx.__dict__, "body": body})
    assert spool.read_text() == ""


if __name__ == "__main__":
    test_client_context()
    asyncio.run(test_steps_and_citations())
    asyncio.run(test_charge_paths())
    asyncio.run(test_trace_spool_and_drain())
    print("ok")
