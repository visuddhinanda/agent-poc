# 架构与数据流

> 设计文档。各服务的安装与运行方式见对应目录的 README。

## 1. 四层链路

```
浏览器 (web, Next.js)
   │  HTTP + SSE
   ▼
CopilotKit Runtime (runtime, Node)          :3001  /api/copilotkit
   │  AG-UI 协议 (POST /, SSE)
   ▼
LangGraph Agent (backend, Python/FastAPI)   :8800  POST /
   │  MCP Streamable HTTP
   ▼
WikiPali MCP Server (mcp, TypeScript)       :3000  /mcp
   │  HTTPS
   ▼
WikiPali API (www / next.wikipali.org)
```

| 层 | 目录 | 端口 | 对外入口 | 上游依赖 |
|---|---|---|---|---|
| 前端 | `web/` | 3000（`dev-up.sh` 用 3002） | `/` | runtime |
| Runtime | `runtime/` | 3001 | `/api/copilotkit` | backend |
| Agent | `backend/` | 8800 | `POST /`（AG-UI） | mcp、DeepSeek |
| MCP | `mcp/` | 3000 | `/mcp` | WikiPali API |

`dev-up.sh` 把 web 放在 3002，是为了避开 mcp 占用的 3000。

## 2. 数据流与用户识别

客户端是 App（wikipali-mobile）和网页（`web/`）。一次提问走 runtime → backend；额度、会话历史、评价等
由客户端直接调 mint（api-v13 的 `/api/v3`）。研究过程入库、额度、积分的规则见 [trace.md](trace.md)、
[credits.md](credits.md)。

### 2.1 一次提问

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant C as 客户端<br/>mobile / web
    participant R as runtime<br/>CopilotKit :3001
    participant B as backend<br/>LangGraph :8800
    participant M as mint<br/>api-v13 /api/v3
    participant P as MCP :3000
    participant L as LLM<br/>DeepSeek

    U->>C: 输入问题
    Note over C: threadId 本地生成（UUID，全局唯一）<br/>device_id 首次使用时生成并保存<br/>token 只有登录后才有
    C->>R: POST /api/copilotkit（SSE）<br/>头 X-Wikipali-User-Token（web 另带 Authorization）<br/>体 threadId、runId、messages、<br/>state.client（device_id、improve、client、app_version、locale）、<br/>state.deep_thinking、state.passage
    Note over R: 写入 X-Wikipali-Client-IP（覆盖客户端自带的同名头）<br/>TRUST_PROXY=1 时取 nginx 的 X-Real-IP，否则取连接地址
    R->>B: POST /（AG-UI），透传 authorization 与 x-* 头
    Note over B: ClientContext 汇总 token、device_id、IP、improve、locale<br/>只活在这一次请求里，不落盘
    B->>M: POST /v3/agent-charges<br/>头 X-Agent-Service-Key、Authorization（Bearer 用户 token）、Accept-Language<br/>体 run_id、thread_id、deep、device_id、client_ip
    Note over M: 认账号：有效的人类 token → user:uid<br/>没有 token 或是模型 token → guest:device_id<br/>thread_id 已属于别的账号 → 403
    alt 402 额度不足 / 403 别人的会话 / 其他 4xx 请求无效
        M-->>B: Problem Details
        B-->>R: 一条文字回复（402 另带 quota_exceeded 事件，消息 id quota-；其余 notice-）
        R-->>C: SSE
    else mint 连不上、超时或 5xx（不放行）
        B-->>R: 「网络访问错误，请稍后重试」（notice-）
        R-->>C: SSE
        B-)M: 这次记 denied 入库（先进补发队列，mint 恢复后补上）
    else 扣费成功
        M-->>B: 本次价格、剩余额度
        B->>L: 规划：问题 + 对话上下文（不含任何身份）
        loop 检索与补查
            B->>P: MCP 工具调用 wikipali_search / wikipali_get 等<br/>头 X-Request-Id
            P->>M: WikiPali 读接口（匿名，不带用户身份）
            M-->>P: 经文段落
            P-->>B: 检索结果
        end
        B->>L: 作答：问题 + 证据，流式
        L-->>B: 回答
        B-->>R: AG-UI 事件流
        R-->>C: SSE
        C-->>U: 显示回答
        B-)M: POST /v3/agent-traces（回答发完后异步，失败存本地补发队列）<br/>头 X-Agent-Service-Key、Authorization（Bearer 用户 token）<br/>体 问题、计划、证据、回答、步骤、token 用量、<br/>thread_id、device_id、client_ip、improve、client、消息 id
        Note over M: 同样的认账号规则<br/>写 agent_threads、agent_runs、agent_run_steps<br/>登录用户不记 device_id 与 IP
    end
