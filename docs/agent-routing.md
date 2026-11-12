# Agent 研究路径与深度思考

> 设计文档。涉及 `mobile`（wikipali-mobile 仓库）/ `web` → `runtime` → `backend` → `mcp` 全链路。
> 目标：提问后工具调用过多、推理过慢。给客户端加「深度思考」开关（默认关），
> 由 agent 按问题类型走不同的研究路径，并对工具调用设上限。
> 实现：`backend/routing.py`（研究图）、`backend/obs.py`（日志）、`backend/scripts/eval_routes.py`（评测）。

## 1. 问题与原因

旧版 agent 是一个不设限的 ReAct 循环（`chatbot ⇄ tools`）。第 0 步补上日志后量到：

| 指标（深度思考概念出现前） | 单词 / 术语 | 其他问题 |
|---|---|---|
| MCP 调用次数（中位） | 17 | 20.5 |
| 总耗时（中位） | 77 s | 90 s |

- **LLM 时间占约八成**：一次 90 秒的运行里 LLM 累计 127 秒（工具 29 秒，含并行重叠）。
- **每次 LLM 调用起步就是约 12.5k 输入 token**（48 个工具 schema + 系统提示），一次运行 17 轮、
  上下文涨到 92k token。
- `deepseek-v4-flash` 默认开启思考（effort=high），后端从没关过。
- 阅读页「这段说的是什么」有时一次工具都不调，直接凭空回答。

## 2. 社区做法与取舍

| 做法 | 出处 | 本项目用法 |
|---|---|---|
| 先路由、再走固定流程（Adaptive RAG） | LangGraph adaptive RAG 教程 | `plan` 节点用一次结构化输出给问题分类 |
| 先规划、再执行（Plan-and-Execute / ReWOO / LLMCompiler） | LangChain planning agents；LLMCompiler 论文 | LLM 一次性列出检索计划，代码并行执行；深度模式由 judge 决定是否补查 |
| 先写假设答案、只用来检索（HyDE） | HyDE | 一般问题先凭模型知识写出相关经文与巴利关键词，**不输出给用户**，只用来检索 |
| 检索后自检、有限次纠错（CRAG / Self-RAG） | LangChain self-reflective RAG | 快速模式用规则自检，深度模式用 LLM 自检，都有次数上限 |
| 显式工具预算 | LangChain 论坛 | 计数在 state 里，`recursion_limit=40` 只作兜底 |

原则：**让 LLM 决定「做什么」，让代码控制「做多少、按什么顺序、错了怎么办」。**
深度思考的开或关，改变的不是「固定 vs 自由」，而是规划深度、纠错次数和工具预算。

## 3. 客户端 → 后端的契约

客户端在发送前调用 `agent.setState({ deep_thinking, passage })`，经 AG-UI 的 `RunAgentInput.state`
送到后端。`ag_ui_langgraph` 会把 `state` 合并进图的 state，只保留图里定义过的字段，协议不用改。
客户端**只写这两项**：后端每次运行结束会回灌整份 state（消息、检索计划等），原样带回去只会让请求体变大。

| 字段 | 类型 | 说明 |
|---|---|---|
| `deep_thinking` | `bool` | 深度思考开关，缺省 `false` |
| `passage` | `object \| null` | 阅读页提问的上下文，见下 |

`passage`：

```jsonc
{
  "source": "selection" | "screen",   // 选中文字提问（含查词）/ 点按提问按钮
  "book": 93,
  "paragraphs": [7],                   // selection：选区覆盖的段；screen：屏幕上可见的段
  "focus": 7,                          // selection：选区起始段；screen：视口顶部段
  "channel": "<uuid>",                 // 读者正在看的版本，可空
  "selected_text": "bhagavā",          // 仅 selection（罗马巴利）
  "title": "1. Brahmajālasuttaṃ"       // 章节标题，仅展示用
}
```

- 选区段落由阅读器 WebView 的 `selectionchange` 上报（`sel-paras`），不用视口顶部段——选中的常是屏幕中下部的一句。
- 屏幕上的段由 RN 注入 `window.__visibleParas(reqId)` 现取（`visible-paras`），600 ms 没回就退回视口顶部段。
- 旧版 App 用 system 消息里的一句「用户正在阅读经文{book}-{para} channel:{uuid}」交代坐标；
  后端在没有 `passage` 时会从这句话还原（`legacy_passage`），兼容已发布的版本。

