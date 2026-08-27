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

from agent import build_graph, retrieve_sutta_passage
from mcp_tools import load_wikipali_tools, set_wikipali_credentials

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
        async for event in request_agent.run(input_data):
            yield encoder.encode(event)

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type(),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8800, reload=True)
