"""巴利经文 AI 问答助手 —— LangGraph agent。

流程:
  用户提问 -> LLM (DeepSeek) -> 判断需要经文依据 -> 调用 mock 检索工具
           -> 得到经文片段 -> LLM 结合经文作答 -> 流式返回

POC 专用: 经文检索是硬编码的 mock 数据, 不接真实数据库。
"""
import json
import os

from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

from mock_llm import MockPaliChatModel

SYSTEM_PROMPT = """你是「法音 Pali-QA」，一位专精巴利三藏（Tipiṭaka）的 AI 问答助手。

可用工具：
- retrieve_sutta_passage：按问题检索经文，返回结构化 citations（ref / passageId / pali / zh）。

回答规则：
1. 默认用中文回答，把回答组织成一篇完整、通顺的文章（markdown）。
2. 回答需要经文依据时，先调用 retrieve_sutta_passage 检索（只调用一次，不要重复调用）。
3. 在文章里引用经文出处时，使用 markdown 链接，链接文字用出处简称（例如 SN 56.11），链接地址固定为：
   https://next.wikipali.org/library/tipitaka/{passageId}/read?channel=translation
   其中 {passageId} 是检索返回的 passageId 坐标（例如 188-459）。
   示例：[SN 56.11](https://next.wikipali.org/library/tipitaka/188-459/read?channel=translation)
4. 引用必须带得回坐标，不编造出处；区分本文/义注/复注层次（把义注解释当成本文说法是学术错误）。
5. 回答简洁、准确。
"""

# ---------------------------------------------------------------------------
# mock 经文数据库（硬编码示例，POC 专用，不接真实数据库）
# ---------------------------------------------------------------------------
# 注意：passage_id 为占位坐标（book-paragraph），仅用于打通「引用卡片 → 跳转阅读器」链路；
# 真实坐标待接 wikipali MCP 真实检索后替换。
_SUTTA_DB = [
    {
        "keywords": ["四圣谛", "四諦", "苦", "dukkha", "转法轮", "圣谛"],
        "ref": "SN 56.11 转法轮经（Dhammacakkappavattana Sutta）",
        "passage_id": "188-459",
        "pali": "Idaṁ kho pana, bhikkhave, dukkhaṁ ariya-saccaṁ: jāti pi dukkhā, jarā pi dukkhā, byādhi pi dukkho, maraṇam pi dukkhaṁ ... saṅkhittena pañcupādānakkhandhā dukkhā.",
        "zh": "诸比丘！此是苦圣谛：生是苦，老是苦，病是苦，死是苦……简言之，五取蕴是苦。",
    },
    {
        "keywords": ["八正道", "八圣道", "magga", "正道", "道谛"],
        "ref": "SN 56.11 转法轮经（八支圣道部分）",
        "passage_id": "188-460",
        "pali": "Ayaṁ eva ariyo aṭṭhaṅgiko maggo, seyyathidaṁ – sammādiṭṭhi, sammāsaṅkappo, sammāvācā, sammākammanto, sammā-ājīvo, sammāvāyāmo, sammāsati, sammāsamādhi.",
        "zh": "此即是八支圣道：正见、正思惟、正语、正业、正命、正精进、正念、正定。",
    },
    {
        "keywords": ["缘起", "因缘", "paticca", "十二因缘", "缘生"],
        "ref": "SN 12.2 缘起分别（Paṭiccasamuppāda）",
        "passage_id": "188-461",
        "pali": "Avijjāpaccayā saṅkhārā; saṅkhārapaccayā viññāṇaṁ; viññāṇapaccayā nāmarūpaṁ ... Evametassa kevalassa dukkhakkhandhassa samudayo hoti.",
        "zh": "无明缘行，行缘识，识缘名色……如此，这纯大苦蕴集起。",
    },
    {
        "keywords": ["无常", "anicca", "诸行"],
        "ref": "Dhp 277（法句经）",
        "passage_id": "188-462",
        "pali": "Sabbe saṅkhārā aniccā'ti, yadā paññāya passati; atha nibbindati dukkhe, esa maggo visuddhiyā.",
        "zh": "「诸行无常」，当以智慧观照时，则于苦厌离，此是清净之道。",
    },
    {
        "keywords": ["无我", "anatta", "五蕴"],
        "ref": "SN 22.59 无我相经（Anattalakkhaṇa Sutta）",
        "passage_id": "188-463",
        "pali": "Rūpaṁ, bhikkhave, anattā ... vedanā anattā ... saññā anattā ... saṅkhārā anattā ... viññāṇaṁ anattā.",
        "zh": "诸比丘！色是无我，受是无我，想是无我，行是无我，识是无我。",
    },
    {
        "keywords": ["慈", "慈经", "metta", "善意"],
        "ref": "Khp 9 慈经（Mettā Sutta）",
        "passage_id": "188-464",
        "pali": "Sukhinova khemino hontu, sabbe sattā bhavantu sukhitattā.",
        "zh": "愿一切众生快乐安稳，愿一切众生幸福。",
    },
]


