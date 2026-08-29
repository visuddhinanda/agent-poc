# MCP 工具清单与语义

> 设计文档。工具由 `mcp/` 提供，全部以 `wikipali_` 前缀注册，共 35 个。
> 各工具需要哪些凭据头见 [凭据模型](./credentials.md)。

## 1. 工具清单

**读端（17，无需凭据）**

`forms` `word` `count` `terms` `books` `toc` `paras` `chapter` `chapter_fetch`
`get` `versions` `search` `dist` `related` `articles` `article` `anthology`

**站点 / 身份（2）**：`endpoint`（只读）、`whoami`

**凭据与 token（4）**：`ensure_model`（返回 modelToken）、`revoke`、`channels`、`grant`

**写端（12）**：`my_terms`，以及 `write` / `term_add` / `term_edit` / `discuss_add` /
`discuss_reply` 各拆 `_preview`（dry-run）与 `_commit`（真写）。

## 2. 源码结构

```
src/
  index.ts                    # 入口：启动 Streamable HTTP 服务
  server.ts                   # createMcpServer(): 注册全部 wikipali_* 工具
  login.ts                    # 登录脚本：取 userToken 写入客户端侧 ~/.wikipali/credentials.json
  transports/streamable-http.ts
  wikipali/
    sites.ts / errors.ts / client.ts / creds.ts / coords.ts / markup.ts
    api/read.ts               # 读端 17 个端点（无凭据）
    api/write.ts              # 写端端点（modelToken 透传 + userToken 签 access token）
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
- 保留黑体、页码、本文·义注·复注层次、机器译标注。
- **401 不自动重试**。
- `book` 参数**必须是整数**。
