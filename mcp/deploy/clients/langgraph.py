# LangGraph 客户端样例：把 WikiPali MCP 工具挂到 agent 上。
#
# 依赖：pip install langchain-mcp-adapters langgraph langchain-openai
#
# 凭据（客户端侧）：
#   modelToken —— 写句子/术语/批注的模型身份（Authorization: Bearer）
#   userToken  —— 人类授权（X-Wikipali-User-Token）
# 建议从环境变量/密钥库读取，别写进代码。

import asyncio
import os

from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent

MCP_URL = os.getenv("WIKIPALI_MCP_URL", "http://localhost:3000/mcp")
MODEL_TOKEN = os.environ["WIKIPALI_MODEL_TOKEN"]
USER_TOKEN = os.environ["WIKIPALI_USER_TOKEN"]


async def build_tools():
    client = MultiServerMCPClient(
        {
            "wikipali": {
                "transport": "http",
                "url": MCP_URL,
                "headers": {
                    "Authorization": f"Bearer {MODEL_TOKEN}",
                    "X-Wikipali-User-Token": USER_TOKEN,
                },
            }
        }
    )
    # 读端工具无需凭据，但两个头对所有请求都无副作用（server 按工具类型挑用）
    tools = await client.get_tools()
    return client, tools


async def main():
    from langchain_openai import ChatOpenAI

    client, tools = await build_tools()
    model = ChatOpenAI(model="gpt-4o")
    agent = create_react_agent(model, tools)

    # 示例：读端（无凭据）与写端（凭据已由 headers 注入）都能用
    result = await agent.ainvoke(
        {"messages": [("user", "用 wikipali_forms 展开 parivāsa，然后告诉我第一候选的全部词形")]}
    )
    print(result["messages"][-1].content)

    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
