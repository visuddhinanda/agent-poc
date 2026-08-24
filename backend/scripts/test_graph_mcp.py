"""端到端验证：LangGraph agent 通过 MCP server 调用 wikipali 工具，拉真实语料数据。

前置: MCP server 已在 3000 端口运行（且建议 WIKIPALI_API_URL=next，见 mcp/README）。
需要 DEEPSEEK_API_KEY（.env 里已配），否则 build_model 回退 mock 演示模型。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv

load_dotenv()

from langchain_core.messages import HumanMessage

from agent import build_graph, build_model, retrieve_sutta_passage
from mcp_tools import load_wikipali_tools


async def main() -> int:
    _client, wikipali_tools = await load_wikipali_tools()
    print(f"✅ 加载 {len(wikipali_tools)} 个 wikipali 工具")

    tools = [retrieve_sutta_passage, *wikipali_tools]
    graph = build_graph(model=build_model(), tools=tools)
    config = {"configurable": {"thread_id": "mcp-graph-test"}}

    question = (
        "用 wikipali 检索巴利词 parivāsa（别住）：先展开词形，"
        "再看它在律藏里的出处分布，最后取一段有代表性的原文（坐标 216-35 附近）。"
    )
    print(f"\n提问：{question}\n")
    result = await graph.ainvoke({"messages": [HumanMessage(content=question)]}, config)

    print("=== 消息轨迹 ===")
    called = []
    for i, m in enumerate(result["messages"]):
        tcs = getattr(m, "tool_calls", None)
        if tcs:
            for tc in tcs:
                called.append(tc["name"])
                print(f"{i}. [{m.type}] tool_call -> {tc['name']}({tc['args']})")
        else:
            print(f"{i}. [{m.type}] {str(m.content)[:200]!r}")

    print("\n调用过的工具:", called)
    assert any(n.startswith("wikipali_") for n in called), "没有调用任何 wikipali 工具"
    final = result["messages"][-1].content
    assert final, "最终应有回答"
    print("\n=== 最终回答 ===")
    print(final)
    print("\n✅ LangGraph 通过 MCP 调用 wikipali 工具成功，拿到了真实语料数据")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
