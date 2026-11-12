"""按问题类型分路径的研究 agent（设计见 docs/agent-routing.md）。

    START → plan ─┬─ passage  → passage_fetch ─────────────────┐
                  ├─ term     → term_research ─────────────────┤
                  ├─ question → question_research ⇄ (judge) ───┤
                  └─ chat ─────────────────────────────────────┴→ answer → END

- plan：一次结构化调用（关闭思考），判断问题类型、给出巴利原形与检索关键词；
  一般问题还会凭模型知识写一份「假设答案」，只放 state 里用来检索，不输出给用户。
- *_research：节点自己构造 AIMessage(tool_calls=…)，交给 ToolNode 并行执行。工具事件照常
  经 AG-UI 流给客户端（检索气泡、引用提取都不变）。快速模式用规则自检，深度模式由
  judge（LLM）判断材料够不够，最多补查两轮。全程按预算计数。
- question 有三条检索路线，按问题类型（qtype）决定顺序（依据见 agent-tuning/docs/retrieval-recall-2026-11.md）：
  检索（逐词 search）、定位（凭知识说出章节名 → locate → 太长就看 toc 挑小节 → 取整章）、
  选章（从全部书里挑书 → 从整本书的标题里挑章 → 同上）。快速模式只走第一条（没结果时退回检索），
  深度模式 judge 说不够就换下一条。
- answer：把检索结果压成精简的证据块，交给不绑定工具的 LLM 作答。快速模式关闭思考，
  深度模式开启思考（不绑工具，避开 DeepSeek 开思考 + 工具时必须回传 reasoning_content 的限制）。

客户端经 AG-UI 的 state 传 `deep_thinking` 与 `passage`（见 docs/agent-routing.md §3）。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from typing import Any, Literal, Optional

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from pydantic import BaseModel, Field

from obs import current_run, log

# 全部研究路径（路由结果，入库为 agent_runs.route）。mint 的 AgentRun::ROUTES 与 OpenAPI 枚举要和它一致：
# 管理后台按它画图、筛选。新增 / 改名路由时两边一起改，scripts/test_route_enum.py 会核对。
# passage 不经规划器：带阅读页段落的提问直接走它；其余三个是 Plan.route 的取值
ROUTES = ("question", "term", "passage", "chat")

# 研究路径只用读端工具；写端与 _preview/_commit 一律不给模型
READ_TOOLS = {
    "wikipali_forms", "wikipali_word", "wikipali_search", "wikipali_dist", "wikipali_get",
    "wikipali_ref", "wikipali_related", "wikipali_related_cs", "wikipali_chapter",
    "wikipali_locate", "wikipali_toc", "wikipali_books", "wikipali_chapter_fetch",
}

BUDGET = {False: 14, True: 24}         # 每次运行的 MCP 调用上限：快速 / 深度（快速最多走两条路线）
MAX_ROUNDS = {False: 1, True: 2}       # 补查 / 重规划的轮数上限
MAX_KEYWORDS = {False: 3, True: 6}
TERM_SEARCH_LIMIT = 40
QUESTION_SEARCH_LIMIT = {False: 8, True: 10}
TOO_MANY_HITS = 1000
EVIDENCE_CHARS = {False: 20000, True: 36000}

# 问题类型 → 三条路线的先后（检索 search / 定位 locate / 选章 choose）。
# 148 道真实问题上同一判官的可作答数：术语概念类检索最强；经文内容与出处定位、选章最强；
# 义理辨析选章最强（论藏的章节按概念组织）；列举、戒律、修行定位第一。
QTYPES = ["concept", "text", "list", "vinaya", "practice", "doctrine", "narrative"]
ROUTE_ORDER = {
    "concept": ["search", "locate", "choose"],
    "text": ["locate", "choose", "search"],
    "list": ["locate", "search", "choose"],
    "vinaya": ["locate", "search", "choose"],
    "practice": ["locate", "search", "choose"],
    "doctrine": ["choose", "search", "locate"],
    "narrative": ["choose", "search", "locate"],
}
LEAF_CHARS = 8000                      # 一章超过这么多字符就往下挑小节
NARROW_ROUNDS = {False: 2, True: 3}
MAX_SOURCES = {False: 2, True: 3}      # 定位：最多试几个章节名
MAX_BOOKS = {False: 1, True: 2}        # 选章：最多挑几部书
MAX_TITLES = {False: 2, True: 3}       # 选章：每部书最多挑几章
MAX_READ = {False: 2, True: 4}         # 一条路最多取几章全文
MAX_LIST_LINES = 400                   # 给模型看的标题清单最多几行（多了按层级收浅）
MIN_LOCATE_SCORE = 0.8                 # 容错命中只认很轻的拼写差异：模型自己说出的章节名，错得多的多半是另一章

# 范围 tag 只能取书目清单里真实存在的值（v2/book-title），否则检索会静默 0 条
SCOPE_TAGS = [
    "sutta", "vinaya", "abhidhamma", "mūla", "aṭṭhakathā", "ṭīkā",
    "dīghanikāya", "majjhimanikāya", "saṃyuttanikāya", "aṅguttaranikāya", "khuddakanikāya",
    "jātaka", "suttavibhaṅga", "khandhaka", "pātimokkha", "parivāra", "visuddhimagga",
    "dhammasaṅgaṇī", "vibhaṅga", "kathāvatthu", "paṭṭhāna", "abhidhammatthasaṅgaha",
]

# 旧版 App 的阅读页 system 提示词：没有结构化 passage 时从它里面还原坐标
LEGACY_PASSAGE_RE = re.compile(r"用户正在阅读经文(\d+)-(\d+)\s*channel:([0-9a-fA-F-]*)")

HIDDEN = {"metadata": {"emit-messages": False, "emit-tool-calls": False}}


# ---------------------------------------------------------------------------
# state 与结构化输出
# ---------------------------------------------------------------------------


class AgentState(MessagesState):
    deep_thinking: bool
    passage: Optional[dict]
    route: str
    plan: dict
    budget_used: int
    rounds: int
    # 本轮的检索结果（ToolMessage 的 id 列表），answer 只用这些拼证据
    evidence_ids: list


class Keyword(BaseModel):
    lemma: str = Field(description="巴利词典形（原形），罗马转写带变音符号，如 satipaṭṭhāna、mettā")
    tags: str = Field(default="", description=f"检索范围，逗号分隔是「且」；只能用这些值：{', '.join(SCOPE_TAGS)}；不确定就留空")


class Source(BaseModel):
    name: str = Field(description="章节名：CST 的巴利罗马转写（经名、品名、偈名、律或论的章节名），不要用 DN 16 这类编号")
    layer: str = Field(default="", description="这一章属于 mula（根本）/ atthakatha（义注）/ tika（复注）/ anna（其他）；不确定留空")


class Plan(BaseModel):
    route: Literal["term", "question", "chat"] = Field(
        description="term：问的是一个巴利词 / 佛教术语本身的意思或用法；question：其它需要经文依据的问题；"
        "chat：寒暄、问你是谁、与佛法经文无关等不需要查经的话"
    )
    confidence: float = Field(description="对 route 判断的把握，0–1")
    lemmas: list[str] = Field(
        default_factory=list,
        description="term：这个词的巴利原形候选（最可能的放第一个，中文术语要译回巴利，如 念处→satipaṭṭhāna）",
    )
    keywords: list[Keyword] = Field(
        default_factory=list,
        description="question：检索用的巴利关键词，选在相关经文里有区分度的词，按重要性排序",
    )
    hypothesis: str = Field(
        default="",
        description="question：凭你的知识写下可能的答案要点与相关经文（具体到哪部经、谁的偈、哪一章；根本典里有没有直接说），只用于指导检索，不会给用户看",
    )
    qtype: Literal["concept", "text", "list", "vinaya", "practice", "doctrine", "narrative"] = Field(
        default="concept",
        description="question 的类型：concept 术语概念的含义 / text 经文内容与出处（某经讲什么、某句出自哪里）/ "
        "list 列举数目 / vinaya 戒律与僧团规定 / practice 修行与生活应用 / doctrine 义理辨析（概念异同、阿毗达摩分析）/ "
        "narrative 人物事迹与故事",
    )
    sources: list[Source] = Field(
        default_factory=list,
        description="question：凭你对三藏的了解，最可能直接记载答案的章节（最有把握的在前），只用来定位，不会给用户看",
    )


class PickCoords(BaseModel):
    coords: list[str] = Field(default_factory=list, description="选中的坐标（照抄清单里的 book-paragraph），最有把握的在前")


class Judge(BaseModel):
    enough: bool = Field(description="现有材料是否足以有根据地回答问题")
    keywords: list[Keyword] = Field(default_factory=list, description="不够时，再检索哪些巴利关键词（不要重复已查过的）")
    get_coords: list[str] = Field(default_factory=list, description="不够时，要取全文的坐标 book-paragraph（从已有命中里挑）")


PLAN_PROMPT = """你是巴利三藏研究助手的规划器。读用户的问题（及对话上下文），输出研究计划。

