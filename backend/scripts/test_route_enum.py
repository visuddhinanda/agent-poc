"""路由枚举核对（离线，不连网、不调 LLM）。

routing.py 产生的研究路径必须都在 mint 的路由枚举里：mint 入库时不认识的路由照样存、只记警告，
但管理后台画图、筛选只认枚举里的值，漏了就统计不到。这里核对三件事：

1. 规划器 Plan.route 的取值加上 passage，正好等于 routing.ROUTES；
2. routing.py 源码里写死的路由字面量都在 ROUTES 里；
3. ROUTES 与 mint OpenAPI 规格里 agent_runs.route 的枚举一致（mint 侧的 AgentRun::ROUTES 由它自己的测试守住）。

mint 规格默认从同级目录的 mint 仓库读：<agent-poc>/../mint/openapi/public/assets/protocol，
别处用环境变量 MINT_OPENAPI_DIR 指定。读不到规格算失败，不静默跳过。

用法：.venv/bin/python scripts/test_route_enum.py
"""
import os
import re
import sys
from typing import get_args

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)
os.environ.setdefault("DEEPSEEK_API_KEY", "offline")

from routing import ROUTES, Plan  # noqa: E402

SPEC_DIR = os.environ.get(
    "MINT_OPENAPI_DIR",
    os.path.join(os.path.dirname(os.path.dirname(BACKEND)), "mint", "openapi", "public", "assets", "protocol"),
)
# 一次提问的详情：route 字段的枚举（列表、评价审阅、筛选参数与它同源，mint 测试保证一致）
SPEC_FILE = os.path.join(SPEC_DIR, "resources", "auto", "v3-admin-agent-runs-run.yaml")


def spec_routes() -> list[str]:
    if not os.path.exists(SPEC_FILE):
        raise SystemExit(f"找不到 mint OpenAPI 规格：{SPEC_FILE}（设 MINT_OPENAPI_DIR 指向 mint/openapi/public/assets/protocol）")
    spec = yaml.safe_load(open(SPEC_FILE, encoding="utf-8"))
    responses = spec["get"]["responses"]
    ok = responses.get(200) or responses.get("200")  # YAML 里状态码可能被解析成整数
    schema = ok["content"]["application/json"]["schema"]
    route = schema["properties"]["data"]["properties"]["route"]
    assert "enum" in route, f"mint 规格里 route 没有枚举：{route}"
    return route["enum"]


def test_plan_routes_plus_passage_match():
    planner = set(get_args(Plan.model_fields["route"].annotation))
    assert planner | {"passage"} == set(ROUTES), f"Plan.route={sorted(planner)} + passage ≠ ROUTES={ROUTES}"


def test_literal_routes_in_source_are_known():
    src = open(os.path.join(BACKEND, "routing.py"), encoding="utf-8").read()
    used = set(re.findall(r'(?:\broute\s*=\s*|"route":\s*|stats\.route\s*=\s*)"([a-z_]+)"', src))
    unknown = used - set(ROUTES)
    assert not unknown, f"routing.py 里用了不在 ROUTES 里的路由：{sorted(unknown)}"


def test_routes_match_mint_spec():
    mint = spec_routes()
    assert set(mint) == set(ROUTES), (
        f"路由枚举不一致：backend ROUTES={list(ROUTES)}，mint OpenAPI={mint}。"
        "改 mint 的 AgentRun::ROUTES 与 Resource / 控制器注释里的字面量，重新生成规格"
    )


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("全部通过")
