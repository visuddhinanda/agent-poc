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

from routing import _CallEmitter, build_evidence, condense, conversation, legacy_passage  # noqa: E402


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


if __name__ == "__main__":
    tests = [v for k, v in dict(globals()).items() if k.startswith("test_")]
    for fn in tests:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"{len(tests)} passed")