- route=term：问的是一个巴利词或佛教术语本身（是什么意思、怎么用、出处）。lemmas 给原形候选，最多 3 个。
- route=question：其它需要经文依据的问题。keywords 给最多 {max_kw} 个巴利关键词（原形），
  每个可配一个范围 tags；hypothesis 写下你凭知识认为的答案要点与相关经文；qtype 给问题类型；
  sources 给最多 {max_src} 个最可能直接记载答案的章节，**具体到篇**（某一部经、某人的偈、律的某一章、论的某一品），
  不要只给整部书名（如只写 Theragāthā、Samantapāsādikā 没用）。用 CST 的巴利章节名，layer 标层次。
  人物的自述与事迹：先想长老偈 / 长老尼偈里此人的偈（如 Sāriputtattheragāthā），以及义注里此人的事迹
  （如 …ttheravatthu）；经文出处给那部经的经名；律的规定给相应犍度或学处的章名。
  先想根本典里有没有直接说；根本典没说、只在义注里有时，才给义注的章节。说不出就留空，不要硬编。
- route=chat：不需要查经（寒暄、问你是谁、闲聊）。
- 拿不准是 term 还是 question 时选 question。
- 巴利词一律给词典原形，罗马转写带变音符号（ā ī ū ṃ ṅ ñ ṭ ḍ ṇ ḷ）。每个 lemma / 关键词只能是**一个词**
  （复合词算一个词），不要给词组（如「cattāri ariyasaccāni」要给 ariyasacca）。
- question 的关键词要有区分度：优先选目标经文特有的复合词或专名（如 dhammacakkappavattana、
  anattalakkhaṇa、mettānisaṃsa），不要用 dukkha、dhamma、bhikkhu、citta 这类到处都是的常用词。
- 关键词选**答案段落里会出现的词**，不只是问题在谈的话题：问人名、地名、数目、出处时，把预期答案里的词
  一起放进去（可以给它在经文里的实际词形，如表示年数、数目的复合词，检索会自动展开）；列举类问题用总称加一两个成员。
- 问的是经文本身（佛陀说了什么）时，范围加上 mūla（如 saṃyuttanikāya,mūla）；问注释书怎么解释时才用
  aṭṭhakathā / ṭīkā；律的问题用 vinaya。"""

JUDGE_PROMPT = """你是巴利三藏研究助手的审稿人。根据问题、研究计划与目前检索到的材料，判断材料够不够有根据地回答。
不够时给出补查方案：再检索的巴利关键词（原形，最多 {max_kw} 个，不要重复），或要取全文的坐标（从已有命中里挑，最多 6 个）。"""

ANSWER_PROMPT = """你是「法音 Pali-QA」，专精巴利三藏（Tipiṭaka）的问答助手。下面「检索结果」是刚从 WikiPali 语料库查到的材料。

