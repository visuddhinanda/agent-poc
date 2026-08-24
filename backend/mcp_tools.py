"""WikiPali MCP 客户端：通过 langchain-mcp-adapters 连接无状态 MCP server，加载 wikipali 工具。

读端工具无需凭据；写端工具需要客户端在 HTTP 头提供 modelToken / userToken，
这里从环境变量读取并注入（默认不注入，纯读）。
"""
import os

from langchain_mcp_adapters.client import MultiServerMCPClient

MCP_URL = os.getenv("WIKIPALI_MCP_URL", "http://127.0.0.1:3000/mcp")


def build_mcp_client() -> MultiServerMCPClient:
    """构建 MCP 客户端（Streamable HTTP，指向无状态 wikipali MCP server）。"""
    headers: dict = {}
    if os.getenv("WIKIPALI_MODEL_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['WIKIPALI_MODEL_TOKEN']}"
    if os.getenv("WIKIPALI_USER_TOKEN"):
        headers["X-Wikipali-User-Token"] = os.environ["WIKIPALI_USER_TOKEN"]

    return MultiServerMCPClient(
        {
            "wikipali": {
                "transport": "streamable_http",
                "url": MCP_URL,
                "headers": headers or None,
            }
        }
    )


async def load_wikipali_tools():
    """连接 MCP server 并加载 wikipali 工具。返回 (client, tools)。

    注意：client 必须保持存活（tools 内部持有其 session）；不要在函数结束后丢弃。
    """
    client = build_mcp_client()
    tools = await client.get_tools()
    return client, tools