```

### 2.2 客户端直接调 mint

```mermaid
sequenceDiagram
    participant C as 客户端<br/>mobile / web
    participant M as mint<br/>api-v13 /api/v3

    Note over C,M: 登录用户带 Authorization（Bearer token）<br/>游客带 device_id（查询参数或请求体）
    C->>M: GET /v3/agent-quota（登录或游客）
    M-->>C: 今日剩余、积分余额、价格
    C->>M: GET /v3/me/agent-threads、/v3/me/agent-threads/{thread}（仅登录）
    M-->>C: 会话列表、问答回放
    C->>M: PATCH、DELETE、PUT archive 会话（仅登录）
    C->>M: POST /v3/agent-feedback、DELETE /v3/agent-feedback/{message}（登录或游客）
    Note over M: 评价按回答消息 id 归到那次提问<br/>同时把本人那次提问记成 improve=true
    C->>M: POST /v3/agent-events（复制、点开引用等，登录或游客）
    C->>M: POST /v3/me/reading-time（读经时长，仅登录）
    C->>M: GET /v3/credit-policy（公开，不需要身份）
```

### 2.3 用户识别信息

| 信息 | 谁生成 | 怎么传 | 存在哪 |
|---|---|---|---|
| 登录 token | mint 登录时签发 | 客户端 → runtime：`X-Wikipali-User-Token`（web 另带 `Authorization`）；backend → mint：`Authorization: Bearer`；客户端直连 mint：`Authorization: Bearer` | 不存。mint 解出用户 uuid，记 `account_type = user`、`account_id = <uid>` |
| 设备匿名 id | 客户端首次使用时生成（mobile `src/user/deviceUuid`，web `localStorage["agent/device_id"]`） | AG-UI `state.client.device_id`；backend → mint 放请求体；客户端直连 mint 放查询参数或请求体 | 只对游客：`account_type = guest`、`account_id = <device_id>`。登录用户不记 |
| 客户端 IP | runtime（线上取 nginx 的 `X-Real-IP`） | runtime → backend：`X-Wikipali-Client-IP`；backend → mint：请求体 `client_ip` | 只对游客：`agent_runs.client_ip`、`credit_ledger.client_ip`（同 IP 每日上限） |
| 会话 id（threadId） | 客户端，UUID | AG-UI `threadId`；backend → mint：`thread_id` | `agent_threads.thread_id`，全局唯一，属于第一次用它的账号 |
| 消息 id | 用户消息由客户端生成，回答由 backend 生成 | AG-UI 消息；入库时带上；评价、隐式信号按回答消息 id 挂 | `agent_runs.user_message_id` / `assistant_message_id`，`agent_feedback.message_id` |
| 用于改进开关 | 用户在设置里选（默认开） | `state.client.improve` → 入库请求体 | `agent_runs.improve`（提问那一刻的值；评价过的提问改为 true） |
| 服务密钥 | 部署时配置（`AGENT_SERVICE_KEY`） | backend → mint：`X-Agent-Service-Key` | 不存。证明调用方是 agent 服务，入库与扣费接口只认它 |

要点：

- **身份只在 mint 判定**。runtime 和 backend 只负责转交，不解 token、不保存任何身份；LLM 和 MCP 拿不到身份信息。
- **模型 token 当游客处理**：对话归属、额度、积分只认人类账号。
- **游客的 IP 必须由 runtime 写**：客户端自带的 `X-Wikipali-Client-IP` 一律被覆盖，免得伪造 IP 绕过同 IP 上限。

## 3. 降级与可选依赖

| 缺什么 | 行为 |
|---|---|
| `DEEPSEEK_API_KEY` | backend 走内置 mock 演示模型（`mock_llm.py`），回答带「（mock 演示模式）」前缀 |
| MCP server 不可用 | backend 回退到内置 mock 检索工具 `retrieve_sutta_passage` |
| 无写端凭据 | 全链路降为纯读模式，读端 22 个工具无需凭据 |

因此仅启动 backend + runtime + web（不启动 mcp、不配 key）也能跑通演示。

## 4. 无状态原则

backend 与 mcp 都**不持久化任何凭据**：

- 不写文件、不读环境变量、不缓存、无会话状态；
- 凭据只在单次请求的生命周期内存在，请求结束即丢弃；
- token 由客户端持有，逐请求经 HTTP 头传递。

细节见 [凭据模型](./credentials.md)。

## 5. WikiPali 站点选择

`WIKIPALI_API_URL` 决定 mcp server 打哪个站点：

- `https://www.wikipali.org/api` —— 稳定版（默认），但 `/v2/case` 等端点会 500；
- `https://next.wikipali.org/api` —— 最新代码，**开发联调请用这个**（`dev-up.sh` 已默认）。
