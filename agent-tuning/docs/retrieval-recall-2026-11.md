# 巴利文检索召回优化（2026-11）

用 agent-tuning 收集的真实问答，评测并优化 agent 检索巴利原典的召回率。本文包括三部分：
社区 RAG 优化方案调研、用真实问题做的测试，以及已经落地的优化与结果。

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-11-11 |
| 服务对象 | 问藏后端（`backend/`，经 `mcp/` 检索）、wikipali-plugins（Claude 等 agent 经 CLI 检索） |
| 已落地 | mint `202750c7c`（后端罕见度加权）；wikipali-plugins 0.26.0（`find` 命令 + 选词规则）。均未 push |
| 问藏本身 | **还没有改**。要受益需同步进 `mcp/` 与 `backend/routing.py`，见第五节 |
| 后端文档 | mint `api-v13/documents/search-recall.md`（计分细节与下一波计划） |

---

## 一、背景：agent 现在怎么检索

问藏的问题路由（`backend/routing.py` 的 question 路线）：

1. 规划阶段从问题里选最多 3 个巴利关键词。
2. 每个词各自调一次 `v2/search-pali-wbw`（逐词表 `wbw_templates`，该词全部词形 OR），
   快速模式取前 8 段、深度模式 10 段；某个词命中超过 1000 段时，补一次只看黑体（`bold=on`）。
3. 各词的结果轮流合并、去重，读前 3 段（深度模式 6 段）全文，据此回答。

这套流程的特点：每个词各自排出「这个词最重要的段落」，**几个概念同时出现的段落排不上来**；
而且回答质量完全取决于第 1 步选的词。

mint 后端另有 `GET /v3/search`（OpenSearch，约 55 万段），2026-11 新增两种多词模式：

- `fuzzy`：多词按词序与拼写逐项计分——整句原样、相邻两词原样、拼写相同、同义词（词形）可替代，
  逐项累加；一个词都能命中也会返回，只是分低。
- `definition`：每个词命中义注里的单独黑体字给高分，命中多个黑体词更高；正文只作次级排序。
  用来找「把某词当词条解释」的段落。

---

## 二、社区 RAG 优化方案调研

调研了 2025–2026 年的公开实践，归成 6 类，并对照到本项目的现状。

### 1. 混合检索：关键词 + 向量，用 RRF 合并排名

关键词检索（BM25）与向量检索同时跑，用 **RRF（Reciprocal Rank Fusion，倒数排名融合）** 合并：
每条结果的分数 = Σ 1/(k + 名次)，k 一般取 60。按名次而不是原始分数合并，所以不用管两种检索的
分数尺度不同。社区公认这是提高召回最稳的一步，但报告的提升从 +5% 到 +24% 都有，调得不好
反而比单用向量差。

对照本项目：

- 索引已有 `content.vector`（OpenAI embedding，1536 维），`search_mode=hybrid` 也存在，
  但它是把两边分数直接相加，没有用 RRF。
- OpenSearch 的 RRF 处理器（`score-ranker-processor`）要 2.19；本地是 2.18。不升级的话可以在
  应用层按名次合并。
- 向量模型是关键：OpenAI 通用模型对巴利文的效果没评测过。Dharmamitra 发布了佛典专用的跨语言
  模型 **MITRA**（`buddhist-nlp/mitra-qwen35-embedder`），支持巴利 / 梵 / 藏 / 汉互检，模型卡称
  优于 BGE-M3、Qwen3-Embedding；**没找到针对巴利文的公开评测**，需要自己测。
- 价值：用户的中文问题可以直接召回巴利段落，**不再依赖 agent 选对巴利词**——这是下面测试里的
  头号瓶颈。

### 2. 查询改写：一个问题生成多组检索词，再合并

- **多路查询（RAG-Fusion）**：同一问题改写成几种说法，各搜一次，RRF 合并。
- **拆分子问题**：适合多步推理的问题。
- **HyDE**：先让模型写一段假设答案，用它去检索。

