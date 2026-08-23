"""离线验证 LangGraph 图本身（不需要 API key、不联网）。

用 mock_llm.MockPaliChatModel 驱动两轮行为:
  第 1 轮 -> 发起 retrieve_sutta_passage 工具调用
  第 2 轮 -> 基于工具结果流式输出最终回答
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from langchain_core.messages import HumanMessage

from agent import build_graph
from mock_llm import MockPaliChatModel

graph = build_graph(model=MockPaliChatModel())
config = {"configurable": {"thread_id": "local-graph-test"}}

result = graph.invoke({"messages": [HumanMessage(content="什么是四圣谛？")]}, config)

print("=== 消息轨迹 ===")
for i, m in enumerate(result["messages"]):
    tcs = getattr(m, "tool_calls", None)
    extra = f" tool_calls={[(t['name'], t['args']) for t in tcs]}" if tcs else ""
    print(f"{i}. [{m.type}] {str(m.content)[:60]!r}{extra}")

types = [m.type for m in result["messages"]]
assert "tool" in types, "工具节点应被调用"
assert result["messages"][-1].content, "最终应有回答"
print("\n✅ LangGraph 图逻辑验证通过（模型->工具->模型 完整链路）")
