---
name: agent-tuning
description: 收集线上真实问答数据（目前来源：Gmail 邮箱里每天一封的网站访问报告邮件；以后加数据库），下载、查看、聚合成去标识化数据集，用来优化 backend 的 LangChain / LangGraph 研究路径。用户说「下载报告邮件」「拉一下最新邮件」「补下载历史邮件」「看看最近用户都问了什么」「聚合数据」「用真实数据调优 agent」时用。原始数据含用户数据，只放 agent-tuning/data/raw/，绝不提交 git。
---

# agent-tuning：真实问答数据的收集与聚合

工作目录 `agent-tuning/`（命令都在这里运行），说明见 `agent-tuning/README.md`。

| 来源 | 脚本 | 原始数据 |
|---|---|---|
| Gmail 报告邮件 | `sources/mail/fetch_mail.py` | `data/raw/mail/` |
| 数据库 | 待做（`sources/db/`） | `data/raw/db/` |

聚合结果放 `data/aggregated/`，要提交 git。`data/raw/`、`.env` 已 gitignore。

## 隐私规则

- 文档、代码、注释、提交信息、聚合数据里**一律不写**真实邮箱地址、用户名、密码等可识别个人信息；示例统一用 `you@gmail.com`、`sender@example.com` 这类占位符。真实值只放在已 gitignore 的 `.env`。

## 0. 前提检查

- `agent-tuning/.env` 存在，且 `GMAIL_APP_PASSWORD`、`MAIL_QUERY` 非空。
  缺凭据 → 让用户按 README 自己填，**不要让用户把密码贴进对话**，也不要读出 `.env` 里的密码。
  `MAIL_QUERY` 为空 → 先跑 `python3 sources/mail/fetch_mail.py --list`，根据发件人/标题建议一条查询，经用户确认后再写进 `.env`。

## 1. 下载邮件

```bash
cd agent-tuning
python3 sources/mail/fetch_mail.py --dry-run   # 先看会动哪些邮件
python3 sources/mail/fetch_mail.py             # 下载并归档
```

- 「只要某天之后的」→ `--since YYYY-MM-DD`（按标题里的报告日期，别用 Gmail 的 `after:`，有时区误差）；「下载但别归档」→ `--no-archive`；「补历史 / 重新下载全部」→ `--all-mail`。
- 第一次用新的 `MAIL_QUERY` 时一定先 `--dry-run`，把匹配到的标题给用户看，确认没有误伤别的邮件再正式跑（归档会改动用户邮箱）。
- 跑完报告：新保存几封、各自的日期目录、是否归档。

## 2. 查看

- 邮件是「问藏简报」，每封附件 `attachments/wenzang-*.json`（与 body.txt 相同），字段见 README「邮件内容格式」：`items[]` 每条含 `time / question / pali_terms / hits / answer`，另有当天 `feedback`、`quota`。

- 索引 `data/raw/mail/index.jsonl`；每封 `data/raw/mail/<日期>_<id>/` 下有 `meta.json`、`body.txt`/`body.html`、`attachments/`。
- 回答时可以概括提问内容，但**不要在对话里大段转贴原始用户数据**，不要输出邮箱、IP、用户 id 等身份信息。

## 3. 新数据来源 / 聚合（尚未实现）

用户要求接数据库或聚合时：

1. 先读一两份原始数据，说明格式（字段、条目数）。
2. 提出方案：新来源放 `sources/<来源>/`，原始数据落 `data/raw/<来源>/`；聚合输出到 `data/aggregated/`
   （建议 jsonl，一行一条问答：日期、来源、问题、回答、可用的路由/耗时/评价等字段），**去掉一切身份信息**。
3. **按 CLAUDE.md，得到用户确认后**再写代码，并同步更新 README 与本 skill。
4. 提交前检查 `data/aggregated/` 无身份信息，`data/raw/` 不在 `git status` 待提交里。

## 4. 用于优化 backend

拿聚合数据做问题分类、找答得差的问题、构造回归评测集时，配合 `improve-answers` skill 和
`backend/scripts/eval_routes.py`。改 `backend/` 代码前先给方案、得到用户确认。