社区提醒：简单问题硬拆会白白增加延迟，常见做法是先分类再决定要不要拆。

对照本项目：正对「关键词选错」。可以让 agent 每题生成几组词——话题词（`sāriputta`）、
答案词（`upatissa`）、引文原词（`appamādena sampādetha`）——各搜一次再融合。

### 3. 重排（rerank）

从融合后的前 50–150 段里，用 cross-encoder 重排模型（如多语言的 bge-reranker-v2-m3）或便宜的
LLM 逐段对照问题打分再排。重排只能调整顺序，找不回没召回的段落，要和 1、2 配合。

对照本项目：agent 只读前 3 段全文，重排直接作用在这一步。

### 4. 给段落补上下文（Contextual Retrieval）

Anthropic 提出：建索引时在每个片段前补一句说明它的上下文，关键词与向量两边都用补过的文本。
他们自己的评测：检索失败率下降 49%，加上重排下降 67%（没看到独立复现）。

对照本项目：「阿难做侍者多少年」失败，正是因为答案所在的偈颂里没有 `ānanda`，人名只在章节标题
（如 Ānandattheragāthā）里。把章节路径（`path`）和段落标题拼进索引文本即可；索引里的
`summary` 字段现在是空的，可以放中文摘要，让中文问题也能直接匹配。

### 5. 词形还原与拆复合词

屈折变化多的语言：爱沙尼亚语研究显示，用词形还原代替词干提取，BM25 效果提高约 10%；
拆复合词有帮助，但拆错会改义，需要规则限制。

对照本项目：现在全部词形靠同义词词典（`pali_synonyms`）展开，测试里漏掉的段落都是词典缺词形
（`vitakkāni`），或复合词、连音没拆开（`koṭisanthāra`、`vassaṃvutthānaṃ`）。`wbw_templates`
里已有拆好的词和词根，给每段写一个词根字段进索引，比维护同义词表可靠。

### 6. 用自己的语料做评测

所有来源都强调：别人的提升幅度在你的语料上不一定成立，每个改动都要在自己的语料上测前后召回。
本项目的评测就建立在 agent-tuning 的真实问答上（见第三节）。

### 调研后的优先顺序

| 顺序 | 方案 | 针对的问题 | 工作量 | 本波 |
| --- | --- | --- | --- | --- |
| 1 | 多路检索 + RRF、选词规则（第 2 类） | 关键词选错、多概念段落排不上来 | 小：不动索引 | **已做** |
| — | 按词的罕见度加权（BM25 的 IDF） | 常见词淹没罕见词 | 小 | **已做**（测试中发现） |
| 2 | 补上下文（第 4 类） | 答案段落缺主语 | 中：重建索引 | 下一波 |
| 3 | 重排（第 3 类） | 读全文的前 3 段命中少 | 中：多一次模型调用 | 下一波 |
| 4 | 词根字段（第 5 类） | 同义词缺词形、连音、复合词 | 中：重建索引 | 下一波 |
| 5 | 换向量模型 + RRF 混合检索（第 1 类） | 中文问题直接找巴利原文 | 大：先评测 MITRA | 下一波 |

本波只用现有索引能力；需要向量、模型或重建索引的放下一波。

### 参考来源

