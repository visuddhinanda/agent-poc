"""验证 backend 通过 langchain-mcp-adapters 连接 MCP server，并拉取 wikipali 真实数据。

前置: MCP server 已在 3000 端口运行（agent-poc/mcp: npm run start）。
读端工具无需凭据，可直接拉数据。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from langchain_mcp_adapters.client import MultiServerMCPClient

MCP_URL = "http://127.0.0.1:3000/mcp"


async def main() -> int:
    client = MultiServerMCPClient(
        {
            "wikipali": {
                "transport": "streamable_http",
                "url": MCP_URL,
            }
        }
    )
    tools = await client.get_tools()
    print(f"✅ 连上 MCP server，拿到 {len(tools)} 个工具")
    print("工具名（前 8 个）：", sorted(t.name for t in tools)[:8])

    by_name = {t.name: t for t in tools}
    assert "wikipali_forms" in by_name, "缺少 wikipali_forms 工具"
    assert "wikipali_search" in by_name, "缺少 wikipali_search 工具"

    # 1) 词形展开（真实 wikipali 数据）
    res = await by_name["wikipali_forms"].ainvoke({"word": "parivāsa"})
    print("\n=== wikipali_forms('parivāsa') ===")
    print(str(res)[:600])

    # 2) 检索（词形 -> 段落）
    res2 = await by_name["wikipali_search"].ainvoke(
        {"forms": ["parivāsaṃ", "parivāso"], "limit": 5}
    )
    print("\n=== wikipali_search(['parivāsaṃ','parivāso'], limit=5) ===")
    print(str(res2)[:800])

    print("\n✅ MCP 拉取 wikipali 数据成功")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