## 4. 图结构

```
START → plan ─┬─ passage  → passage ──┬──────────────────┐
              ├─ term     → term ─────┤                  │
              ├─ question → question ─┼─(深度)→ judge ⇄ ─┤
              └─ chat ────────────────┴──────────────────┴→ answer → END
```

- **plan**（关闭思考，结构化输出，约 1k 输入 token）：一次调用同时完成路由与规划——
  `route ∈ {term, question, chat}`、把握度、巴利原形候选（term）、检索关键词与范围 tag、
  假设答案（question）。term 的把握度低于 0.6 时按 question 处理（逃生口）。
  state 里有 `passage` 时不调 LLM，直接走 passage——规划器看不到段落原文，规划也是白做。
- **执行**：节点决定好工具调用后，交给 `_CallEmitter`（一个把工具调用当作模型流式输出吐出来的
  伪模型）再交 `ToolNode` 并行执行。直接往 state 塞 `AIMessage(tool_calls)` 不行：ag-ui 补发事件时
  父消息 id 用的是 tool_call_id，与最后 `MESSAGES_SNAPSHOT` 里的 AIMessage id 对不上，客户端同一个
  工具调用出现两次（React 报 duplicate key）。流式吐出后 ag-ui 走与真实模型相同的路径，id 一致。
  plan / judge 的结构化输出用 metadata `emit-messages=false`、`emit-tool-calls=false` 不发给客户端。
- **answer**：把本轮工具结果压成精简证据块（`condense`：检索命中给出处 + 摘要，取文给出处 + 章节路径 +
  正文），交给**不绑定工具**的 LLM 作答。快速模式关闭思考；深度模式开启思考——不绑工具，
  避开 DeepSeek「开思考 + 绑工具时每轮必须回传 reasoning_content，否则 400」的限制。
  证据上限：快速 20k、深度 36k 字符（整章取文比逐段取文长）。
- **工具白名单**：只给 forms / word / search / dist / get / ref / related / related_cs / chapter /
  locate / toc / books / chapter_fetch，写端与 `_preview` / `_commit` 一律不给。

### 4.1 路径

| | 单词 / 术语 | 其他问题 |
|---|---|---|
| 深度思考 关 | search（lemma 展开，limit 40）；0 条或展不出词形就换下一个候选原形 | 对 ≤3 个关键词并行 search（limit 8）→ 规则自检、补查一次 → 取命中最前 3 段全文（get）|
| 深度思考 开 | word（词典）+ dist + search 并行 | 对 ≤6 个关键词并行 search（limit 10）→ 规则自检 → 取前 6 段全文 → judge 判断，最多补查 2 轮 |

阅读页提问（`passage`），分三批取：

1. 巴利原文（`get ref=true`，带服务端出处）+ 所在章节（`chapter`）；选中的是一两个词（查词）时加 `word`。
2. `related` 锚在有正文的段上（selection 用选区段；screen 用视口里第一个正文 ≥ 80 字符的段——
   视口顶部常是章节标题段，没有 CST 锚点，查不到义注）；读者的版本与巴利原文不是同一个 channel 时再取该版本。
3. 关联段落里义注、复注各取前 3 段原文（`get ref=true`）。

| | 选中文字（selection） | 点按按钮（screen） |
|---|---|---|
| 取哪些段 | 选区所在段 ± 1 段 | 屏幕上可见的段（最多 12 段） |
| 深度思考 开 | 取完段落后交 judge 看着原文决定是否补查 | 同左 |

### 4.1b 一般问题的三条路线（2026-11-11）

plan 另外给出问题类型 `qtype` 与候选章节 `sources`（凭模型对三藏的了解说出最可能记载答案的章节名，
只用来定位、不给用户看）。三条路线：

| 路线 | 做法 |
|---|---|
| 检索 search | 上面 4.1 的做法：关键词逐词 search → 规则自检 → 取命中最前几段 |
| 定位 locate | `sources` 逐个 `locate`（并行），取得分 ≥ 0.8 的第一条 → 章节超过 8000 字符就看它的 `toc`，由模型挑小节（最多 2–3 轮）→ `chapter_fetch` 取全文 |
| 选章 choose | `books`（281 部书，带 tag）→ 模型挑书 → 该书 `toc`（4 层以内）→ 模型挑章 → 同上往下挑小节 → 取全文 |

