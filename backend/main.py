"""FastAPI 服务：以 AG-UI 协议暴露 LangGraph agent，供 CopilotKit Runtime 对接。

启动: uvicorn main:app --host 0.0.0.0 --port 8000（或 ./run.sh）
Agent 端点: POST /   （AG-UI RunAgentInput -> SSE 事件流）
"""
import os

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint

from agent import build_graph

AGENT_NAME = "pali_agent"

app = FastAPI(title="Buddhist Pali Q&A Agent (LangGraph + AG-UI)", version="0.1.0")

# 编译 agent 图（带 MemorySaver checkpointer）
graph = build_graph()


@app.get("/info")
def info():
    return {
        "service": "buddhist-agent-poc backend",
        "agent": AGENT_NAME,
        "protocol": "AG-UI",
        "agent_endpoint": "POST /",
        "health": "/health",
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
        "base_url": os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        "api_key_configured": bool(os.getenv("DEEPSEEK_API_KEY")),
    }


# AG-UI 端点：CopilotKit Runtime 的 LangGraphHttpAgent({ url: "http://<host>:8000" }) 对接这里
add_langgraph_fastapi_endpoint(
    app=app,
    agent=LangGraphAgent(
        name=AGENT_NAME,
        description="巴利经文 AI 问答助手（mock 经文检索 + DeepSeek）",
        graph=graph,
    ),
    path="/",
)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
