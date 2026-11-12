---
name: improve-answers
description: 用线上的用户评价、隐式信号和研究过程数据（回答、证据全文由 agent 自己评估），分析「法音 Pali-QA」回答哪里不好、该改 LangGraph 研究路径的哪里，并在改动前后用真实提问做回归评测。用户说「分析一下回答质量」「看看用户反馈」「最近点踩的都是什么问题」「优化 agent / langchain / 检索」「问题聚类」「出一份改进建议」时用。只做分析与建议；要改 backend 代码先给方案、得到用户确认（见 CLAUDE.md）。
---

# 回答质量分析与改进

数据从 mint 管理接口来，经 `wikipali` CLI 取（wikipali-plugins 插件，需管理员账号登录）。
分析结论要落到 `backend/routing.py` 的具体常量、提示词或节点上，并且**任何改动建议都要先跑评测**，
拿改动前后的对比数字说话。

## 0. 前提

- `wikipali whoami` 显示已登录，且账号是 root / administrator（否则 `admin` 命令报「不是管理员」）。
- 线上数据用 `--api next`（或 `wikipali endpoint` 切站点）；本机联调用 `--api local`。
- 评测要一个不连 mint 的 backend 在 8810 跑着（见第 4 步）、MCP 已连上：`curl -s localhost:8810/health` 里 `mcp_connected: true`。
  起服务见 `dev-up.sh`。

## 1. 取数据

```bash
wikipali admin stats agent --since <起始日>          # 总体：提问量、耗时、评价、工具
wikipali admin feedback --rating down --limit 100     # 点踩明细（原因、文字说明、对应提问）
wikipali admin feedback --has-comment                 # 所有写了文字的
wikipali admin digest --since <起始日> --limit 2000 --out digest.jsonl        # 全量信号（不带正文）
wikipali admin digest --since <起始日> --full --limit 200 --out full.jsonl   # 另带回答、证据全文、引用
wikipali admin run <run_id> --evidence                                        # 单条的研究过程 + 证据全文
```

**mint 不做回答质量评估**，回答好不好由你在第 2 步自己评。`--full` 每条可达几万字（证据全文），
一次最多 200 条：先用不带正文的 digest 挑出要看的（点踩、重新生成、换说法重问、各类抽样），
再按日期分段拉 `--full`，或逐条 `run --evidence`。

`digest.jsonl` 一行一次提问，**只含用户同意「用于改进」的提问，不含身份**。字段：

| 字段 | 用途 |
|---|---|
| `question` / `route` / `route_raw` / `confidence` | 问了什么、被分到哪条研究路径（term / question / passage / chat）、规划器把握 |
| `lemmas` / `keywords`（`lemma\|tags`） | 规划器选的巴利词与检索范围 |
| `tools[{name, ms, chars, error}]` / `retries` / `llm_calls` / `tokens` | 研究过程：调了什么、各多慢、取回多少字、补查几轮 |
| `answer` / `evidence` / `citations`（仅 `--full`） | 回答全文、给作答模型的证据全文、回答用到的引用——评估回答的原料 |
| `feedback[{rating, tags, comment, asked}]` | 用户评价；`asked=true` 是看到「这个回答有帮助吗？」后给的 |
| `events{copy, citation_open, regenerate, ask_shown}` | 隐式信号：复制、点开引用＝有用；重新生成＝不满意 |
| `next_question_after_s` | 同一会话里多久后又问了下一句；很短（<60s）且问题相近，多半是换说法重问 |

注意：
- 评价没被收进 digest 的情况：那次提问用户关了「用于改进」（尊重用户选择，不要绕过去查）。
- `status=denied`（额度拒绝）、`route=chat` 不涉及检索，分析检索问题时先过滤掉。
- 样本少时（几十条）只报观察，不下结论；点踩率要和总提问量一起报。

## 2. 评估回答（agent 自己做）

对 `--full` 拉来的每条非 chat、status=ok 的回答逐条评，结果记成 `evals.jsonl`（一行 `{run_id, 各项结论, 说明}`），
后面聚类、交叉都用它。前三项是机械核对，写个小脚本做；后三项要读原文判断：

| 项 | 怎么评 | 说明什么 |
|---|---|---|
| 引用不在证据里 | 抽出回答里所有 `http(s)://…` 链接，逐个看是否出现在 `evidence` 里 | 不在＝模型自己拼了出处，最严重 |
| 回答说没找到 | 回答里有「检索结果里没有 / 未找到 / not found」之类（chat 的自我介绍不算） | 检索不够，或者真的没有 |
| 证据过少 | `evidence` 很短（几百字以内）却作答 | 没查到东西也硬答 |
| 其实有经文 | 对「说没找到」的，自己用 `wikipali search` / `wikipali dist`（research 技能）查一遍 | 查得到＝检索漏了，对应点踩原因 `missed` |
| 不忠于证据 | 回答的关键论断能否在 `evidence` 里找到依据 | 编造内容，对应 `incorrect` |
| 层次混淆 | 回答说「经中说」的话，证据里是不是来自 aṭṭhakathā / ṭīkā | 对应 `incorrect` |

样本大时先评有问题信号的（点踩、重新生成、换说法重问），再按路由各抽一些没信号的做对照。

## 3. 分析

