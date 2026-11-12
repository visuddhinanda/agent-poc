"""研究路径评测：直接打 backend 的 AG-UI 端点，逐题记录工具调用次数与耗时。

评测要打一个**不连 mint 的 backend**（不配 AGENT_SERVICE_KEY）：不扣费、不入库、不污染统计。
连着 mint 的正常 backend 会拒绝评测请求——直连 backend 没有客户端 IP，游客提问一律「请求无效」。

    cd backend && AGENT_SERVICE_KEY= WIKIPALI_API_URL=http://127.0.0.1:8000/api \
        .venv/bin/uvicorn main:app --port 8810          # 评测用的 backend
    EVAL_BACKEND=http://127.0.0.1:8810/ .venv/bin/python scripts/eval_routes.py

用法（EVAL_BACKEND 缺省 http://127.0.0.1:8810/）：
    .venv/bin/python scripts/eval_routes.py                  # 全部题，深度思考关
    .venv/bin/python scripts/eval_routes.py --deep           # 深度思考开
    .venv/bin/python scripts/eval_routes.py --only term      # 只跑某类题
    .venv/bin/python scripts/eval_routes.py --out base.json  # 结果另存 JSON，便于前后对比
    .venv/bin/python scripts/eval_routes.py --from-digest digest.jsonl --sample 20   # 用真实提问（wikipali admin digest）

--from-digest 读 `wikipali admin digest` 导出的 JSONL：按路由分层抽样，跳过 chat 与阅读页提问
（digest 不带阅读坐标，复现不了）；被点踩、重新生成、一分钟内换说法重问的优先入选，
`--full` 导出时回答里有不在证据中的链接、或说没找到的也优先。
评测 backend 不连 mint，所以评测运行不扣费、不入库；另记 improve=false 兜底。

每题输出：类别、工具次数（按 TOOL_CALL_START 计）、首字耗时、总耗时、回答字数、调用了哪些工具。
backend 的 [run] 汇总行（logs/backend.log）里还有路由与 LLM 次数，用 rid（= run_id）对得上。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import statistics
import sys
import time
import uuid

import httpx

# 回答里说「没找到」（与 improve-answers 技能第 2 步同一口径）
MISSING_RE = re.compile(r"检索结果(里|中)?(没有|未见|未找到)|没有找到|未能找到|not found in the (search )?results|no (relevant )?passages? (were )?found", re.I)

# 不连 mint 的评测 backend（见文件头）；连着 mint 的 backend 会把直连的游客请求当无效拒绝
BACKEND = os.environ.get("EVAL_BACKEND", "http://127.0.0.1:8810/")

# 本地 mint 的巴利原文 channel 与一个有译文的版本（与 App 联调用的同一个库）
PALI = "f4d07a00-8a5f-11ed-a044-a7a26c844686"

QUESTIONS = [
    {"kind": "term", "q": "parivāsa 是什么意思？"},
    {"kind": "term", "q": "什么是念处（satipaṭṭhāna）？"},
    {"kind": "term", "q": "anattā"},
    {"kind": "term", "q": "「samādhi」这个词在经中怎么用？"},
    {"kind": "question", "q": "佛陀初转法轮讲了什么？"},
    {"kind": "question", "q": "比丘犯了僧残罪之后要怎么处理？"},
    {"kind": "question", "q": "为什么说五蕴是无我的？"},
    {"kind": "question", "q": "慈心禅修有哪些利益？"},
    {
        "kind": "passage",
        "q": "这段经文说的是什么？",
        "passage": {"source": "screen", "book": 93, "paragraphs": [6, 7, 8], "focus": 6, "channel": PALI, "title": "Brahmajālasuttaṃ"},
    },
    {
        "kind": "passage",
        "q": "请解释我选中的这句：Evaṃ me sutaṃ",
        "passage": {"source": "selection", "book": 93, "paragraphs": [6], "focus": 6, "channel": PALI, "selected_text": "Evaṃ me sutaṃ", "title": "Brahmajālasuttaṃ"},
    },
]


def legacy_passage_prompt(p: dict) -> str:
    """旧版 App 的阅读页 system 提示词（改造前没有结构化 passage）。"""
    return (
        f"用户正在阅读经文{p['book']}-{p['focus']} channel:{p.get('channel') or ''} "
        "请根据经文巴利原文，所选channel回答用户问题。回答时请参照nissaya(如果有)相关的义注复注。"
        "只需查询巴利原文，channel内容，nissaya,必要时再查询其他信息。"
    )


async def run_one(client: httpx.AsyncClient, item: dict, deep: bool, legacy: bool) -> dict:
    run_id = f"eval-{uuid.uuid4().hex[:8]}"
    messages = []
    # 评测运行不算用户数据：run_id 非 UUID 本就入不了库，improve=false 兜底
    state: dict = {"deep_thinking": deep, "client": {"improve": False}}
    passage = item.get("passage")
    if passage:
        if legacy:
            messages.append({"id": f"sys-{run_id}", "role": "system", "content": legacy_passage_prompt(passage)})
        else:
            state["passage"] = passage
    messages.append({"id": f"u-{run_id}", "role": "user", "content": item["q"]})
    body = {
        "threadId": f"t-{run_id}",
        "runId": run_id,
        "state": state,
        "messages": messages,
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }
    started = time.monotonic()
    first_text = None
    tools: list[str] = []
    text_parts: list[str] = []
    error = None
    try:
        async with client.stream("POST", BACKEND, json=body, headers={"Accept": "text/event-stream"}) as resp:
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                event = json.loads(line[5:])
                etype = event.get("type")
                if etype == "TOOL_CALL_START":
                    tools.append(event.get("toolCallName", "?"))
                elif etype == "TEXT_MESSAGE_CONTENT":
                    if first_text is None:
                        first_text = time.monotonic() - started
                    text_parts.append(event.get("delta", ""))
                elif etype == "RUN_ERROR":
                    error = event.get("message")
    except Exception as exc:  # noqa: BLE001
        error = repr(exc)
    total = time.monotonic() - started
    answer = "".join(text_parts)
    return {
        "rid": run_id,
        "kind": item["kind"],
        "q": item["q"],
        "deep": deep,
        "tools": len(tools),
        "tool_names": tools,
        "first_text_s": round(first_text, 1) if first_text is not None else None,
        "total_s": round(total, 1),
        "answer_chars": len(answer),
        "cites": answer.count("](http"),
        "error": error,
        "answer": answer,
        "source_run": item.get("source_run"),
    }


def digest_questions(path: str, sample: int) -> list[dict]:
    """从 digest JSONL 挑题：有问题信号的优先，其余按路由轮流补满。"""
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                rows.append(json.loads(line))
    rows = [r for r in rows if r.get("route") in ("term", "question") and not r.get("from_reader") and r.get("question")]

    def flagged(r: dict) -> bool:
        """有问题信号：点踩、重新生成、一分钟内又问（多半是换说法重问）；`--full` 导出时再看回答本身。"""
        if any((f.get("rating") or 0) < 0 for f in r.get("feedback") or []):
            return True
        if (r.get("events") or {}).get("regenerate"):
            return True
        after = r.get("next_question_after_s")
        if after is not None and after < 60:
            return True
        answer, evidence = r.get("answer"), r.get("evidence")
        if answer is not None and evidence is not None:
            links = re.findall(r"https?://[^\s)\]>\"'<]+", answer)
            if any(link not in evidence for link in links):
                return True
            if MISSING_RE.search(answer):
                return True
        return False

    seen: set[str] = set()
    picked: list[dict] = []
    for r in sorted(rows, key=lambda r: not flagged(r)):
        key = r["question"].strip().lower()
        if key in seen:
            continue
        seen.add(key)
        picked.append({"kind": r["route"], "q": r["question"], "source_run": r.get("run_id"), "flagged": flagged(r)})
    flagged_items = [p for p in picked if p["flagged"]]
    rest = [p for p in picked if not p["flagged"]]
    # 其余的按路由轮流取，免得全是同一类
    by_kind = {k: [p for p in rest if p["kind"] == k] for k in ("term", "question")}
    mixed = []
    while any(by_kind.values()):
        for k in ("term", "question"):
            if by_kind[k]:
                mixed.append(by_kind[k].pop(0))
    return (flagged_items + mixed)[:sample]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--deep", action="store_true")
    ap.add_argument("--only", choices=["term", "question", "passage"])
    ap.add_argument("--legacy", action="store_true", help="阅读页题用旧版 system 提示词（改造前的基线）")
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--out")
    ap.add_argument("--from-digest", dest="from_digest", help="用 wikipali admin digest 导出的真实提问代替内置题")
    ap.add_argument("--sample", type=int, default=20, help="--from-digest 时最多跑几题")
    args = ap.parse_args()

    pool = digest_questions(args.from_digest, args.sample) if args.from_digest else QUESTIONS
    items = [q for q in pool if not args.only or q["kind"] == args.only]
    sem = asyncio.Semaphore(args.concurrency)
    async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10)) as client:
        async def guarded(item):
            async with sem:
                res = await run_one(client, item, args.deep, args.legacy)
                print(
                    f"{res['kind']:<9} tools={res['tools']:<3} first={res['first_text_s']}s total={res['total_s']}s "
                    f"chars={res['answer_chars']} cites={res['cites']} rid={res['rid']} "
                    f"{'ERR ' + str(res['error'])[:80] if res['error'] else ''}\n"
                    f"          q={res['q']}\n          tools: {', '.join(res['tool_names'])}",
                    flush=True,
                )
                return res

        results = await asyncio.gather(*(guarded(i) for i in items))

    print("\n== 汇总（deep=%s）" % args.deep)
    for kind in ("term", "question", "passage"):
        rows = [r for r in results if r["kind"] == kind and not r["error"]]
        if not rows:
            continue
        print(
            f"{kind:<9} n={len(rows)} tools中位={statistics.median(r['tools'] for r in rows)} "
            f"总耗时中位={statistics.median(r['total_s'] for r in rows)}s "
            f"首字中位={statistics.median((r['first_text_s'] or r['total_s']) for r in rows)}s"
        )
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(results, fh, ensure_ascii=False, indent=2)
    if any(r["error"] for r in results):
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