- [Hybrid Search for RAG: Combining BM25 and Dense Vector Search (2026 Guide)](https://denser.ai/blog/hybrid-search-for-rag/)
- [Hybrid Search for RAG: BM25, SPLADE, and Vector Search Combined](https://blog.premai.io/hybrid-search-for-rag-bm25-splade-and-vector-search-combined)
- [Hybrid RAG](https://atlan.com/know/hybrid-rag/)
- [Hybrid Search in Production: Why BM25 Still Wins on the Queries That Matter](https://tianpan.co/blog/2026-04-12-hybrid-search-production-bm25-dense-embeddings)
- [When Embeddings Aren't Enough: A Decision Framework for Hybrid Retrieval Architecture](https://tianpan.co/blog/2026-04-17-hybrid-retrieval-architecture-beyond-embeddings)
- [The Query Rewrite Layer Your RAG System Is Missing](https://tianpan.co/blog/2026-04-16-rag-query-rewrite-layer)
- [Query Optimization for RAG: Rewriting, Expanding, Resolving, and Decomposing User Queries](https://www.besthub.dev/articles/query-optimization-for-rag-rewriting-expanding-resolving-and-decomposing-user-queries-c7c0b885bcca)
- [Agentic Retrieval Deepdive](https://trilogyai.substack.com/p/agentic-retrieval-deepdive?open=false)
- [Anthropic: Contextual Retrieval](https://anthropic.com/news/contextual-retrieval)
- [mitra-qwen35-embedder (Hugging Face)](https://huggingface.co/buddhist-nlp/mitra-qwen35-embedder)
- [Dharmamitra guides / DharmaNexus](https://dharmamitra.github.io/dharmamitra-guides/dharmanexus)
- [[INDOLOGY] Introduction of MITRA Search, Deep Research, and DharmaNexus](https://list.indology.info/pipermail/indology/2025-July/060877.html)
- [A case study on decompounding in Indian language IR](https://www.cambridge.org/core/services/aop-cambridge-core/content/view/E6F514388148C425400BE469E20209F8/S2977042424000165a.pdf/a-case-study-on-decompounding-in-indian-language-ir.pdf)
- [arXiv 2603.23972（Estonian lemmatization for retrieval）](https://arxiv.org/pdf/2603.23972v1)
- [OpenSearch normalization processor](https://opensearch.org/docs/search-plugins/search-pipelines/normalization-processor/)

---

## 三、测试

全部只调用本地 API（`http://127.0.0.1:8000/api`），不碰线上。

### 3.1 数据：问题聚类

`data/raw/mail/` 下 94 封「问藏简报」，共 6526 条问答、4510 个不同问题。约 25 个问题各重复
约 50 次，像是固定的评测集。问题大致分 9 类：

术语释义、列举数目、人物事迹、地点事件、戒律僧团、修行方法、阿毗达摩义理、找原文出处，
以及语料之外（茶、中医、闲聊）。

### 3.2 前置测试：新接口单个词的召回不低于老接口

在考虑用 `/v3/search` 补充或替代 `search-pali-wbw` 之前，先确认单个词能找全。
10 个词根，`v2/case` 展开全部词形 → 老接口取全部段落（全部 / 只看黑体）→ 对比新接口
`definition` 模式全量分页：

| 指标 | 结果 |
| --- | --- |
| 段落召回 | 98.7–100% |
| 黑体段落召回 | 98.7–100% |
| 黑体段落排进前 R 名 | 修正「任一词形都计主分」后从 23–44% 提高到 93–100% |

漏掉的 0–1.3%：同义词词典缺词形（如 `vitakkāni`），以及正文里粘了连音的词（`vitakkanti`、
`nīvaraṇeti`）——老接口查的是拆好连音的逐词表。

### 3.3 调参集：12 个典型问题

从前 8 类里挑 12 题。**标准段落**：答案必须同时出现的几个概念，各自用 `v2/case` 展开词形、
`search-pali-wbw` 取全部段落再取交集。全程只用老接口，不经 OpenSearch，避免拿新接口给自己判卷。

| 问题 | agent 当时选的词 | 选对的词（标准概念） |
| --- | --- | --- |
| 佛陀在哪里初转法轮 | dhammacakkappavattana isipatana migadāya | dhammacakka + isipatana |
| 阿难做侍者多少年 | ānanda upaṭṭhāka parinibbāna | pañcavīsati… + upaṭṭhāka |
| 大迦叶为什么受持头陀行 | dhutaṅga paṃsukūla araññaka | mahākassapa + dhutaṅga |
| 第一次结集在哪里、多少比库 | saṅgīti rājagaha bhikkhu | saṅgīti + sattapaṇṇiguhā |
| 舍利弗原名叫什么 | sāriputta nāma | sāriputta + upatissa |
| 五盖是哪五个 | nīvaraṇa kāmacchanda byāpāda | nīvaraṇa + kāmacchanda + vicikicchā |
| 择法觉支是什么意思 | dhammavicayasambojjhaṅga bojjhaṅga | dhammavicayasambojjhaṅga（黑体） |
| 佛陀最后的教诫 | parinibbāna appamāda ovāda | vayadhamma + saṅkhāra + appamāda |
| 迦絺那衣是什么、何时受 | kaṭhina cīvara pavāraṇā | （剔除：逐词表把 vassaṃvutthānaṃ 拆成两词，做不出标准） |
| 四词共同出现的经文 | uṭṭhānasampadā ārakkhasampadā kalyāṇamittatā | 四个 sampadā/samajīvitā 同现 |
| 祇树给孤独园怎么来的 | anāthapiṇḍika jetavana ārāma | jeta + koṭisanthāra… |
| 缘起十二支按顺序 | paṭiccasamuppāda avijjā saṅkhāra | avijjā saṅkhāra nāmarūpa saḷāyatana upādāna jāti |

**比较方法**：照搬问藏快速模式（每词前 8 段、过千补黑体、轮流合并、读前 3 段），记下合并后的
段数作为「阅读窗口」；新方法在**相同大小的窗口**里数命中几个标准段落。实际比较 11 题。

#### 第一轮结果（后端加权之前）

| 关键词 | 方法 | 窗口内标准段落 | 前 3 段 | 有命中的题 |
| --- | --- | --- | --- | --- |
| agent 当时选的 | 现状（逐词） | 21 | 5 | 5 |
| | 新 definition | 11 | 2 | 5 |
| | 新 fuzzy | **27** | 5 | 5 |
| 选对的 | 现状（逐词） | 28 | 8 | 8 |
| | 新 definition | 27 | **10** | 8 |
| | 新 fuzzy | **68** | 8 | 8 |

发现：

1. **最大瓶颈是选词，不是检索方式。** 用 agent 自己选的词，11 题里 6 题三种方法都一个标准段落
   也找不到。例：「最后的教诫」搜 `parinibbāna appamāda ovāda`，原文是
   `vayadhammā saṅkhārā appamādena sampādetha`；「舍利弗原名」搜 `sāriputta nāma`，答案在
   `upatissa`。只把词选对，现状就从 5 题有命中提高到 8 题。
2. **多概念、列举类问题合并查询提升最大。** 选对词时 fuzzy 窗口内 28 → 68（约 2.4 倍）：
   五盖 3 → 23，缘起十二支 0 → 21，初转法轮 1 → 13。
3. **definition 擅长把定义段落排进前 3，但常见词会淹没罕见词。** `bojjhaṅga`、`kalyāṇamittatā`
   这类到处是黑体的词每段都拿满分，真正要找的 `dhammavicayasambojjhaṅga` 排不上来。
   → 促成后端「罕见度加权」。
4. **fuzzy 传词根会失效。** 「最后的教诫」用词根 `vayadhamma saṅkhāra appamāda` 查一段都没中：
   原文是变格形，「拼写相同」的分永远拿不到，排序近似随机。fuzzy 适合传原文实际词形或一句引文。

### 3.4 留出集：148 个真实问题（主判据）

用户要求方案**可泛化**：不能只针对几个问题优化，不在提示词里写死查询；不一定每题都提升，但
**大部分题要更好或持平**。所以调参集只用来找方向，结论在留出集上检验。

- 从问答数据里排除调参集，固定种子（20261111）随机抽 150 题，可用 148 题。
- 标准 = agent 历次回答里实际引用过的段落坐标。
- 关键词 = 该问题出现最多的 `pali_terms` 前 3 个（即 agent 当时选的词）。
- 这个标准**偏向现状**（引用本来就是现有检索找到的），新方法在这里持平就说明不倒退。

指标：相同阅读窗口内命中几个标准段落；前 3 段命中几个；逐题相对现状「更好 / 持平 / 更差」。

---

## 四、落地的优化与结果

### 4.1 后端：按词的罕见度加权（mint）

多词 `fuzzy` / `definition` 的单词子句乘一个罕见度权重：

- 用 BM25 的 IDF 公式 `log(1 + (N − df + 0.5)/(df + 0.5))`，按查询里最罕见的词归一。
- 取对数后差距太小（`bojjhaṅga` df 887 对 `dhammavicayasambojjhaṅga` df 211 只差 0.82 : 1），
  归一后再取 **4 次方**拉开，下限 0.2。
- 词序子句（整句、相邻两词）不加权；单个词、中文查询不受影响。
- 文档频率一次 `_msearch` 批量取，按词缓存一天。

逐题对比（指数 4 对比不加权，留出集）：

| 路 | 更好 | 持平 | 更差 |
| --- | --- | --- | --- |
| fuzzy | 25 | 113 | 10 |
| definition | 24 | 117 | 7 |

指数 1 的效果介于两者之间，采用指数 4。

### 4.2 插件：`wikipali find`，多路检索 + RRF（wikipali-plugins 0.26.0）

- 每个词各自走 `search-pali-wbw`（与问藏现状相同：每词前 8 段、过千补黑体）；再加一次多词
  `/v3/search` fuzzy。
- 两路按名次融合（RRF，k=60）。
- **前 3 段沿用逐词检索的轮流排序**，其余名额按融合结果补（下称「保头部」）。
- 合并检索失败时退回只用逐词结果。

融合方式在留出集上的离线比较（同一份检索结果，只换合并方法）：

| 方法 | 窗口内命中 | 相对现状 好 / 平 / 差 | 前 3 命中 | 相对现状 好 / 平 / 差 |
| --- | --- | --- | --- | --- |
| 现状：逐词检索 | 296 | — | 88 | — |
| 只用 definition | 200 | 18 / 67 / 63 | 74 | 27 / 83 / 38 |
| 只用 fuzzy | 215 | 36 / 49 / 63 | 65 | 28 / 71 / 49 |
| RRF 等权（逐词 + fuzzy + definition） | 311 | 31 / 98 / 19 | 80 | 24 / 93 / 31 |
| **保头部 + RRF（逐词 + fuzzy）← 采用** | **325（+10%）** | **33 / 100 / 15（89% 好或平）** | **88** | **0 / 148 / 0** |

结论：

- 单用新接口都不如逐词检索，**只能补充，不能替代**。
- 等权 RRF 会把前 3 段换掉（88 → 80）。前 3 段是 agent 读全文的部分，所以保留现状的头部。
- 再加 definition 一路没有额外收益，18 道定义类问题上也一样，所以 `find` 不放它；
  查黑体定义仍可单独用 `phrase`。

调参集复核（采用的配置）：

| 关键词 | 现状 窗内 / 前 3 | `find` 窗内 / 前 3 |
| --- | --- | --- |
| agent 当时选的 | 21 / 5 | 20 / 5 |
| 选对的 | 28 / 8 | 33 / 8 |

### 4.3 选词规则（插件 research skill）

把「查询改写」的思路做成通用规则写进 agent 规程，**只写原则，不写任何具体查询**：

- 选答案段落里会出现的词，而不是问题的话题词。
- 问某句话、某个教诫时，用原文的实际词形（变格形），不用词根。
- 列举类问题用总称加一两个成员。
- 不用泛用词（buddha、bhikkhu、dhamma、bhagavant、sutta 等）当主检索词。
- 第一轮没找到，换一组词再搜。

### 4.4 没采用的做法

| 做法 | 原因 |
| --- | --- |
| 用新接口替代逐词检索 | 留出集窗口内命中 200–215，远低于现状 296 |
| 等权 RRF | 前 3 段命中 88 → 80 |
| `find` 再加 definition 一路 | 无额外收益 |
| 查询时顺带匹配章节路径 `path` | 失败题的标准段落路径里没有可借力的词；改为下一波在建索引时做（Contextual Retrieval） |

### 4.5 局限

- 两套标准都是近似：调参集用「概念同时出现」代替人工相关性判定；留出集的引用来自现状检索，偏向现状。
- 调参集只有 11 题，「结集」那题标准段落只有 1 段，只能当方向参考。
- **选词规则还没被测到**：留出集用的是 agent 当时选的词。规则的效果要等 agent 换用新规程、
  重新生成关键词后再测。

---

## 五、对问藏（本仓库）的建议

问藏不经过 wikipali-plugins，用的是 `mcp/src/wikipali/api/read.ts` 自己实现的检索工具，
所以以上插件改动不会自动惠及问藏。问藏每天约 70 条真实提问，这一处的收益可能比插件更大。

1. **规划提示词**（`backend/routing.py`）：同步 4.3 的选词规则。这是收益最大的一步
   （调参集：选对词，有命中的题 5 → 8）。
2. **MCP 加一个对应 `find` 的工具**，或在 `question_node` 里每题多跑一次 `/v3/search` fuzzy，
   用「保头部 + RRF」合并。依赖 mint 的后端改动先部署。
3. 改动前后用本文的留出集方法回归：判据「大部分题更好或持平」。

---

## 六、下一波：向量与混合检索

详见 mint `api-v13/documents/search-recall.md` 第四节，摘要：

1. **混合检索**：BM25 + `content.vector`，按名次融合（OpenSearch 升 2.19 用 `score-ranker-processor`，
   或在应用层合并），取代现在分数直接相加的 `hybrid`。
2. **换领域向量模型**：抽样几千段建临时索引，用本文两套评测对比 OpenAI 与 MITRA，再决定是否全量重算。
3. **重排**：融合后前 50–150 段，用 cross-encoder 或便宜 LLM 打分，作用于读全文的前 3 段。
4. **补上下文**：建索引时把 `path`、段落标题拼进检索文本与向量输入；`summary` 放中文摘要。
5. **词根字段**：用 `wbw_templates` 拆好的词根给每段建字段，替代同义词词典展开。

---

## 七、定位阅读：让模型凭三藏知识直接找章节（2026-11-11 第二波）

巴利三藏本身在大模型的训练数据里，模型知道「某个故事在哪部经、某首偈是谁的」。直接让它回答会混进
别的版本与二手资料；改成**只用这份知识定位，答案只取读到的原文**。

### 7.1 新增的能力

| 位置 | 内容 |
| --- | --- |
| mint `GET /v3/tipitaka-chapters` | 取代 `v2/search-title-index`（那条只回标题文字、不带坐标、`LIKE` 硬匹配）。按名字找章节：不分大小写与变音符号、去序号与丛书缩写、拼错一两个字母也能找到（编辑距离），公开译本的中文章节名也能搜；或按书列出全部标题。每条带坐标、根本/义注/复注、段数与字符数、路径、中文译名 |
| 插件 `locate <章节名>` | 按名字找坐标 |
| 插件 `toc <书号>` | 改走上面的端点，每个标题带中文译名与字符数，可直接当选择题清单 |
| 插件 `chapter --fetch` | 默认改走 v3 `tipitaka-reading`（直接读库、翻页取全，可给多个 `--channel`）；原来的 OpenSearch 预建 HTML 留作 `--via tipitaka-content`（正文夹版本页码）。v2 `chapter-content` 是一次约 3000 字符的懒加载，长章会被截断，只留给写入侧 |

### 7.2 两条路

- **locate**：模型说出 1–3 个章节名（巴利名，可指定义注）→ `locate` 取最像的一个。
- **choose（两次选择题）**：模型从全部 281 部书里选 1–2 部 → 看这部书的全部标题 → 选 1–3 章。

两条路之后一样：章节超过 8000 字符就给模型看它的小节再选，最多 3 轮。提示词只写原则，不出现任何经名。
模型用问藏自己的 DeepSeek。

### 7.3 评测与结果

段落级标准（回答引用过的坐标）对定位不公平：定位读到的常是**正确但从未被引用过**的章节。
例：「舍利弗原名」两条路读到的三个章节里 `upatissa` 各出现 6–10 次，却一个标准段落都不算命中；
「阿难做侍者多少年」读到的长老偈原文是 `Paṇṇavīsativassāni … upaṭṭhahiṃ`，而调参集的标准用的拼法是
`pañcavīsati`。所以加了一把**同一判官**的尺子：同一个模型看问题和各路实际读到的原文，判断能否据此作答，
并给出证据句 id；证据 id 必须真在给它的原文里，否则算不能作答。

**留出集 148 题（判官）**

| 路线 | 可作答 | 读的字符（中位） |
| --- | --- | --- |
| find 前 3 段（问藏快速模式现状） | 40 | 3.2k |
| find 前 10 段（与 locate 读量相当） | 49 | 10.7k |
| locate | 54 | 13.9k |
| choose | 59 | 32.4k |
| find 前 3 段 + locate | 74 | — |
| find 前 3 段 + 两条路 | **90** | — |

按「前一步没答案才走下一步」模拟（假设 agent 能判断读到的有没有答案）：

| 顺序 | 可作答 | 读的字符 中位 / 平均 |
| --- | --- | --- |
| find | 40 | 3.2k / 3.4k |
| find → locate | 74 | 9.9k / 18.1k |
| find → locate → choose | **90** | 24.7k / 34.8k |

- 两条路与 find **互补**：find 强在术语、概念辨析（如「缘法和缘生法」「呵责的巴利词」）；定位强在经文、
  故事、偈颂、律的规定、某句话的出处（如「应做慈爱经的内容」「律藏大品里怎么说初转法轮」「这句巴利出处在哪」）。
  locate 单独用有 20 题不如 find，所以是补充，不替代。
- 读量相当时（find 读 10 段 ≈ 10.7k 字）find 49 题，`find 前 3 段 + locate` 74 题——多出来的不是靠多读，
  是读对了地方。
- locate 有 15 题没定位到任何章节（模型给的名字找不到，或拼得太远被 0.7 分以下过滤），这些题由 choose 兜住。

**调参集 11 题（判官）**：find 前 3 段 6 题（这里 find 用的是选对的词），locate 10 题，choose 6 题，
find + locate 11 题。

段落级标准（下限）：留出集 locate 有命中 22 题、choose 32 题，find 前 3 段 67 题；
`find 前 3 段 + 两条路` 84 题。

### 7.4 落地

- 插件 research skill 加「2c. 定位阅读」：find 前几段没答案时依次 `locate` → `toc` 缩到小节 → `chapter` 看体量再读，
  说不出章节名时 `books` 选书 → `toc` 选章；知识只用来定位、以原文为准、细节多在义注。
- 问藏：规划阶段除了关键词再让模型给 1–3 个章节名；MCP 加 `/v3/tipitaka-chapters` 与 v3 `tipitaka-reading`
  两个工具；问题节点在 find 前 3 段没有答案时走定位阅读（顺序同上）。**本仓库尚未改**。

### 7.5 局限

- 判官与扮演 agent 的是同一个模型，可能偏向自己选的章节；证据句必须在原文里，能挡住凭记忆放水，挡不住
  「证据相关但不充分」的宽判。
- 「前一步没答案才走下一步」假设 agent 能可靠判断有没有答案，实际会有误判。
- 读量更大：find → locate → choose 平均 3.5 万字，大约是现状的 10 倍；需要的话可以降低小节阈值（8000）或只读最有把握的一节。
- 模型说出的章节名有时与 CST 标题不同（如 MN 10 在 CST 里叫 Mahāsatipaṭṭhānasuttaṃ），容错和「包含」匹配
  兜住了一部分。

脚本：`eval/recall/eval_navigate.py`（两条路，`--tuning` 跑调参集）、`eval/recall/eval_judge.py`（判官，
`FIND_TOP` 设 find 读几段）。模型回复缓存在 `data/raw/recall/llm_cache.json`，重跑不花钱。

## 八、复现

脚本在 `eval/recall/`（提交）；输入与结果放 `data/raw/recall/`（含用户问题，按本目录约定不提交）。
只用 Python 标准库，只调本地 API；改地址用环境变量 `WIKIPALI_API`。以下命令都在 `agent-tuning/` 下运行。

| 文件 | 用途 |
| --- | --- |
| `build_qa_items.py` | 从 `data/raw/mail/*/body.txt` 抽问答条目 → `data/raw/recall/qa_items.json` |
| `compare.py` | 3.2 单个词召回，新老接口对比 |
| `eval_questions.py` | 3.3 调参集（问题与标准概念写在文件开头的 `QUESTIONS`、`GOOD_KEYWORDS`） |
| `run_both.sh` | 调参集两组（agent 原词 / 选对的词）一起跑 |
| `eval_holdout.py` | 3.4 留出集，逐题对比各方法 |
| `holdout_dump.py` | 留出集各路检索结果落盘（逐词那一路缓存进 `base_cache.json`，重跑时复用） |
| `fusion_offline.py` | 4.2 用落盘结果离线比较融合方式，不发请求 |
| `eval_navigate.py` | 第七节：定位阅读两条路（模型扮 agent，读 `backend/.env` 的 DeepSeek 凭据） |
| `eval_judge.py` | 第七节：同一判官判断各路读到的原文能否作答 |

```bash
# 0. 抽问答条目（邮件有更新就重跑）
python3 -I eval/recall/build_qa_items.py

# 1. 单个词召回：新老接口对比
python3 -I eval/recall/compare.py data/raw/recall/lemma.json nīvaraṇa vitakka bojjhaṅga

# 2. 调参集（标签随意，区分每次改动）
eval/recall/run_both.sh final

# 3. 留出集：落盘各路结果，再离线比较融合方式
python3 -I eval/recall/holdout_dump.py data/raw/recall/qa_items.json \
    data/raw/recall/base_cache.json data/raw/recall/dump_new.json 150
python3 -I eval/recall/fusion_offline.py data/raw/recall/dump_new.json
```

`data/raw/recall/` 里已保留本次的结果，可以直接对照：

| 文件 | 内容 |
| --- | --- |
| `dump_exp0.json` / `dump_exp1.json` / `dump_exp4.json` | 留出集，罕见度指数 0（不加权）/ 1 / 4（采用） |
| `eval2.json` / `eval_good.json` | 调参集第一轮（后端加权前），agent 原词 / 选对的词 |
| `eval_final_agent.json` / `eval_final_good.json` | 调参集，采用的配置 |

`fusion_offline.py data/raw/recall/dump_exp4.json` 复现 4.2 的表：「保头部+仅fuzzy」窗内 325、前 3 88。

**改了什么就重跑什么**：后端计分改动跑 2、3；插件 `find` 或融合方式改动跑 3 的离线部分即可；
判据仍是留出集「大部分题更好或持平」。注意留出集 `dump` 里 fuzzy / definition 两路的结果
取决于当时的后端代码，后端改了要重新落盘。