@tool
def retrieve_sutta_passage(query: str) -> str:
    """检索巴利经文（mock 实现）。根据问题关键词返回相关的经文片段。

    返回结构化 citations 的 JSON 字符串（供前端渲染引用卡片）：
    [{ "ref": 出处, "passageId": "book-paragraph" 坐标, "pali": 巴利原文, "zh": 中文翻译 }]
    当用户询问教义、经文内容时调用。"""
    hit = None
    for entry in _SUTTA_DB:
        if any(k.lower() in query.lower() for k in entry["keywords"]):
            hit = entry
            break
    if hit is None:
        hit = _SUTTA_DB[0]  # 未命中时兜底返回四圣谛
    citations = [
        {
            "ref": hit["ref"],
            "passageId": hit["passage_id"],
            "pali": hit["pali"],
            "zh": hit["zh"],
        }
    ]
    return json.dumps(citations, ensure_ascii=False)


def build_model():
    """DeepSeek（OpenAI 兼容接口）。

    未配置 DEEPSEEK_API_KEY 时回退到 MockPaliChatModel（模板回答），
    这样 POC 在没有 key 的情况下也能完整跑通工具调用 + 流式回复链路。
    """
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        print(
            "[warn] 未检测到 DEEPSEEK_API_KEY，使用 mock 演示模型（模板回答）。\n"
            "       配置真实 key 后（cp .env.example .env 并填入）即走 DeepSeek。"
        )
        return MockPaliChatModel()
    return ChatOpenAI(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
        api_key=api_key,
        base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        temperature=0.3,
    )


def sanitize_messages_for_llm(messages):
    """向 LLM 发送前清理消息序列，保证每次请求都合法。

    客户端（CopilotKit）回传的历史里，assistant 消息会原样带回
    tool_calls，但不包含对应的 tool 结果消息（tool 结果只存在后端
    checkpoint 中）；中断的运行也可能在 checkpoint 里留下「有
    tool_calls、无结果」的残留。把这类序列直接发给 DeepSeek/OpenAI
    兼容接口会返回 400：
    "An assistant message with 'tool_calls' must be followed by tool
     messages responding to each 'tool_call_id'."

    处理规则:
      - AI(tool_calls) 后紧跟的 ToolMessage 覆盖了全部 tool_call_id -> 保留
      - 覆盖不全 / 完全无结果 -> 剥掉该消息的 tool_calls（有文本内容则
        保留文本），并丢弃紧随其后引用这些调用的结果消息
      - 没有前置 AI(tool_calls) 的孤立 ToolMessage -> 丢弃
    """
    cleaned = []
    i, n = 0, len(messages)
    while i < n:
        msg = messages[i]
        if isinstance(msg, AIMessage) and msg.tool_calls:
            # 收集紧随其后的连续 ToolMessage（合法序列中它们必须紧挨着）
            j = i + 1
            result_ids = set()
            while j < n and isinstance(messages[j], ToolMessage):
                result_ids.add(messages[j].tool_call_id)
                j += 1
            call_ids = {tc.get("id") for tc in msg.tool_calls if tc.get("id")}
            if call_ids and call_ids.issubset(result_ids):
                cleaned.extend(messages[i:j])  # AI 调用 + 完整结果
            elif msg.content:
                # 孤儿/不完整调用：剥掉 tool_calls，保留文本内容
                cleaned.append(
                    AIMessage(content=msg.content, id=msg.id, name=msg.name)
                )
            i = j  # 不完整的结果消息随孤儿调用一起丢弃
        elif isinstance(msg, ToolMessage):
            i += 1  # 无主工具结果，丢弃
        else:
            cleaned.append(msg)
            i += 1
    return cleaned


def build_graph(model=None, tools=None):
    """构建 LangGraph agent 图。

    model 参数用于测试时注入其他模型；默认用 DeepSeek（无 key 时为 mock）。
    tools 参数用于注入工具（如 MCP wikipali 工具）；缺省只用 mock 经文检索。
    带 MemorySaver checkpointer：AG-UI 协议需要按 thread 读取状态。
    """
    model = model or build_model()
    tools = tools if tools is not None else [retrieve_sutta_passage]
    llm = model.bind_tools(tools)

    def chatbot(state: MessagesState):
        """调用模型。与 CopilotKit/LangGraph 官方 quickstart 一致的写法：
        invoke 返回完整 AIMessage（含 tool_calls），AG-UI 层负责把
        run 的各个阶段（工具调用、回答）以 SSE 事件流式推给前端。"""
        messages = [SystemMessage(content=SYSTEM_PROMPT), *state["messages"]]
        return {"messages": [llm.invoke(sanitize_messages_for_llm(messages))]}

    builder = StateGraph(MessagesState)
    builder.add_node("chatbot", chatbot)
    builder.add_node("tools", ToolNode(tools))
    builder.add_edge(START, "chatbot")
    builder.add_conditional_edges("chatbot", tools_condition)  # 有 tool_call -> tools, 否则 -> END
    builder.add_edge("tools", "chatbot")
    return builder.compile(checkpointer=MemorySaver())


if __name__ == "__main__":
    # 本地快速自测（需要 DEEPSEEK_API_KEY）
    graph = build_graph()
    config = {"configurable": {"thread_id": "local-test"}}
    result = graph.invoke(
        {"messages": [("user", "什么是四圣谛？")]}, config
    )
    for m in result["messages"]:
        print(f"\n--- [{m.type}] ---\n{m.content}")