挑书、挑章用快速 LLM 的结构化输出，只认清单里真有的坐标。定位、目录、书目的结果不进证据，只有取到的正文进。

按 `qtype` 决定先后（依据：agent-tuning/docs/retrieval-recall-2026-11.md 第七节，148 道真实问题、同一判官）：

| qtype | 顺序 |
|---|---|
| concept 术语概念 | 检索 → 定位 → 选章 |
| text 经文内容与出处 | 定位 → 选章 → 检索 |
| list 列举 / vinaya 戒律 / practice 修行 | 定位 → 检索 → 选章 |
| doctrine 义理辨析 / narrative 人物故事 | 选章 → 检索 → 定位 |

- **规划给了具体章节名（sources）时先定位**：选章要从 281 部书里挑，挑错册、挑错部的代价大，只在说不出章节名时更有用。
  所以 qtype 的顺序以选章打头时，有 sources 就把定位提到最前（术语概念类仍先检索）。
- 快速模式：走第一条；一段正文都没取到时退回检索；取到了就由 judge（快速 LLM）看一眼够不够，不够再走一条
  （有 sources 时优先换定位），最多两条。
- 深度模式先走第一条，judge 说不够就换下一条（还有没走过的路线时，先换路线，而不是在同一条路上补查）。
- 挑书、挑章时把规划的推测与候选章节一起给模型参考。往下挑小节前先给最后取全文留够调用次数。
- plan 的 sources 要具体到篇（某部经、某人的偈、律的某一章），不要只给整部书名；人物的自述与事迹先想长老偈 /
  长老尼偈里此人的偈与义注里此人的事迹。关键词可以给答案里原样出现的词形（如年数、数目的复合词）。

评测里只走一步时，按类型选路能作答 70/148（只用检索 40/148）；依次走完三条 90/148。

### 4.2 快速模式的规则自检

| 情况 | 自动补救 |
|---|---|
| term：展不出词形 / 0 条 | 换下一个候选原形（最多 3 个） |
| question：失败或 0 条且带了范围 tag | 去掉 tag 再搜 |
| question：命中 > 1000 段 | 加 `bold` 只看黑体词条 |
| 补查之后 | 至少留一次预算给取全文（get） |

### 4.3 预算

| | 快速 | 深度 |
|---|---|---|
| MCP 调用上限 | 14 | 24 |
| 补查轮数 | 1 | 2 |
| `recursion_limit`（兜底） | 40 | 40 |

judge 给出的补查关键词会与本轮已检索过的词去重；它给的坐标常带出处缩写（「saṃ.ni.5. 171-2576」），只取其中的 `book-para`。

### 4.1 路由枚举是跨仓库契约

路由结果（`routing.ROUTES` = question / term / passage / chat）入库为 mint 的 `agent_runs.route`，管理后台按它画图、筛选，
OpenAPI 里是枚举（mint `AgentRun::ROUTES`，前端类型由规格生成）。

- **新增 / 改名路由**：backend 的 `ROUTES` 与 mint 的 `AgentRun::ROUTES`、Resource `@return` 与控制器 `@queryParam … Enum:` 里的字面量
  一起改，重新生成规格与两份 `schema.d.ts`，再补 dashboard-v6 `admin.stats.route.<名字>` 文案。
- **核对**：backend `scripts/test_route_enum.py`（离线）检查规划器的取值 + passage = `ROUTES`、源码里写死的路由都在 `ROUTES` 里、
  `ROUTES` 与 mint OpenAPI 的枚举一致；mint `AgentRouteEnumTest` 检查注释字面量 = `AgentRun::ROUTES`；dashboard-v6 少列一种路由编译不过。
- **漏了也不丢数据**：mint 入库时不认识的路由、步骤类型照样存，只记一条警告日志（`agent trace: unknown route / step kinds`）。

## 5. 日志（第 0 步）

每次运行用 AG-UI 的 `run_id` 作 request id，经 `X-Request-Id` 头透传到 MCP，四层日志用同一个 id 对上。
`dev-up.sh` 把日志写到 `logs/*.log`。

