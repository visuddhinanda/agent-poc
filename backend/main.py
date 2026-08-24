"""FastAPI 服务：以 AG-UI 协议暴露 LangGraph agent，供 CopilotKit Runtime 对接。

启动: uvicorn main:app --host 0.0.0.0 --port 8000（或 ./run.sh）
Agent 端点: POST /   （AG-UI RunAgentInput -> SSE 事件流）
"""
import asyncio
import os

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint

from agent import build_graph, retrieve_sutta_passage
from mcp_tools import load_wikipali_tools

AGENT_NAME = "pali_agent"

app = FastAPI(title="Buddhist Pali Q&A Agent (LangGraph + AG-UI)", version="0.1.0")


# 【mock 阶段】只暴露 retrieve_sutta_passage（返回结构化 citations 的 mock 检索），
# 确保前端 useRenderTool 的「引用卡片」链路先跑通。
# 接真实 RAG 时置为 False：恢复 [retrieve_sutta_passage, *wikipali_tools]，
# 并把 retrieve_sutta_passage 内部改为调用 wikipali MCP 返回真实 citations。
USE_MOCK_RETRIEVAL_ONLY = True


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
        tools = [retrieve_sutta_passage, *wikipali_tools]
        return build_graph(tools=tools), mcp_client
    except Exception as exc:  # MCP 不可用时降级，保证服务仍能起
        print(f"[warn] 无法连接 MCP server（{exc}），回退到 mock 经文检索工具")
        return build_graph(), None


graph, _mcp_client = _load_tools_and_build_graph()


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


# AG-UI 端点：CopilotKit Runtime 的 LangGraphHttpAgent({ url: "http://<host>:8000" }) 对接这里
add_langgraph_fastapi_endpoint(
    app=app,
    agent=LangGraphAgent(
        name=AGENT_NAME,
        description="巴利经文 AI 问答助手（WikiPali MCP 真实语料 + DeepSeek）",
        graph=graph,
    ),
    path="/",
)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
