"""routing.py 的离线自检（不连网、不调 LLM）。

用法：.venv/bin/python scripts/test_routing_offline.py
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEEPSEEK_API_KEY", "offline")

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage  # noqa: E402

from routing import QTYPES, ROUTE_ORDER, Plan, _CallEmitter, build_evidence, condense, conversation, legacy_passage  # noqa: E402


def test_legacy_passage():
    msgs = [SystemMessage(content="用户正在阅读经文93-6 channel:f4d07a00-8a5f-11ed-a044-a7a26c844686 请根据…"),
            HumanMessage(content="这段说什么")]
    p = legacy_passage(msgs)
    assert p == {"source": "screen", "book": 93, "paragraphs": [6], "focus": 6,
                 "channel": "f4d07a00-8a5f-11ed-a044-a7a26c844686"}, p
    assert legacy_passage([HumanMessage(content="hi")]) is None


def test_condense_search_and_get():
    search = {"count": 2, "rows": [{"cite": "[dī.ni.1. 93-6](https://x/93-5/read#6)", "path": "a › b", "highlight": "Evaṃ me sutaṃ"}]}
    text = condense("wikipali_search", {"lemma": "evaṃ", "tags": "mūla"}, search)
    assert "命中 2 段" in text and "[dī.ni.1. 93-6](https://x/93-5/read#6)" in text and "范围 mūla" in text
    get = {"rows": [{"coord": "93-6", "channel": {"name": "pali"}, "text": "Evaṃ me sutaṃ"}],
           "refs": [{"coord": "93-6", "cite": "[dī.ni.1. 93-6](https://x)", "path": "DN › Brahmajāla"}]}
    text = condense("wikipali_get", {"coords": ["93-6"]}, get)
    assert text.startswith("【[dī.ni.1. 93-6](https://x)｜DN › Brahmajāla】（pali）Evaṃ"), text


def test_build_evidence_only_this_turn():
    ai = AIMessage(content="", tool_calls=[{"id": "c1", "name": "wikipali_search", "args": {"lemma": "x"}, "type": "tool_call"}])
    old = ToolMessage(content=json.dumps({"count": 9, "rows": []}), tool_call_id="c0", id="c0")
    new = ToolMessage(content=json.dumps({"count": 1, "rows": []}), tool_call_id="c1", id="c1")
    ev = build_evidence([old, ai, new], {"c1"}, 1000)
    assert "命中 1 段" in ev and "命中 9 段" not in ev


def test_conversation_drops_tool_traffic():
    ai_call = AIMessage(content="", tool_calls=[{"id": "c1", "name": "t", "args": {}, "type": "tool_call"}])
    msgs = [HumanMessage(content="q1"), ai_call, ToolMessage(content="r", tool_call_id="c1"), AIMessage(content="a1"), HumanMessage(content="q2")]
    assert [m.content for m in conversation(msgs)] == ["q1", "a1", "q2"]


def test_emitter_streams_one_call_per_chunk():
    calls = [{"id": "call_a", "name": "wikipali_get", "args": {"coords": ["1-2"]}},
             {"id": "call_b", "name": "wikipali_chapter", "args": {"coord": "1-2"}}]
    emitter = _CallEmitter(calls=calls, message_id="run-x")

    async def collect():
        return [c async for c in emitter.astream([HumanMessage(content="-")])]

    # LangChain 1.x 会在流末尾自己追加一个空的结束块（id 是 lc_run--…，没有内容也没有工具块），
    # ag-ui 对它不发任何事件；这里只看 emitter 自己吐的块
    chunks = [c for c in asyncio.run(collect()) if c.id == "run-x"]
    # ag-ui 每个 chunk 只读第一个 tool_call_chunk：每块恰好一个，最后一块为空（结束最后一个调用）
    assert [len(c.tool_call_chunks) for c in chunks] == [1, 1, 1, 1, 0]
    assert [c.tool_call_chunks[0]["id"] for c in chunks[:4] if c.tool_call_chunks[0]["id"]] == ["call_a", "call_b"]
    final = asyncio.run(emitter.ainvoke([HumanMessage(content="-")]))
    assert final.id == "run-x" and [tc["id"] for tc in final.tool_calls] == ["call_a", "call_b"]
    assert final.tool_calls[0]["args"] == {"coords": ["1-2"]}


def test_condense_chapter_fetch_keeps_sentence_ids():
    data = {"coord": "94-585", "rows": [{"para": 588, "sentences": [
        {"id": "94-588-14-32", "text": "vayadhammā saṅkhārā appamādena sampādethā"},
        {"id": "94-588-33-37", "text": "Ayaṃ tathāgatassa pacchimā vācā ."}]}]}
    text = condense("wikipali_chapter_fetch", {"coord": "94-585"}, data)
    assert text.startswith("【整章 94-585（本章没有出处链接，引用时只写坐标或句子 id）】〔94-588-14-32〕vayadhammā"), text
    assert "〔94-588-33-37〕Ayaṃ" in text
    cited = condense("wikipali_chapter_fetch", {"coord": "94-585"},
                     {**data, "cite": "[dī.ni.2. 94-586](https://x)", "path": "DN › Mahāparinibbāna"})
    assert cited.startswith("【整章 [dī.ni.2. 94-586](https://x)｜DN › Mahāparinibbāna】〔94-588-14-32〕"), cited
    assert condense("wikipali_chapter_fetch", {"coord": "1-2"}, {"rows": []}) == "（该章在这个版本下没有内容）"


def test_every_qtype_orders_all_three_routes():
    assert set(QTYPES) == set(ROUTE_ORDER) == set(Plan.model_fields["qtype"].annotation.__args__)
    for qtype, order in ROUTE_ORDER.items():
        assert sorted(order) == ["choose", "locate", "search"], qtype
    # 术语概念类检索最强；经文出处类先定位；义理辨析先选章（依据见 agent-tuning 文档第七节）
    assert ROUTE_ORDER["concept"][0] == "search"
    assert ROUTE_ORDER["text"][0] == "locate"
    assert ROUTE_ORDER["doctrine"][0] == "choose"


if __name__ == "__main__":
    tests = [v for k, v in dict(globals()).items() if k.startswith("test_")]
    for fn in tests:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"{len(tests)} passed")