| 层 | 日志 | 开关 |
|---|---|---|
| runtime | 每个请求：方法、路径、状态、耗时、是否被客户端中途断开 | `RUNTIME_LOG=0` 关闭 |
| backend | `[start]` 运行开始（thread、state、问题）· `[route]` 路由与关键词 · `[plan]` 假设答案 · `[llm]` 每次 LLM 调用（节点、思考开关、输入/输出 token、耗时）· `[tool>]` / `[tool<]` 每次工具调用（参数、耗时、结果大小）· `[retry]` / `[judge]` / `[budget]` 补查与预算 · `[passage]` 阅读页取段 · `[answer]` 证据大小 · `[run]` 汇总一行 | `AGENT_LOG=0` 关闭 |
| mcp | `[tool]` 每次工具调用（名称、参数、耗时、结果大小或错误）· `[http]` 每次 WikiPali 请求（路径、查询、状态、耗时、字节） | `MCP_LOG=0` 关闭 |

```
[run] rid=… thread=… route=question deep=false llm=2 tools=5 retries=1 ms=20714
```

后端改用不发 RAW 事件（`emit_raw_events=False`）：RAW 把 LangGraph 原始事件整份再发一遍，客户端用不上，只会让 SSE 体积翻倍。
`AGENT_GRAPH=react` 可以切回旧的不设限循环做对照。

## 6. 验收结果

`backend/scripts/eval_routes.py` 固定 10 题（术语 4、一般问题 4、阅读页 2），本地 mint + DeepSeek v4-flash，
并发 5。耗时为中位数；「改造前」的阅读页题用旧版 system 提示词。

| | 工具次数 | 总耗时 | 首字耗时 |
|---|---|---|---|
| 术语：改造前 | 17 | 77 s | 52 s |
| 术语：快速 | **1** | **18.5 s** | **5.2 s** |
| 术语：深度 | 3 | 39 s | 23 s |
| 一般问题：改造前 | 20.5 | 90 s | 71 s |
| 一般问题：快速 | **5** | **21 s** | **10 s** |
| 一般问题：深度 | 11 | 40 s | 29 s |
| 阅读页：改造前 | 5.5（有一题 0 次，凭空作答） | 30 s | 20 s |
| 阅读页：快速 | **4** | **9.5–17 s** | **3–9 s** |
| 阅读页：深度 | 4 + judge 补查 | 29 s | 18 s |

端到端已在 Waydroid（App）与无头 Chromium（web）上走通：AI Chat 直接提问（快速 / 深度）、
阅读页点按提问（screen）、选中文字查词 / 提问（selection，含深度）。

### 6.1 三条路线上线后（2026-11-11，本地 mint + DeepSeek v4-flash）

`eval_routes.py --only question`（4 题）：

| | 工具次数（中位） | 总耗时（中位） | 首字耗时（中位） |
|---|---|---|---|
| 一般问题：快速 | 4.5 | 15.6 s | 7.0 s |
| 一般问题：深度 | 16 | 44 s | 30 s |

快速模式的路线选择：初转法轮（text）→ 定位到《转法轮经》；僧残怎么处理（vinaya）→ 定位到律藏；
五蕴无我（doctrine）→ 选章到相应部《蕴品》的《无我相经》；慈心的利益（practice）→ 定位。
深度模式 judge 不够时依次换路线，最多用满 24 次调用。

### 6.2 用户实测后的修正（2026-11-11）

「阿难尊者做佛陀的侍者有多少年？」在 web 上答「检索结果里没有」。原因：规划的候选章节只给了整部书名
（Theragāthā-aṭṭhakathā、Mahāparinibbānasutta），人物故事类又先走选章、挑错册；快速模式没有兜底。
同一个问题在 DeepSeek 网页版能直接说出「《长老偈》阿难偈、Paṇṇavīsativassāni」——模型知道，是规划没问出来。
按 6.1 之后的修正（sources 具体到篇、有 sources 先定位、快速模式 judge 兜底一次、挑书挑章参考推测、预算留给取全文、
没出处链接时证据里明说），本地 8 题：阿难侍者 3/3 答对（10.8–17.8 s），舍利弗原名、第一次结集、五盖、缘法与缘生法
答对；大迦叶为何持头陀行读到了《迦叶相应》但挑小节没挑中 Jiṇṇasutta，仍答「没有直接回答」。
