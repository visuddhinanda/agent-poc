"""验证 AG-UI 端点：向运行中的 backend 发送 RunAgentInput，打印 SSE 事件流。

用法（需先启动 backend）:
  python scripts/test_agui_stream.py                     # 默认 http://127.0.0.1:8800
  python scripts/test_agui_stream.py http://localhost:8800 "什么是缘起？"
"""
import json
import sys

import httpx

AGENT_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8800"
QUESTION = sys.argv[2] if len(sys.argv) > 2 else "什么是四圣谛？"

body = {
    "threadId": "verify-thread-1",
    "runId": "verify-run-1",
    "tools": [],
    "context": [],
    "state": {},
    "forwardedProps": {},
    "messages": [{"id": "msg-1", "role": "user", "content": QUESTION}],
}

print(f"POST {AGENT_URL}  question={QUESTION!r}\n")
with httpx.stream("POST", AGENT_URL, json=body, timeout=180.0) as r:
    print("HTTP", r.status_code)
    for line in r.iter_lines():
        if not line.startswith("data:"):
            continue
        try:
            payload = json.loads(line[5:].strip())
        except json.JSONDecodeError:
            print("  (无法解析)", line[:100])
            continue
        t = payload.get("type", "?")
        print(f"  EVENT {t}")
        if t == "TEXT_MESSAGE_CONTENT":
            print(f"    delta: {payload.get('delta', '')!r}")
        elif t == "TOOL_CALL_START":
            print(f"    tool: {payload.get('toolCallName')}")
        elif t == "TOOL_CALL_ARGS":
            print(f"    args: {str(payload.get('delta', ''))[:160]}")
        elif t == "TOOL_CALL_END":
            print(f"    result: {str(payload.get('result', ''))[:160]}")
        elif t == "RUN_ERROR":
            print(f"    error: {str(payload.get('message', ''))[:300]}")
print("\n完成。若看到 TEXT_MESSAGE_CONTENT 即为流式回复正常；"
      "TOOL_CALL_* 为 mock 检索工具调用过程。")
