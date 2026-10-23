# MCP 工具清单与语义

> 设计文档。工具由 `mcp/` 提供，全部以 `wikipali_` 前缀注册，共 48 个。
> 各工具需要哪些凭据头见 [凭据模型](./credentials.md)。
> 对齐 [wikipali-plugins](https://github.com/iapt-platform/wikipali-plugins) 0.21.0。

## 1. 工具清单

**读端（22，无需凭据）**

`forms` `word` `count` `terms` `books` `toc` `paras` `chapter` `chapter_fetch`
`get` `ref` `versions` `search` `dist` `related` `related_cs` `related_books` `related_paras`
`page` `articles` `article` `anthology`

- `search` 每条带 `cite`（出处 Markdown 链接）、`ref`、`link`——**全部取自服务端**的 ref / link，
  不再本地编书名缩写、不再自己拼前端链接。`get`（`ref=true`）与 `ref` 给任意坐标同样的出处。
- `related_cs` / `related_books` / `related_paras`：v3 CST 锚点（书名 + 段号）。
- `page`：印本页码 → 坐标（`nav-page`），只换算、不认书。

**站点 / 身份（2）**：`endpoint`（只读）、`whoami`

**凭据与 token（4）**：`ensure_model`（返回 modelToken）、`revoke`、`channels`、`grant`

**句子 / 术语（7）**：`my_terms`，以及 `write` / `term_add` / `term_edit` 各拆
`_preview`（dry-run）与 `_commit`（真写）。

**批注 v3（10）**：`discuss`（一句）、`discuss_range`（章 / 段落区间 / 书 / 整个 channel），
以及 `discuss_add` / `discuss_reply` / `discuss_edit` / `discuss_delete` 各拆 `_preview` 与 `_commit`。
八类 `type`：`note` `commentary` `discussion` `qa` `help` `issue` `glossary` `assessment`。

**注释书对应（3）**：`note_context`（某 CST 锚点下各层巴利 + 译文）、`note_push_preview` / `note_push_commit`
（写 `type=commentary`）。

## 2. 源码结构

```
src/
  index.ts                    # 入口：启动 Streamable HTTP 服务
  server.ts                   # createMcpServer(): 注册全部 wikipali_* 工具
  version.ts                  # MCP_VERSION：serverInfo 与 User-Agent 共用
  login.ts                    # 登录脚本：取 userToken 写入客户端侧 ~/.wikipali/credentials.json
  transports/streamable-http.ts
  wikipali/
    sites.ts / errors.ts / client.ts / creds.ts / coords.ts / markup.ts
    anchors.ts                # 批注锚点：按摘录在句子原文里算 pos（码点口径，同服务端 mb_strlen）
    api/read.ts               # 读端（无凭据）
    api/write.ts              # 句子 / 术语（modelToken 透传 + userToken 签 access token）
    api/discuss.ts            # 批注 v3（modelToken + userToken 瞬时签 agent-grant）
    api/notes.ts              # 注释书对应 note-context / note-push
    tools/{read,site,auth,write,common}.ts
test/
  server.test.ts / client.test.ts / wikipali.test.ts
deploy/
  wikipali-mcp.service        # systemd 服务单元
  clients/                    # Claude Code / Desktop / LangGraph 连接样例
```

## 3. 关键语义（从 Python 插件 1:1 保留）

这些是移植自 [wikipali-plugins](https://github.com/iapt-platform/wikipali-plugins) 的既有约定，
改动会破坏调用方预期：

- **空结果 ≠ 故障**：`access-token count:0` 表示无编辑权；`chapter-content` 返回空占位；
  `related` 查无关联时返回 500。
- **`count` 小于提交条数** = 有句子被静默跳过，**必须报差集**。
- 检索前**必须先展开词形**（`forms`）。
- 保留黑体（`<span class="bld">` 与 `<strong>` 都转 `**…**`）、页码、根本·义注·复注层次、机器译标注。
- 正文按记录的 `content_type` 决定是否转换：`markdown` 原样、`html` 才清洗。
- 出处与链接只用服务端返回值（`ref` / `link`），取不到就如实说，不推算页码。
- 批注锚点只收 `quote_exact`，位置与前后缀由程序按句子原文算；摘录不在句中或无法消歧时报错。
- `assessment` 一句只留一条，再评估覆盖旧的。
- **401 不自动重试**。
- `book` 参数**必须是整数**。
