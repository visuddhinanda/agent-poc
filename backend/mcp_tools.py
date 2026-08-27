"""WikiPali MCP 客户端：通过 langchain-mcp-adapters 连接无状态 MCP server，加载 wikipali 工具。

读端工具无需凭据；写端工具需要模型/用户凭据。后端本身无状态：凭据不落盘、
不来自环境变量，而是随每个请求的 HTTP 头透传（`Authorization: Bearer <modelToken>`
与 `X-Wikipali-User-Token: <userToken>`）。这里用 contextvars 暂存当前请求的凭据，
再通过 langchain-mcp-adapters 的 ToolCallInterceptor 在每次工具调用时写入 MCP 连接的
headers（该适配器对每次工具调用都会新建一个 MCP session）。
"""
import os
from contextvars import ContextVar

from langchain_mcp_adapters.client import MultiServerMCPClient

MCP_URL = os.getenv("WIKIPALI_MCP_URL", "http://127.0.0.1:3000/mcp")

# 后端 -> wikipali MCP server 需要透传的两个凭据头
MODEL_TOKEN_HEADER = "Authorization"
USER_TOKEN_HEADER = "X-Wikipali-User-Token"

# 当前请求的写端凭据（仅存在于单次请求的上下文里，请求结束即失效）
_wikipali_credentials: ContextVar[dict[str, str]] = ContextVar(
    "wikipali_credentials", default={}
)


def set_wikipali_credentials(
    *,
    authorization: str | None = None,
    user_token: str | None = None,
) -> None:
    """把当前请求携带的写端凭据注入 contextvar（由请求入口在请求开始处调用）。

    后端无状态：不保存任何 token，只把本次请求头里的两个凭据暂存，
    供本次请求内的 MCP 工具调用读取。请求结束（任务退出）后自动失效。
    """
    creds: dict[str, str] = {}
    if authorization:
        creds[MODEL_TOKEN_HEADER] = authorization
    if user_token:
        creds[USER_TOKEN_HEADER] = user_token
    _wikipali_credentials.set(creds)


class _WikipaliCredentialInterceptor:
    """ToolCallInterceptor：每次 MCP 工具调用前把当前请求的凭据写入连接头。

    langchain-mcp-adapters 对每个工具调用都会新建一个 MCP session（连接配置里的
    headers 会与之合并），因此按请求注入即可，不污染其它并发请求。
    """

    async def __call__(self, request, handler):
        creds = _wikipali_credentials.get()
        if creds:
            request = request.override(headers={**creds})
        return await handler(request)


def build_mcp_client() -> MultiServerMCPClient:
    """构建 MCP 客户端（Streamable HTTP，指向无状态 wikipali MCP server）。

    注意：这里不传任何固定凭据；凭据由 _WikipaliCredentialInterceptor
    在每次工具调用时按请求注入。
    """
    return MultiServerMCPClient(
        {
            "wikipali": {
                "transport": "streamable_http",
                "url": MCP_URL,
            }
        },
        tool_interceptors=[_WikipaliCredentialInterceptor()],
    )


async def load_wikipali_tools():
    """连接 MCP server 并加载 wikipali 工具。返回 (client, tools)。

    注意：client 必须保持存活（tools 内部持有其 session）；不要在函数结束后丢弃。
    """
    client = build_mcp_client()
    tools = await client.get_tools()
    return client, tools
