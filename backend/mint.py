"""与 mint（api-v13）的服务间通信：提问扣费 + 研究过程入库。设计见 docs/trace.md、docs/credits.md。

- 服务密钥 `AGENT_SERVICE_KEY` 走 `X-Agent-Service-Key`，证明调用方是 agent 服务；
- 终端用户 token（App / web 发来的 `X-Wikipali-User-Token`）转成 `Authorization: Bearer` 交给 mint，
  由 mint 认人：有效的人类 token 算账号，否则算游客（设备匿名 id + 客户端 IP）；
- mint 地址 `AGENT_MINT_API_URL`（缺省用 `WIKIPALI_API_URL`，与 MCP 指同一个站）。两者都没配、
  或没配服务密钥时，扣费与入库都跳过（仅限本地开发）。

agent 部署的机器连不到 mint 的数据库，所以一律走 HTTP API。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional

import httpx

SERVICE_KEY_HEADER = "X-Agent-Service-Key"
TIMEOUT = httpx.Timeout(5.0, connect=2.0)


def api_url() -> str:
    return (os.getenv("AGENT_MINT_API_URL") or os.getenv("WIKIPALI_API_URL") or "").rstrip("/")


def service_key() -> str:
    return os.getenv("AGENT_SERVICE_KEY", "")


def enabled() -> bool:
    return bool(api_url() and service_key())


@dataclass
class ClientContext:
    """一次请求里与「这次提问算谁的」有关的信息：来自请求头与 AG-UI state.client。"""

    user_token: Optional[str] = None
    device_id: Optional[str] = None
    client_ip: Optional[str] = None
    improve: bool = True
    client: Optional[str] = None
    app_version: Optional[str] = None
    locale: Optional[str] = None
    # 「重新生成」时客户端带上被替换那条回答的 AG-UI 消息 id，mint 据此记 replaces_run_id
    replaces_message_id: Optional[str] = None

    @classmethod
    def from_request(cls, headers, state: Optional[dict]) -> "ClientContext":
        client = (state or {}).get("client") or {}
        # runtime 写的客户端 IP（它会覆盖客户端自带的同名头，见 runtime/server.ts）
        ip = (headers.get("x-wikipali-client-ip") or "").strip() or None
        return cls(
            user_token=headers.get("x-wikipali-user-token") or None,
            device_id=client.get("device_id") or None,
            client_ip=ip,
            improve=client.get("improve", True) is not False,
            client=client.get("client") if client.get("client") in ("mobile", "web") else None,
            app_version=(str(client["app_version"])[:32] if client.get("app_version") else None),
            locale=(str(client["locale"])[:16] if client.get("locale") else None),
            replaces_message_id=(str(client["replaces_message_id"])[:64] if client.get("replaces_message_id") else None),
        )

    def headers(self) -> dict[str, str]:
        out = {SERVICE_KEY_HEADER: service_key(), "Accept": "application/json"}
        if self.user_token:
            out["Authorization"] = f"Bearer {self.user_token}"
        if self.locale:
            out["Accept-Language"] = self.locale
        return out


_client: Optional[httpx.AsyncClient] = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=TIMEOUT)
    return _client


async def post(path: str, ctx: ClientContext, body: dict[str, Any]) -> httpx.Response:
    return await client().post(f"{api_url()}{path}", json=body, headers=ctx.headers())