按这个顺序做，每一步都给出条数和例子（问题原文 + run_id）：

1. **问题聚类**：把 `question` 按主题 / 意图归类（术语释义、经文出处、教义解释、律的实务、阅读页讲解、闲聊…），
   每类给数量、点踩率、「说没找到」率（来自第 2 步）。用户语言也要分（中 / 英 / 其他）。
2. **信号交叉**：找「坏回答」——点踩、第 2 步评出问题的、`regenerate`、短时间换说法重问。
   对每条坏回答用 `wikipali admin run <run_id>` 看研究过程，判断问题出在哪一层：

   | 症状 | 先看 | 常见原因 → 改哪里 |
   |---|---|---|
   | 点踩原因 `missed`，或「说没找到」多 | `keywords`、tools 里 search 的 chars（0 或很少＝零命中） | 规划器选词没区分度 / 范围 tags 太窄 → `PLAN_PROMPT`；补查不够 → `MAX_ROUNDS`、`BUDGET`；单次命中太少 → `QUESTION_SEARCH_LIMIT`、`TERM_SEARCH_LIMIT` |
   | `citation_wrong`，或「引用不在证据里」 | 回答里的链接 vs 证据 | 作答模型自己拼链接 → `ANSWER_PROMPT` 第 3 条；证据被截断导致链接丢失 → `EVIDENCE_CHARS` |
   | `off_topic` | `route_raw`、`confidence` | 路由错（term 被当 question 或反之）→ `Plan.route` 描述与 `PLAN_PROMPT` 的判别规则 |
   | `incorrect` | 证据原文 vs 回答 | 层次混淆（义注当根本）→ `ANSWER_PROMPT` 第 4 条；证据本身不相关 → 检索选词 |
   | `too_long` / `too_academic` | 回答长度、问题语气 | `ANSWER_PROMPT` 第 1、5 条的篇幅与语气要求；是否按问题简单程度调节 |
   | `slow` | `latency_ms`、tools 的 ms、`llm_calls`、`retries` | 补查轮数、`BUDGET`、慢工具（search 均耗时）、深度思考占比 |

3. **好回答**：点赞标签（`accurate` / `useful_citations` / `clear` / `inspiring`）与 `citation_open` 多的，
   看它们的研究路径有什么共同点，改动时不要把这些弄坏。

代码位置：`backend/routing.py` 顶部常量（`BUDGET`、`MAX_ROUNDS`、`MAX_KEYWORDS`、`TERM_SEARCH_LIMIT`、
`QUESTION_SEARCH_LIMIT`、`EVIDENCE_CHARS`、`SCOPE_TAGS`），提示词 `PLAN_PROMPT` / `JUDGE_PROMPT` /
`ANSWER_PROMPT` / `PASSAGE_ANSWER_HINT`，节点 `plan_node`、`search_calls`、`judge_node`、`answer_node`。
路由设计见 `docs/agent-routing.md`，入库字段见 `docs/trace.md`。改了提示词 `PROMPT_VERSION` 会变，
之后的 run 能按版本对比。

## 4. 评测（改动前后都要跑）

评测打的是一个**不连 mint 的 backend**（不配 `AGENT_SERVICE_KEY`）：不扣费、不入库。连着 mint 的 backend 会把
直连的游客请求当无效拒绝（没有客户端 IP）。

```bash
cd backend
AGENT_SERVICE_KEY= WIKIPALI_API_URL=http://127.0.0.1:8000/api .venv/bin/uvicorn main:app --port 8810 &   # 评测 backend
.venv/bin/python scripts/eval_routes.py --from-digest digest.jsonl --sample 20 --out before.json
# ……改动……（重启 backend）
.venv/bin/python scripts/eval_routes.py --from-digest digest.jsonl --sample 20 --out after.json
```

`--from-digest` 优先挑有问题信号的提问（点踩、重新生成、一分钟内换说法重问；给的是 `--full` 导出时
再加上引用不在证据里、说没找到），其余按路由轮流补；跳过 chat 和阅读页提问（digest 不带阅读坐标）。
评测 backend 不连 mint，评测运行不扣费、不入库，不污染统计与 digest。对比时看：工具次数、总耗时、首字耗时、回答字数、
引用数（`cites`），并**人工读几条坏回答在改动后的答案**——数字变好但答案变差不算改进。

局限：digest 只有单轮问题，追问（如「Which one is the first?」）脱离上下文重放没有意义，从对比里剔除。

## 5. 报告

输出一份报告（中文，markdown），结构：

1. **数据范围**：日期、提问数、可分析数（improve=true）、评价数与覆盖率。
2. **回答评估**：第 2 步各项的条数与占比（按路由分），每项附典型例子。
3. **问题聚类**：表格（类别 / 数量 / 点踩率 / 说没找到率 / 例子）。
4. **主要问题**：按影响（条数 × 严重度）排序，每条：症状、证据（run_id + 摘录）、判断的原因层。
5. **改进建议**：每条对应到具体代码位置与改法，标明预期影响与风险；附评测前后对比（没跑评测的写「未验证」）。
6. **做得好的**：不要动的部分。
7. **数据缺口**：缺什么信号才能判断（如需要更多样本、需要记录某个字段）。

建议只是建议：要动 backend 代码，先把方案给用户确认。
