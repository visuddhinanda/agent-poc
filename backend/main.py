"""FastAPI 服务：以 AG-UI 协议暴露 LangGraph agent，供 CopilotKit Runtime 对接。

启动: uvicorn main:app --host 0.0.0.0 --port 8800（或 ./run.sh）
Agent 端点: POST /   （AG-UI RunAgentInput -> SSE 事件流）
"""
import asyncio
import os

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent

from langgraph.checkpoint.memory import MemorySaver

from agent import build_graph, retrieve_sutta_passage
from routing import build_routed_graph
import mint
import quota
import agent_trace
from mcp_tools import load_wikipali_tools, set_wikipali_credentials
from obs import ObsCallback, brief, end_run, log, start_run

AGENT_NAME = "pali_agent"

app = FastAPI(title="Buddhist Pali Q&A Agent (LangGraph + AG-UI)", version="0.1.0")


# 【真实查询】False：连接 MCP server，暴露 wikipali_* 工具给 LLM。
# 【mock 阶段】True：只暴露 retrieve_sutta_passage（结构化 citations 的 mock 检索）。
USE_MOCK_RETRIEVAL_ONLY = False


def _load_tools_and_build_graph():
    """启动时连接无状态 MCP server 加载 wikipali 工具；连不上则回退到 mock 检索工具。

    返回 (graph, mcp_client)。mcp_client 需保持存活（工具内部持有其 session）。
    """
    if USE_MOCK_RETRIEVAL_ONLY:
        print("[mock] 仅暴露 retrieve_sutta_passage（结构化 citations 的 mock 检索）")
        return build_graph(tools=[retrieve_sutta_passage]), None
    try:
        mcp_client, wikipali_tools = asyncio.run(load_wikipali_tools())
        print(f"[mcp] 已连接 MCP server，加载 {len(wikipali_tools)} 个 wikipali 工具")
        if os.getenv("DEEPSEEK_API_KEY") and os.getenv("AGENT_GRAPH", "routed") == "routed":
            # 按问题类型分路径（docs/agent-routing.md）；AGENT_GRAPH=react 切回旧的不设限循环做对照
            print("[graph] routed：plan → passage / term / question → answer")
            return build_routed_graph(wikipali_tools, checkpointer=MemorySaver()), mcp_client
        print("[graph] react：chatbot ⇄ tools")
        return build_graph(tools=wikipali_tools), mcp_client
    except Exception as exc:  # MCP 不可用时降级，保证服务仍能起
        print(f"[warn] 无法连接 MCP server（{exc}），回退到 mock 经文检索工具")
        return build_graph(), None


graph, _mcp_client = _load_tools_and_build_graph()

# 单例 agent：每次请求 clone 一份（LangGraphAgent 用 self.active_run 存请求级状态，
# 共享同一实例会串数据）。clone() 由 ag_ui_langgraph 提供。
_agent = LangGraphAgent(
    name=AGENT_NAME,
    description="巴利经文 AI 问答助手（WikiPali MCP 真实语料 + DeepSeek）",
    graph=graph,
    # ObsCallback：每次 LLM / 工具调用一行日志；recursion_limit 是工具预算之外的兜底
    config={"callbacks": [ObsCallback()], "recursion_limit": 40},
    # RAW 事件把 LangGraph 原始事件整份再发一遍，客户端用不上，只会让 SSE 体积翻倍
    emit_raw_events=False,
)


@app.get("/info")
def info():
    return {
        "service": "buddhist-agent-poc backend",
        "agent": AGENT_NAME,
        "protocol": "AG-UI",
        "agent_endpoint": "POST /",
        "health": "/health",
        "mcp_url": os.getenv("WIKIPALI_MCP_URL", "http://127.0.0.1:3000/mcp"),
        "mcp_connected": _mcp_client is not None,
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
        "base_url": os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        "api_key_configured": bool(os.getenv("DEEPSEEK_API_KEY")),
        "mcp_connected": _mcp_client is not None,
        # 研究过程入库与提问扣费是否开启（ops 上线后确认这一项为 true）
        "trace_enabled": mint.enabled(),
    }


@app.post("/")
async def agent_endpoint(input_data: RunAgentInput, request: Request):
    """AG-UI 端点：CopilotKit Runtime 的 LangGraphHttpAgent({ url: "http://<host>:8800" }) 对接这里。

    后端无状态：写端凭据不落盘、不来自环境变量，只从当前请求头里取
    （Authorization: Bearer <modelToken>、X-Wikipali-User-Token: <userToken>），
    注入 contextvar 供本次请求的 MCP 工具调用透传给 wikipali MCP server。
    """
    accept = request.headers.get("accept")
    encoder = EventEncoder(accept=accept)
    request_agent = _agent.clone()

    async def event_generator():
        set_wikipali_credentials(
            authorization=request.headers.get("Authorization"),
            user_token=request.headers.get("X-Wikipali-User-Token"),
        )
        stats = start_run(input_data.run_id, input_data.thread_id)
        state = input_data.state if isinstance(input_data.state, dict) else {}
        ctx = mint.ClientContext.from_request(request.headers, state)
        last_user = next(
            (m for m in reversed(input_data.messages or []) if getattr(m, "role", None) == "user"),
            None,
        )
        content = getattr(last_user, "content", "") or ""
        stats.question = content if isinstance(content, str) else str(content)
        stats.user_message_id = getattr(last_user, "id", None)
        stats.deep = bool(state.get("deep_thinking"))
        stats.passage = state.get("passage") if isinstance(state.get("passage"), dict) else None
        log(
            "start",
            thread=input_data.thread_id,
            msgs=len(input_data.messages or []),
            state=brief({k: v for k, v in state.items() if k != "client"}, 400),
            q=brief(stats.question, 120),
        )

        charge = await quota.charge(ctx, input_data.run_id, input_data.thread_id, stats.deep)
        if charge.status in ("forbidden", "unavailable", "invalid"):
            # 不跑研究、不扣费，只回一条说明：别人的会话 / 网络访问错误 / 请求无效
            for event in quota.denied_events(input_data.thread_id, input_data.run_id, charge.data or {}, quota_card=False):
                yield encoder.encode(event)
            end_run(None)
            # 网络错误那次也要有记录：mint 连不上时进补发队列，恢复后补上。
            # 别人的会话、请求无效的入库同样会被 mint 拒，不必发
            if charge.status == "unavailable":
                agent_trace.submit(stats, ctx, "denied")
            return
        if charge.status == "denied":
            for event in quota.denied_events(input_data.thread_id, input_data.run_id, charge.data or {}):
                yield encoder.encode(event)
            end_run(None)
            agent_trace.submit(stats, ctx, "denied")
            return

        error = None
        try:
            async for event in request_agent.run(input_data):
                yield encoder.encode(event)
        except BaseException as exc:  # 含客户端断连（CancelledError），汇总行照样要打
            error = exc
            raise
        finally:
            end_run(error)
            if error is None:
                agent_trace.submit(stats, ctx, "ok")
            elif isinstance(error, (asyncio.CancelledError, GeneratorExit)):
                agent_trace.submit(stats, ctx, "cancelled", repr(error)[:2000])
            else:
                agent_trace.submit(stats, ctx, "error", repr(error)[:2000])

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type(),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8800, reload=True)