作答规则：
1. 用用户提问的语言回答（默认中文），组织成通顺的 markdown 文章，简洁准确。
2. 只依据检索结果作答；材料不足以支持的内容要（用用户的语言）明说检索结果里没有，不要编造经文或出处。
3. 引用经文时**原样照抄**检索结果里给出的出处链接（形如 [dī.ni.1. 93-6; …](https://…)），不要自己拼 URL、不要改写缩写。
   「整章」材料的链接是这一章的出处：引用其中的句子时附这条链接，需要精确到句时再加句子 id（如 94-588-14-32）。
   检索结果里没有给链接的段落，只写坐标（如 93-6），不要编链接。
   每个用到的段落都至少附一次它的出处链接（作小标题的坐标也一样要附）。
4. 区分根本（mūla）/ 义注（aṭṭhakathā）/ 复注（ṭīkā）层次——把义注的解释当成根本的说法是学术错误。
5. 引巴利原文时可附中文译解；不要大段照抄检索结果。
6. 不要向用户描述检索过程（查了哪些词、哪次检索失败、换了什么词），只讲经文内容本身。"""

PICK_BOOK_PROMPT = """你在帮巴利三藏研究助手**定位**答案原文（不是回答问题）。下面是全部典籍（坐标、书名、分类标签）。
选出最可能记载答案的 {n} 部，最有把握的在前；照抄清单里的坐标。问的细节（人名、因缘、数目、词义解释）在根本典里
通常没有、只在义注里有时，选义注；概念的分类与关系优先看论藏与《清净道论》。"""

PICK_TITLE_PROMPT = """你在帮巴利三藏研究助手**定位**答案原文（不是回答问题）。下面是《{work}》的标题目录
（坐标、标题、〔中文译名〕、字符数，缩进表示层级）。选出最可能记载答案的 {n} 个标题，越具体（越小的小节）越好；
照抄清单里的坐标。"""

PASSAGE_ANSWER_HINT = """用户是在阅读经文时提问的。检索结果里的「用户正在读的段落」是第一依据；
有选中文字时，问题针对的就是那段文字。用义注、复注解释时要标明层次。"""

# 提示词版本：研究过程入库时只存哈希，不存全文。改了任何一份提示词，哈希就变
PROMPT_VERSION = hashlib.sha1(
    "\n".join([PLAN_PROMPT, JUDGE_PROMPT, ANSWER_PROMPT, PASSAGE_ANSWER_HINT, PICK_BOOK_PROMPT, PICK_TITLE_PROMPT]).encode()
).hexdigest()[:12]


# ---------------------------------------------------------------------------
# 工具执行与结果解析
# ---------------------------------------------------------------------------


def tool_text(msg: ToolMessage) -> str:
    content = msg.content
    if isinstance(content, list):
        return "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in content)
    return str(content)


def tool_json(msg: ToolMessage) -> Any:
    text = tool_text(msg)
    try:
        return json.loads(text)
    except ValueError:
        return None


def tool_failed(msg: ToolMessage) -> bool:
    return getattr(msg, "status", None) == "error" or tool_json(msg) is None


class _CallEmitter(BaseChatModel):
    """把「程序决定的工具调用」当作模型流式输出发出去。

    固定路径不经过 LLM 决定工具调用，但客户端只认 AG-UI 的流式工具事件：直接塞一条
    AIMessage(tool_calls) 进 state 的话，ag-ui 会在工具结束时补发事件，父消息 id 却用
    tool_call_id，和最后 MESSAGES_SNAPSHOT 里那条 AIMessage 的 id 对不上，客户端同一个
    工具调用出现两次（React 报 duplicate key）。所以这里逐个流式吐出 tool_call_chunks，
    让 ag-ui 走与真实模型相同的路径：父消息 id = 这条 AIMessage 的 id。
    """

    calls: list = []
    message_id: str = ""

    @property
    def _llm_type(self) -> str:
        return "call-emitter"

    def _final(self) -> AIMessage:
        return AIMessage(
            content="",
            id=self.message_id,
            tool_calls=[{"id": c["id"], "name": c["name"], "args": c["args"], "type": "tool_call"} for c in self.calls],
        )

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._final())])

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        for idx, call in enumerate(self.calls):
            for part in (
                {"name": call["name"], "args": "", "id": call["id"], "index": idx},
                {"name": None, "args": json.dumps(call["args"], ensure_ascii=False), "id": None, "index": idx},
            ):
                chunk = ChatGenerationChunk(message=AIMessageChunk(content="", id=self.message_id, tool_call_chunks=[part]))
                if run_manager:
                    await run_manager.on_llm_new_token("", chunk=chunk)
                yield chunk
        # 没有 tool_call_chunks 的空块：ag-ui 据此结束最后一个工具调用
        end = ChatGenerationChunk(message=AIMessageChunk(content="", id=self.message_id))
        if run_manager:
            await run_manager.on_llm_new_token("", chunk=end)
        yield end


class Researcher:
    """包一层 ToolNode：按预算裁掉超出的调用，并行执行，返回 (AIMessage, [ToolMessage])。"""

    def __init__(self, tools: list):
        self.by_name = {t.name: t for t in tools if t.name in READ_TOOLS}
        self.node = ToolNode(list(self.by_name.values()))

    async def run(self, state: AgentState, calls: list[tuple[str, dict]], config) -> tuple[list, list[ToolMessage], int]:
        """返回 (要追加进 state 的消息, 与 calls 一一对应的 ToolMessage, 实际调用数)。

        ToolMessage 按 tool_call_id 对回调用顺序，并补上 id（证据按 id 取）。每条 ToolMessage
        另挂 `call_name` / `call_args`，后续自检不用再回头找对应的调用。
        """
        deep = bool(state.get("deep_thinking"))
        left = BUDGET[deep] - int(state.get("budget_used") or 0)
        calls = [(n, a) for n, a in calls if n in self.by_name]
        if len(calls) > left:
            log("budget", wanted=len(calls), left=left)
            calls = calls[: max(left, 0)]
        if not calls:
            return [], [], 0
        emitter = _CallEmitter(
            calls=[{"id": f"call_{uuid.uuid4().hex[:12]}", "name": n, "args": a} for n, a in calls],
            message_id=f"run-{uuid.uuid4()}",
        )
        meta = {**(config or {}).get("metadata", {}), "obs_skip": True}
        ai = await emitter.ainvoke([HumanMessage(content="-")], {**(config or {}), "metadata": meta})
        result = await self.node.ainvoke({"messages": [ai]}, config)
        by_id = {m.tool_call_id: m for m in result["messages"] if isinstance(m, ToolMessage)}
        tool_msgs = []
        for tc in ai.tool_calls:
            msg = by_id.get(tc["id"]) or ToolMessage(content="（没有返回）", tool_call_id=tc["id"], name=tc["name"], status="error")
            if not msg.id:
                # 与 ag-ui 流式发出的 TOOL_CALL_RESULT 用同一个 id，MESSAGES_SNAPSHOT 才对得上
                msg.id = tc["id"]
            msg.additional_kwargs["call_name"] = tc["name"]
            msg.additional_kwargs["call_args"] = tc["args"]
            tool_msgs.append(msg)
        return [ai, *tool_msgs], tool_msgs, len(calls)


# ---------------------------------------------------------------------------
# 证据压缩：工具结果 → answer 用的精简文本
# ---------------------------------------------------------------------------


def _clip(text: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[:limit] + "…"


def condense(name: str, args: dict, data: Any) -> str:
    """把一条工具结果压成几行证据。不认识的工具原样截断。"""
    if not isinstance(data, dict):
        return _clip(data, 1500)
    if name == "wikipali_search":
        lines = [f"检索 {args.get('lemma') or ','.join(args.get('forms') or [])}"
                 + (f"（范围 {args['tags']}）" if args.get("tags") else "") + f"：命中 {data.get('count', 0)} 段"]
        for r in data.get("rows") or []:
            lines.append(f"- {r.get('cite')} 〔{_clip(r.get('path'), 80)}〕 {_clip(r.get('highlight'), 260)}")
        return "\n".join(lines)
    if name == "wikipali_get":
        cites = {r.get("coord"): r.get("cite") for r in data.get("refs") or [] if r.get("cite")}
        paths = {r.get("coord"): r.get("path") for r in data.get("refs") or [] if r.get("path")}
        groups: dict[tuple, list[str]] = {}
        for r in data.get("rows") or []:
            ch = r.get("channel") or {}
            groups.setdefault((r.get("coord"), ch.get("name") or ch.get("uid")), []).append(r.get("text") or "")
        lines = []
        for (coord, channel), texts in groups.items():
            head = cites.get(coord) or coord
            where = f"｜{_clip(paths[coord], 120)}" if paths.get(coord) else ""
            lines.append(f"【{head}{where}】（{channel}）{_clip(' '.join(texts), 1800)}")
        return "\n".join(lines) or "（这些坐标在该版本下没有内容）"
    if name == "wikipali_related":
        return "关联段落：" + "；".join(
            f"{r.get('layer')} {r.get('bookTitlePali')} {r.get('book')}:{','.join(map(str, (r.get('paras') or [])[:8]))}"
            for r in data.get("rows") or []
        )
    if name == "wikipali_chapter_fetch":
        lines = []
        for row in data.get("rows") or []:
            text = " ".join(f"〔{s.get('id')}〕{s.get('text')}" for s in row.get("sentences") or [])
            lines.append(text)
        body = _clip(" ".join(lines), LEAF_CHARS + 2000)
        if not body:
            return "（该章在这个版本下没有内容）"
        where = f"｜{_clip(data['path'], 120)}" if data.get("path") else ""
        if data.get("cite"):
            return f"【整章 {data['cite']}{where}】{body}"
        # 没取到服务端出处：明说只写坐标，否则模型会照「有链接」的格式自己编一个
        return f"【整章 {data.get('coord') or args.get('coord')}{where}（本章没有出处链接，引用时只写坐标或句子 id）】{body}"
    if name == "wikipali_chapter":
        return f"所在章节：{data.get('title')}（路径 {data.get('path')}；段 {data.get('book')}-{data.get('start')}～{data.get('end')}）"
    if name == "wikipali_dist":
        rows = data.get("rows") or []
        return (f"出处分布：{data.get('books')} 部书共 {data.get('totalHits')} 次；按层次 {data.get('byLayer')}；"
                + "；".join(f"{r.get('paliTitle')}({r.get('layer') or '-'}) {r.get('count')}" for r in rows[:12]))
    if name == "wikipali_word":
        lines = []
        for grp in data.get("words") or []:
            for w in (grp.get("words") or [])[:2]:
                gram = "；".join(f"{g.get('parent')} {g.get('type')} {g.get('grammar')}" for g in (w.get("grammar") or [])[:3])
                lines.append(f"词典 {w.get('word')}：{gram}")
                for d in (w.get("dict") or [])[:4]:
                    note = re.sub(r"<[^>]+>", "", str(d.get("note") or ""))
                    if note.strip():
                        lines.append(f"  〔{d.get('shortname')}·{d.get('lang')}〕{_clip(note, 300)}")
        return "\n".join(lines) or "词典无此词"
    return _clip(json.dumps(data, ensure_ascii=False), 1500)


def build_evidence(messages: list, ids: set, limit: int) -> str:
    """按顺序取本轮的工具结果拼成证据块，总长截到 limit。"""
    calls: dict[str, tuple[str, dict]] = {}
    for m in messages:
        if isinstance(m, AIMessage):
            for tc in m.tool_calls or []:
                calls[tc["id"]] = (tc["name"], tc.get("args") or {})
    blocks = []
    for m in messages:
        if isinstance(m, ToolMessage) and m.id in ids:
            name, args = calls.get(m.tool_call_id, (m.name or "?", {}))
            if tool_failed(m):
                blocks.append(f"[{name}] 调用失败：{_clip(tool_text(m), 200)}")
            else:
                blocks.append(condense(name, args, tool_json(m)))
    text = "\n\n".join(blocks)
    return text if len(text) <= limit else text[:limit] + "\n…（证据过长已截断）"


def conversation(messages: list, keep: int = 8) -> list:
    """对话里的纯文本轮次（去掉工具调用与结果），给规划器与作答用。"""
    out = []
    for m in messages:
        if isinstance(m, HumanMessage) or (isinstance(m, AIMessage) and m.content and not m.tool_calls):
            out.append(m)
        elif isinstance(m, AIMessage) and m.content:
            out.append(AIMessage(content=m.content))
    return out[-keep:]


def last_question(messages: list) -> str:
    for m in reversed(messages):
        if isinstance(m, HumanMessage):
            return m.content if isinstance(m.content, str) else str(m.content)
    return ""


def legacy_passage(messages: list) -> Optional[dict]:
    """旧版 App 用 system 消息交代阅读坐标；没有结构化 passage 时从这里还原。"""
    for m in messages:
        if isinstance(m, SystemMessage):
            hit = LEGACY_PASSAGE_RE.search(str(m.content))
            if hit:
                para = int(hit.group(2))
                return {"source": "screen", "book": int(hit.group(1)), "paragraphs": [para], "focus": para,
                        "channel": hit.group(3) or None}
    return None


def coord(book: int, para: int) -> str:
    return f"{book}-{para}"


# ---------------------------------------------------------------------------
# 图
# ---------------------------------------------------------------------------


def make_llm(thinking: bool) -> ChatOpenAI:
    return ChatOpenAI(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
        api_key=os.getenv("DEEPSEEK_API_KEY"),
        base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        temperature=0.3,
        extra_body={"thinking": {"type": "enabled" if thinking else "disabled"}},
    )


def build_routed_graph(tools: list, checkpointer=None):
    fast_llm = make_llm(False)
    deep_llm = make_llm(True)
    researcher = Researcher(tools)
    planner = fast_llm.with_structured_output(Plan, method="function_calling")
    judge = fast_llm.with_structured_output(Judge, method="function_calling")
    picker = fast_llm.with_structured_output(PickCoords, method="function_calling")

    def merge_config(config, extra: dict):
        meta = {**(config or {}).get("metadata", {}), **extra["metadata"]}
        return {**(config or {}), "metadata": meta}

    # ---- plan ---------------------------------------------------------------
    async def plan_node(state: AgentState, config):
        deep = bool(state.get("deep_thinking"))
        stats = current_run()
        stats.deep = deep
        passage = state.get("passage") or legacy_passage(state["messages"])
        reset = {"budget_used": 0, "rounds": 0, "evidence_ids": [], "passage": passage}
        if passage and passage.get("book") and passage.get("paragraphs"):
            stats.route = "passage"
            log("route", route="passage", source=passage.get("source"), book=passage.get("book"),
                paras=passage.get("paragraphs"), deep=str(deep).lower())
            # 不在这里规划：规划器看不到段落原文。深度模式下，取完段落后由 judge 看着原文决定要不要补查
            plan: dict = {"passage": passage}
            stats.passage = passage
            return {**reset, "route": "passage", "plan": plan}

        result = await planner.ainvoke(
            [SystemMessage(content=PLAN_PROMPT.format(max_kw=MAX_KEYWORDS[deep], max_src=MAX_SOURCES[deep])),
             *conversation(state["messages"])],
            merge_config(config, HIDDEN),
        )
        plan = result.model_dump()
        route = plan["route"]
        if route == "term" and (plan["confidence"] < 0.6 or not plan["lemmas"]):
            route = "question"  # 拿不准就走更宽的路径（逃生口）
            if not plan["keywords"]:
                plan["keywords"] = [{"lemma": l, "tags": ""} for l in plan["lemmas"]]
        if route == "question" and not plan["keywords"] and not plan.get("sources"):
            route = "chat" if plan["route"] == "chat" else "question"
        if route == "question":
            order = list(ROUTE_ORDER.get(plan.get("qtype") or "concept", ROUTE_ORDER["concept"]))
            # 说得出具体章节名时先定位：选章（从 281 部书里挑）只在说不出章节名时更有用，挑错书的代价也大
            if plan.get("sources") and order[0] == "choose":
                order.remove("locate")
                order.insert(0, "locate")
            plan["routes"] = order
        stats.route = route
        stats.route_raw = plan["route"]
        stats.confidence = plan["confidence"]
        stats.plan = plan
        log("route", route=route, raw=plan["route"], conf=plan["confidence"], lemmas=plan["lemmas"],
            keywords=[f"{k['lemma']}|{k['tags']}" for k in plan["keywords"]], qtype=plan.get("qtype"),
            sources=[f"{x['name']}|{x['layer']}" for x in plan.get("sources") or []],
            order=plan.get("routes"), deep=str(deep).lower())
        if plan.get("hypothesis"):
            log("plan", hypothesis=plan["hypothesis"][:300])
        return {**reset, "route": route, "plan": plan}

    # ---- term ---------------------------------------------------------------
    async def term_node(state: AgentState, config):
        deep = bool(state.get("deep_thinking"))
        lemmas = state["plan"].get("lemmas") or []
        out_msgs, evidence, used = [], [], 0
        for idx, lemma in enumerate(lemmas[:3]):
            calls = [("wikipali_search", {"lemma": lemma, "limit": TERM_SEARCH_LIMIT})]
            if deep:
                calls += [("wikipali_word", {"word": lemma}), ("wikipali_dist", {"lemma": lemma, "limit": 15})]
            msgs, results, n = await researcher.run({**state, "budget_used": state.get("budget_used", 0) + used}, calls, config)
            out_msgs += msgs
            used += n
            evidence += [m.id for m in results]
            search = results[0] if results else None
            if search is not None and not tool_failed(search) and (tool_json(search) or {}).get("count"):
                break
            # 展不出词形 / 0 条：换下一个候选原形（规则自检）
            current_run().retries += 1
            log("retry", reason="no-hits", lemma=lemma, next=lemmas[idx + 1] if idx + 1 < len(lemmas) else None)
        return {"messages": out_msgs, "budget_used": state.get("budget_used", 0) + used, "evidence_ids": evidence}

    # ---- question -----------------------------------------------------------
    async def search_calls(keywords: list[dict], deep: bool, searched: set) -> list[tuple[str, dict]]:
        calls = []
        for kw in keywords:
            lemma = (kw.get("lemma") or "").strip()
            if not lemma or lemma in searched:
                continue
            searched.add(lemma)
            args = {"lemma": lemma, "limit": QUESTION_SEARCH_LIMIT[deep]}
            if kw.get("tags"):
                args["tags"] = kw["tags"]
            calls.append(("wikipali_search", args))
        return calls

    def top_coords(messages: list, ids: set, n: int) -> list[str]:
        """各次检索命中里 rank 最高的段，轮流取，去重。"""
        per_search = []
        for m in messages:
            if isinstance(m, ToolMessage) and m.id in ids and not tool_failed(m):
                data = tool_json(m) or {}
                if "rows" in data and "count" in data:
                    per_search.append([r.get("coord") for r in data["rows"] if r.get("coord")])
        out = []
        for i in range(max((len(c) for c in per_search), default=0)):
            for coords in per_search:
                if i < len(coords) and coords[i] not in out:
                    out.append(coords[i])
        return out[:n]

    async def run_search(state: AgentState, keywords: list[dict], used: int, config) -> tuple[list, list, int]:
        """检索：关键词逐词 search → 规则自检补查一次 → 取命中最前几段全文。返回 (消息, 证据 id, 已用)。"""
        deep = bool(state.get("deep_thinking"))
        searched: set = set()
        msgs, results, n = await researcher.run({**state, "budget_used": used}, await search_calls(keywords, deep, searched), config)
        used += n
        all_msgs, evidence = list(msgs), [m.id for m in results]

        # 规则自检：失败或 0 条的关键词去掉范围再搜一次；命中过多的只看黑体词条
        fixes = []
        for res in results:
            args = res.additional_kwargs.get("call_args") or {}
            data = tool_json(res) or {}
            if tool_failed(res) or not data.get("count"):
                if args.get("tags"):
                    fixes.append(("wikipali_search", {k: v for k, v in args.items() if k != "tags"}))
            elif data.get("count", 0) > TOO_MANY_HITS and not args.get("bold"):
                fixes.append(("wikipali_search", {**args, "bold": True}))
        if fixes:
            current_run().retries += 1
            log("retry", reason="rule-check", calls=[a.get("lemma") for _, a in fixes])
            # 补查之后还要留一次给取全文（get），不能把预算用光
            room = BUDGET[deep] - used - 1
            m2, r2, u2 = await researcher.run({**state, "budget_used": used}, fixes[: max(0, min(3, room))], config)
            all_msgs += m2
            evidence += [m.id for m in r2]
            used += u2

        # 取命中最靠前几段的全文（get 一次取多段）
        coords = top_coords(all_msgs, set(evidence), 6 if deep else 3)
        if coords:
            m3, r3, u3 = await researcher.run({**state, "budget_used": used}, [("wikipali_get", {"coords": coords})], config)
            all_msgs += m3
            evidence += [m.id for m in r3]
            used += u3
        return all_msgs, evidence, used

    def chapter_lines(rows: list[dict]) -> str:
        base = min((int(r.get("level") or 1) for r in rows), default=1)
        return "\n".join(
            f"{'  ' * (int(r.get('level') or 1) - base)}{r['coord']}  {r.get('title')}"
            + (f"  〔{r['zh']}〕" if r.get("zh") else "") + f"  {r.get('chars')}"
            for r in rows
        )

    def shallow(rows: list[dict]) -> list[dict]:
        """标题清单太长就按层级收浅，给模型看的不超过 MAX_LIST_LINES 行。"""
        level = max((int(r.get("level") or 1) for r in rows), default=1)
        while len(rows) > MAX_LIST_LINES and level > 1:
            level -= 1
            rows = [r for r in rows if int(r.get("level") or 1) <= level]
        return rows

    def plan_hint(plan: dict) -> str:
        """规划时模型自己的判断（推测的答案要点与出处、候选章节），给挑书挑章作参考。"""
        parts = []
        if plan.get("hypothesis"):
            parts.append(f"规划时的推测（只作定位参考，可能不准）：{_clip(plan['hypothesis'], 600)}")
        if plan.get("sources"):
            parts.append("规划时想到的章节：" + "、".join(f"{x.get('name')}（{x.get('layer') or '?'}）" for x in plan["sources"]))
        return "\n".join(parts)

    async def pick(prompt: str, question: str, listing: str, rows: list[dict], n: int, config, hint: str = "") -> list[dict]:
        """让模型从清单里挑 n 个坐标；只认清单里真有的。"""
        head = f"问题：{question}" + (f"\n{hint}" if hint else "")
        result = await picker.ainvoke(
            [SystemMessage(content=prompt), HumanMessage(content=f"{head}\n\n{listing}")],
            merge_config(config, HIDDEN),
        )
        by_coord = {r["coord"]: r for r in rows}
        out = []
        for raw in result.coords:
            hit = re.search(r"(\d+)[-:](\d+)", str(raw))
            row = by_coord.get(f"{hit.group(1)}-{hit.group(2)}") if hit else None
            if row and row not in out:
                out.append(row)
        return out[:n]

    async def read_chapters(state: AgentState, chapters: list[dict], used: int, config, hint: str = "") -> tuple[list, list, int]:
        """太长的章往下挑小节（看 toc），直到每节 ≤ LEAF_CHARS 或没有小节，再取整章全文。"""
        deep = bool(state.get("deep_thinking"))
        question = last_question(state["messages"])
        all_msgs: list = []
        for _ in range(NARROW_ROUNDS[deep]):
            long = [c for c in chapters if int(c.get("chars") or 0) > LEAF_CHARS]
            # 往下挑小节要先给最后的取全文留够预算：宁可读一章长的，也不能挑到最后一段都没读
            room = BUDGET[deep] - used - min(len(chapters), MAX_READ[deep])
            if room < len(long):
                long = long[: max(room, 0)]
            if not long:
                break
            calls = [("wikipali_toc", {"coord": c["coord"], "depth": 7}) for c in long]
            msgs, results, n = await researcher.run({**state, "budget_used": used}, calls, config)
            all_msgs += msgs
            used += n
            changed = False
            for c, res in zip(long, results):
                rows = [r for r in (tool_json(res) or {}).get("rows") or []
                        if r.get("coord") != c["coord"] and int(r.get("level") or 1) > int(c.get("level") or 1)]
                if not rows:
                    continue
                rows = shallow(rows)
                sub = await pick(PICK_TITLE_PROMPT.format(work=c.get("title"), n=2), question, chapter_lines(rows), rows, 2, config, hint)
                log("narrow", chapter=c["coord"], to=[r["coord"] for r in sub])
                if sub:
                    chapters = [x for x in chapters if x is not c] + sub
                    changed = True
            if not changed:
                break
        # 去重：被另一章整个包住的小节不再单独读
        chapters.sort(key=lambda c: -int(c.get("paragraphs") or 0))
        kept: list[dict] = []
        for c in chapters:
            book, para = map(int, c["coord"].split("-"))
            inside = any(int(k["coord"].split("-")[0]) == book
                         and int(k["coord"].split("-")[1]) <= para < int(k["coord"].split("-")[1]) + max(1, int(k.get("paragraphs") or 1))
                         for k in kept)
            if not inside:
                kept.append(c)
        kept = kept[: MAX_READ[deep]]
        if not kept:
            return all_msgs, [], used
        msgs, results, n = await researcher.run(
            {**state, "budget_used": used}, [("wikipali_chapter_fetch", {"coord": c["coord"]}) for c in kept], config)
        log("read", chapters=[f"{c['coord']} {c.get('title')} ({c.get('chars')})" for c in kept])
        return all_msgs + msgs, [m.id for m in results if not tool_failed(m)], used + n

    async def run_locate(state: AgentState, plan: dict, used: int, config) -> tuple[list, list, int]:
        """定位：按模型说出的章节名找坐标（容错），取最像的一个，再读。"""
        deep = bool(state.get("deep_thinking"))
        sources = [x for x in plan.get("sources") or [] if str(x.get("name") or "").strip()][: MAX_SOURCES[deep]]
        if not sources:
            return [], [], used
        calls = []
        for x in sources:
            args = {"name": x["name"].strip(), "limit": 3}
            if x.get("layer") in ("mula", "atthakatha", "tika", "anna"):
                args["layer"] = x["layer"]
            calls.append(("wikipali_locate", args))
        msgs, results, n = await researcher.run({**state, "budget_used": used}, calls, config)
        used += n
        chapters: list[dict] = []
        for res in results:
            rows = [r for r in (tool_json(res) or {}).get("rows") or [] if float(r.get("score") or 0) >= MIN_LOCATE_SCORE]
            if rows and rows[0]["coord"] not in {c["coord"] for c in chapters}:
                chapters.append(rows[0])
        log("locate", sources=[c["name"] for c in sources], hits=[f"{c['coord']} {c.get('title')}" for c in chapters])
        m2, evidence, used = await read_chapters(state, chapters, used, config, plan_hint(plan))
        return msgs + m2, evidence, used

    async def run_choose(state: AgentState, plan: dict, used: int, config) -> tuple[list, list, int]:
        """选章：从全部书里挑书 → 从整本书的标题里挑章 → 再读。"""
        deep = bool(state.get("deep_thinking"))
        question = last_question(state["messages"])
        msgs, results, n = await researcher.run(
            {**state, "budget_used": used}, [("wikipali_books", {"limit": 400, "show_tags": True})], config)
        used += n
        books = [
            {"coord": f"{b['book']}-{b['paragraph']}", "title": b.get("toc"), "tags": b.get("tags") or []}
            for b in ((tool_json(results[0]) or {}).get("rows") or [] if results else [])
        ]
        if not books:
            return msgs, [], used
        listing = "\n".join(f"{b['coord']}  {b['title']}  [{', '.join(b['tags'])}]" for b in books)
        hint = plan_hint(plan)
        chosen_books = await pick(PICK_BOOK_PROMPT.format(n=MAX_BOOKS[deep]), question, listing, books, MAX_BOOKS[deep], config, hint)
        all_msgs = list(msgs)
        # 整本书只看到第 4 层：大书（如《本生》）全部标题上千条，进消息历史太重；选中的章太长时再往下看
        tocs = [("wikipali_toc", {"coord": b["coord"], "depth": 4}) for b in chosen_books]
        m2, r2, n2 = await researcher.run({**state, "budget_used": used}, tocs, config)
        all_msgs += m2
        used += n2
        chapters: list[dict] = []
        for b, res in zip(chosen_books, r2):
            rows = shallow((tool_json(res) or {}).get("rows") or [])
            if not rows:
                continue
            sub = await pick(PICK_TITLE_PROMPT.format(work=b["title"], n=MAX_TITLES[deep]), question,
                             chapter_lines(rows), rows, MAX_TITLES[deep], config, hint)
            chapters += [r for r in sub if r["coord"] not in {c["coord"] for c in chapters}]
        log("choose", books=[f"{b['coord']} {b['title']}" for b in chosen_books], titles=[c["coord"] for c in chapters])
        m3, evidence, used = await read_chapters(state, chapters, used, config, hint)
        return all_msgs + m3, evidence, used

    async def run_route(name: str, state: AgentState, plan: dict, used: int, config) -> tuple[list, list, int]:
        deep = bool(state.get("deep_thinking"))
        if name == "locate":
            return await run_locate(state, plan, used, config)
        if name == "choose":
            return await run_choose(state, plan, used, config)
        keywords = (plan.get("keywords") or [])[: MAX_KEYWORDS[deep]]
        return await run_search(state, keywords, used, config) if keywords else ([], [], used)

    async def question_node(state: AgentState, config):
        """按问题类型走第一条路线；没取到任何材料时退回检索。快速模式再由 judge 看一眼，不够就多走一条；
        深度模式剩下的路线交给 judge 节点决定要不要走。"""
        deep = bool(state.get("deep_thinking"))
        plan = dict(state["plan"])
        order = list(plan.get("routes") or ["search"])
        first = order.pop(0)
        msgs, evidence, used = await run_route(first, state, plan, 0, config)
        tried = [first]
        if not evidence and first != "search" and "search" in order:
            current_run().retries += 1
            log("retry", reason="route-empty", route=first, next="search")
            order.remove("search")
            m2, e2, used = await run_route("search", state, plan, used, config)
            msgs += m2
            evidence += e2
            tried.append("search")
        # 快速模式：第一条路读到了东西但不一定答得了（如选章挑错了书）。用 judge 看一眼，不够就再走一条
        if not deep and evidence and order and used < BUDGET[deep]:
            verdict = await check_enough(state, msgs, evidence, plan, config)
            if not verdict.enough:
                current_run().retries += 1
                # 说得出章节名（plan 给了 sources）时，定位比关键词检索更准：先换定位
                nxt = "locate" if "locate" in order and plan.get("sources") else order[0]
                order.remove(nxt)
                log("retry", reason="not-enough", route=tried[-1], next=nxt)
                m2, e2, used = await run_route(nxt, state, plan, used, config)
                msgs += m2
                evidence += e2
                tried.append(nxt)
        plan["routes"] = order
        plan["tried"] = tried
        log("routes", tried=tried, pending=order)
        return {"messages": msgs, "budget_used": used, "evidence_ids": evidence, "rounds": 0, "plan": plan}

    async def check_enough(state: AgentState, msgs: list, evidence: list, plan: dict, config) -> Judge:
        """judge 看本轮已取到的材料够不够回答（快速 LLM、关思考）。"""
        deep = bool(state.get("deep_thinking"))
        text = build_evidence([*state["messages"], *msgs], set(evidence), EVIDENCE_CHARS[deep])
        verdict: Judge = await judge.ainvoke(
            [
                SystemMessage(content=JUDGE_PROMPT.format(max_kw=3)),
                HumanMessage(content=f"问题：{last_question(state['messages'])}\n\n计划：{json.dumps(plan, ensure_ascii=False)[:1500]}\n\n材料：\n{text}"),
            ],
            merge_config(config, HIDDEN),
        )
        log("judge", round=0, enough=str(verdict.enough).lower(), deep=str(deep).lower())
        return verdict

    async def judge_node(state: AgentState, config):
        """深度模式：LLM 判断材料够不够，不够就按它的方案补查一轮。"""
        deep = True
        ids = set(state.get("evidence_ids") or [])
        evidence = build_evidence(state["messages"], ids, EVIDENCE_CHARS[deep])
        verdict: Judge = await judge.ainvoke(
            [
                SystemMessage(content=JUDGE_PROMPT.format(max_kw=3)),
                HumanMessage(content=f"问题：{last_question(state['messages'])}\n\n计划：{json.dumps(state.get('plan') or {}, ensure_ascii=False)[:1500]}\n\n材料：\n{evidence}"),
            ],
            merge_config(config, HIDDEN),
        )
        rounds = int(state.get("rounds") or 0) + 1
        log("judge", round=rounds, enough=str(verdict.enough).lower(),
            keywords=[k.lemma for k in verdict.keywords], get=verdict.get_coords)
        if verdict.enough:
            return {"rounds": MAX_ROUNDS[deep]}
        current_run().retries += 1
        plan = dict(state.get("plan") or {})
        pending = list(plan.get("routes") or [])
        if pending:
            # 还有没走过的路线：先换路线，而不是在同一条路上补查
            nxt = pending.pop(0)
            plan["routes"] = pending
            plan["tried"] = [*(plan.get("tried") or []), nxt]
            log("judge-route", next=nxt, pending=pending)
            msgs, evidence, used = await run_route(nxt, state, plan, int(state.get("budget_used") or 0), config)
            spent = used - int(state.get("budget_used") or 0)
            return {
                "messages": msgs,
                "budget_used": used,
                "evidence_ids": [*(state.get("evidence_ids") or []), *evidence],
                "rounds": rounds if spent else MAX_ROUNDS[deep],
                "plan": plan,
            }
        # 本轮已经检索过的词（计划里的 + 前几轮补查的），不再重复检索
        ids_now = set(state.get("evidence_ids") or [])
        searched = {k.get("lemma") for k in (state.get("plan") or {}).get("keywords") or []}
        for m in state["messages"]:
            if isinstance(m, ToolMessage) and m.id in ids_now and m.additional_kwargs.get("call_name") == "wikipali_search":
                searched.add((m.additional_kwargs.get("call_args") or {}).get("lemma"))
        calls = await search_calls([k.model_dump() for k in verdict.keywords][:3], deep, searched)
        # 模型常把出处整段抄回来（「saṃ.ni.5. 171-2576」），只取其中的 book-para
        coords = []
        for raw in verdict.get_coords:
            hit = re.search(r"(\d+)[-:](\d+)", raw)
            if hit and f"{hit.group(1)}-{hit.group(2)}" not in coords:
                coords.append(f"{hit.group(1)}-{hit.group(2)}")
        if coords:
            calls.append(("wikipali_get", {"coords": coords[:6]}))
        msgs, results, used = await researcher.run(state, calls, config)
        return {
            "messages": msgs,
            "budget_used": int(state.get("budget_used") or 0) + used,
            "evidence_ids": [*(state.get("evidence_ids") or []), *[m.id for m in results]],
            "rounds": rounds if used else MAX_ROUNDS[deep],
        }

    def after_research(state: AgentState) -> str:
        deep = bool(state.get("deep_thinking"))
        if not deep:
            return "answer"
        if int(state.get("rounds") or 0) >= MAX_ROUNDS[deep]:
            return "answer"
        if int(state.get("budget_used") or 0) >= BUDGET[deep]:
            return "answer"
        return "judge"

    # ---- passage ------------------------------------------------------------
    async def passage_node(state: AgentState, config):
        deep = bool(state.get("deep_thinking"))
        p = state["passage"]
        book = int(p["book"])
        focus = int(p.get("focus") or p["paragraphs"][0])
        if p.get("source") == "selection":
            # 选中文字：所在段 + 前后各一段作上下文
            paras = sorted({max(1, focus - 1), focus, focus + 1, *map(int, p["paragraphs"])})
        else:
            paras = sorted(set(map(int, p["paragraphs"])))[:12]
        coords = [coord(book, x) for x in paras]
        channel = p.get("channel")

        async def batch(calls_: list) -> list[ToolMessage]:
            nonlocal used
            m, r, u = await researcher.run({**state, "budget_used": used}, calls_, config)
            all_msgs.extend(m)
            evidence.extend(x.id for x in r)
            used += u
            return r

        all_msgs: list = []
        evidence: list = []
        used = 0

        # 第一批：巴利原文（带出处）+ 所在章节；查词时顺带查词典
        first = [("wikipali_get", {"coords": coords, "ref": True}), ("wikipali_chapter", {"coord": coord(book, focus)})]
        selected = re.sub(r"[^\w\s]", " ", str(p.get("selected_text") or "")).split()
        if 0 < len(selected) <= 2:
            first.append(("wikipali_word", {"word": selected[0].lower()}))
        r1 = await batch(first)
        pali = tool_json(r1[0]) if not tool_failed(r1[0]) else {}
        pali_rows = (pali or {}).get("rows") or []
        pali_uid = next((((r.get("channel") or {}).get("uid")) for r in pali_rows), None)

        # 关联段落要锚在有正文的段上：屏幕顶部常是章节标题段（没有 CST 锚点，查不到义注）
        if p.get("source") == "selection":
            anchor_para = focus
        else:
            lengths: dict[int, int] = {}
            for r in pali_rows:
                lengths[int(r.get("paragraph") or 0)] = lengths.get(int(r.get("paragraph") or 0), 0) + len(r.get("text") or "")
            anchor_para = next((x for x in paras if x >= focus and lengths.get(x, 0) >= 80), focus)

        # 第二批：所选版本（与巴利原文不是同一个 channel 时）+ 义注复注的关联段落
        second = [("wikipali_related", {"coord": coord(book, anchor_para)})]
        if channel and channel != pali_uid:
            second.append(("wikipali_get", {"coords": coords, "channels": [channel]}))
        r2 = await batch(second)
        related = tool_json(r2[0]) if r2 and not tool_failed(r2[0]) else None

        # 第三批：重点段对应的义注、复注原文（每层最多 3 段）
        comm = []
        for row in (related or {}).get("rows") or []:
            if row.get("layer") in ("aṭṭhakathā", "ṭīkā"):
                comm += [coord(row["book"], int(x)) for x in (row.get("paras") or [])[:3]]
        if comm:
            await batch([("wikipali_get", {"coords": comm[:6], "ref": True})])
        log("passage", coords=coords, anchor=coord(book, anchor_para), same_channel=str(channel == pali_uid).lower(),
            commentary=comm[:6])
        # 深度模式：rounds=0 → 交给 judge 看着段落原文与义注复注决定是否补查
        return {"messages": all_msgs, "budget_used": used, "evidence_ids": evidence, "rounds": 0 if deep else MAX_ROUNDS[deep]}

    # ---- answer -------------------------------------------------------------
    async def answer_node(state: AgentState, config):
        deep = bool(state.get("deep_thinking"))
        llm = deep_llm if deep else fast_llm
        route = state.get("route")
        system = ANSWER_PROMPT
        if route == "passage":
            p = state.get("passage") or {}
            system += "\n\n" + PASSAGE_ANSWER_HINT
            system += (f"\n用户正在读的段落：{p.get('book')}-{','.join(map(str, p.get('paragraphs') or []))}"
                       f"（重点段 {p.get('book')}-{p.get('focus')}"
                       + (f"；选中文字「{p.get('selected_text')}」" if p.get("selected_text") else "") + "）")
        ids = set(state.get("evidence_ids") or [])
        context = conversation(state["messages"])
        if route != "chat":
            evidence = build_evidence(state["messages"], ids, EVIDENCE_CHARS[deep]) or "（没有检索到材料）"
            context.append(HumanMessage(content=f"【检索结果】\n{evidence}\n\n请根据以上检索结果回答我上面的问题。"))
            current_run().evidence = evidence
            log("answer", evidence_chars=len(evidence), thinking=str(deep).lower())
        reply = await llm.ainvoke([SystemMessage(content=system), *context], config)
        stats = current_run()
        stats.answer = reply.content if isinstance(reply.content, str) else str(reply.content)
        stats.assistant_message_id = reply.id
        # reasoning_content 不进消息历史：下一轮作答不带工具，不需要回传
        return {"messages": [AIMessage(content=reply.content, id=reply.id)]}

    def pick_route(state: AgentState) -> str:
        return {"passage": "passage", "term": "term", "question": "question"}.get(state.get("route"), "answer")

    builder = StateGraph(AgentState)
    builder.add_node("plan", plan_node)
    builder.add_node("passage", passage_node)
    builder.add_node("term", term_node)
    builder.add_node("question", question_node)
    builder.add_node("judge", judge_node)
    builder.add_node("answer", answer_node)
    builder.add_edge(START, "plan")
    builder.add_conditional_edges("plan", pick_route, {"passage": "passage", "term": "term", "question": "question", "answer": "answer"})
    builder.add_conditional_edges("passage", after_research, {"judge": "judge", "answer": "answer"})
    builder.add_edge("term", "answer")
    builder.add_conditional_edges("question", after_research, {"judge": "judge", "answer": "answer"})
    builder.add_conditional_edges("judge", after_research, {"judge": "judge", "answer": "answer"})
    builder.add_edge("answer", END)
    return builder.compile(checkpointer=checkpointer)
