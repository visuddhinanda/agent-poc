"""演示用 mock LLM：未配置 DEEPSEEK_API_KEY 时使用。

行为模拟 DeepSeek 的两轮对话:
  第 1 轮: 流式发起 retrieve_sutta_passage 工具调用
  第 2 轮: 收到工具结果后, 分块流式输出模板回答

目的: 让 POC 在没有任何 API key 的情况下也能端到端验证
「提问 -> 工具检索 -> 流式回答」全链路。
"""
from typing import Any, Iterator, List, Optional

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

TOOL_NAME = "retrieve_sutta_passage"


def _final_answer(tool_output: str) -> str:
    return (
        "（mock 演示模式，未配置 DEEPSEEK_API_KEY，以下为模板回答）\n"
        f"检索到的经文片段：\n{tool_output}\n\n"
        "简要回答：依此经文，四圣谛即苦、苦之集、苦之灭、导至苦灭之道；"
        "八支圣道（正见……正定）是导向苦灭的具体修行路径。"
    )


class MockPaliChatModel(BaseChatModel):
    """mock 模型：第一轮发工具调用，第二轮流式输出模板回答。"""

    @property
    def _llm_type(self) -> str:
        return "mock-pali-chat"

    def bind_tools(self, tools, **kwargs):
        """mock 模型不真正绑定工具，但保留接口以复用构建逻辑。"""
        return self

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        last = messages[-1]
        if isinstance(last, ToolMessage):
            msg = AIMessage(content=_final_answer(str(last.content)))
        else:
            query = last.content if isinstance(last, HumanMessage) else "四圣谛"
            msg = AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": TOOL_NAME,
                        "args": {"query": str(query)},
                        "id": "mock_call_1",
                        "type": "tool_call",
                    }
                ],
            )
        return ChatResult(generations=[ChatGeneration(message=msg)])

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        last = messages[-1]
        if isinstance(last, ToolMessage):
            # 第 2 轮: 分块流式输出最终回答
            text = _final_answer(str(last.content))
            for i in range(0, len(text), 32):
                yield ChatGenerationChunk(
                    message=AIMessageChunk(content=text[i : i + 32])
                )
        else:
            # 第 1 轮: 流式发起工具调用（模拟 OpenAI 风格的 tool_call_chunks）
            query = last.content if isinstance(last, HumanMessage) else "四圣谛"
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    tool_call_chunks=[
                        {
                            "name": TOOL_NAME,
                            "args": f'{{"query": "{query}"}}',
                            "id": "mock_call_1",
                            "index": 0,
                            "type": "tool_call_chunk",
                        }
                    ],
                )
            )
