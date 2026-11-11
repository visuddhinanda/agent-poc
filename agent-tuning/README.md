# agent-tuning — 用真实问答数据调优 Agent

目的：收集线上用户的佛法提问和 LLM 回答，聚合成数据集，用来优化 `backend/` 的 LangChain / LangGraph
研究路径（路由、提示词、检索），并做改动前后的回归评测。

已有的调优记录：[巴利文检索召回优化（2026-11）](docs/retrieval-recall-2026-11.md)（评测脚本在 `eval/recall/`）。

数据来源可以有多个，每个来源一个子目录，原始数据统一落到 `data/raw/<来源>/`：

| 来源 | 目录 | 状态 |
|---|---|---|
| Gmail 每日访问报告邮件 | `sources/mail/` | 已实现下载 |
| 数据库 | `sources/db/` | 待做 |

```
agent-tuning/
  .env.example         配置模板（所有来源共用）
  .env                 凭据            ← 不提交
  sources/
    mail/fetch_mail.py 邮件下载 + 归档
    db/                以后
  data/
    raw/               原始数据，含用户数据 ← 不提交
      mail/
    aggregated/        聚合后、去标识化的数据集 ← 提交
```

以下命令都在 `agent-tuning/` 下运行。

---

## 来源一：Gmail 每日报告邮件

网站每天往你的 Gmail 邮箱发一封访问报告。`sources/mail/fetch_mail.py` 把匹配的邮件下载到
`data/raw/mail/`，然后在 Gmail 里归档。只用 Python 标准库，不需要装依赖。

### 1. 准备凭据（只做一次）

脚本用 IMAP + Gmail「应用专用密码」登录，不需要 Google Cloud 项目。

1. Google 账号开启两步验证：<https://myaccount.google.com/security>
2. 生成应用专用密码：<https://myaccount.google.com/apppasswords>，名称随便填，得到 16 位密码。
3. Gmail 网页 → 设置 → 查看所有设置 → 「转发和 POP/IMAP」→ 确认 IMAP 已启用。
   （不要在 IMAP 里隐藏「所有邮件」，`--all-mail` 要用。）
4. 填配置：

   ```bash
   cp .env.example .env
   # 编辑 .env，填 GMAIL_APP_PASSWORD
   ```

### 2. 确定筛选条件

```bash
python3 sources/mail/fetch_mail.py --list
```

看清报告邮件的发件人和标题后，在 `.env` 里写 `MAIL_QUERY`（语法同 Gmail 搜索框）：

```
MAIL_QUERY=from:sender@example.com subject:问藏简报
```

`MAIL_QUERY` 为空时脚本拒绝运行——否则会把整个收件箱下载并归档。先用 `--dry-run` 确认只匹配到报告邮件。

### 3. 日常使用

```bash
python3 sources/mail/fetch_mail.py --dry-run   # 看看会下载哪些
python3 sources/mail/fetch_mail.py             # 下载收件箱里匹配的邮件，然后归档
```

| 参数 | 作用 |
|---|---|
| `--list [--limit N]` | 列出收件箱最近 N 封邮件（默认 30） |
| `--dry-run` | 只显示，不下载、不归档 |
| `--no-archive` | 下载但留在收件箱 |
| `--all-mail` | 也搜已归档的邮件，补下载历史（不改动标签） |
| `--query '...'` | 临时覆盖 `MAIL_QUERY` |
| `--since YYYY-MM-DD` | 只处理报告日期（标题里的日期）不早于该日的邮件，更早的不下载、不归档。Gmail 的 `after:` 受时区影响不准，按日期筛选请用这个 |

- **归档** = 把邮件从收件箱移到「所有邮件」，不会删除。全部保存成功后才归档，归档后会回查确认已离开收件箱。
- 按 `Message-ID` 去重（`data/raw/mail/index.jsonl`），重复运行不会重复下载；上次没归档成功的会补归档。
- 删掉 `data/raw/mail/` 后可用 `--all-mail` 重新下载全部历史。

### 4. 保存结构

```
data/raw/mail/
  index.jsonl                    已下载邮件索引
  2026-10-29_4041a8c6/           <邮件发送日期，本地时区>_<短 id>
    message.eml                  原始邮件
    meta.json                    发件人、标题、日期、Message-ID、附件列表
    body.txt / body.html         正文
    attachments/<文件名>          附件
```

### 5. 邮件内容格式（问藏简报）

发件人见 `.env` 的 `MAIL_QUERY`，标题「问藏简报 YYYY-MM-DD（N 条）」，每天北京时间约 22:30 一封，
始于 2026-08-07。正文和附件 `wenzang-<次日日期>.json` 是同一份 JSON：

```
site, date, total
feedback: {total, up, down, up_rate, down_questions[]}
reading:  {total, pages[]}
quota:    {limit, used, ratio, warning, note}
items[]:  {time, question, pali_terms[], hits, answer}   # answer 为 Markdown
```

条目里没有用户身份字段。

---

## 聚合（待做）

拿到真实数据、看清格式后再写聚合脚本：把各来源的 `data/raw/` 转成 `data/aggregated/` 下统一格式、
**去标识化**（不含邮箱、IP、用户 id 等）的数据集并提交，供问题聚类、找差回答、构造回归评测集用
（配合 `improve-answers` skill 和 `backend/scripts/eval_routes.py`）。

## 用 Claude Code 操作

`.claude/skills/agent-tuning/SKILL.md` 定义了自然语言入口，例如：
「下载最新的报告邮件」「把历史邮件都补下载」「看看最近用户都问了什么」「聚合一下数据」。
