/**
 * MCP 端到端测试：Client <-> McpServer（InMemoryTransport）。
 *
 * 不触网：只验证工具注册齐全、以及工具层对非法入参的错误透传（在发任何网络请求前失败）。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createMcpServer } from "../src/server.ts";

const EXPECTED_TOOLS = [
  // 读端（17）
  "wikipali_forms", "wikipali_word", "wikipali_count", "wikipali_terms", "wikipali_books",
  "wikipali_toc", "wikipali_paras", "wikipali_chapter", "wikipali_chapter_fetch", "wikipali_get",
  "wikipali_versions", "wikipali_search", "wikipali_dist", "wikipali_related",
  "wikipali_articles", "wikipali_article", "wikipali_anthology",
  // 站点/凭据（2）
  "wikipali_endpoint", "wikipali_whoami",
  // 凭据与 token（4）
  "wikipali_ensure_model", "wikipali_revoke", "wikipali_channels", "wikipali_grant",
  // 写端（12）
  "wikipali_my_terms",
  "wikipali_write_preview", "wikipali_write_commit",
  "wikipali_term_add_preview", "wikipali_term_add_commit",
  "wikipali_term_edit_preview", "wikipali_term_edit_commit",
  "wikipali_discuss",
  "wikipali_discuss_add_preview", "wikipali_discuss_add_commit",
  "wikipali_discuss_reply_preview", "wikipali_discuss_reply_commit",
];

describe("WikiPali MCP server", () => {
  let client: Client;
  let server: McpServer;

  before(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    server = createMcpServer();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    await server.close();
  });

  it("注册了全部 wikipali 工具", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  });

  it("wikipali_get 对非法坐标在触网前报错", async () => {
    const result = await client.callTool({ name: "wikipali_get", arguments: { coords: ["abc"] } });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text as string, /坐标格式不对/);
  });

  it("wikipali_search 对空词形在触网前报错", async () => {
    const result = await client.callTool({ name: "wikipali_search", arguments: { forms: [] } });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text as string, /没有给出词形/);
  });

  it("wikipali_chapter 对非法坐标在触网前报错", async () => {
    const result = await client.callTool({ name: "wikipali_chapter", arguments: { coord: "nope" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text as string, /坐标格式不对/);
  });

  it("写类工具缺 Authorization 凭据时在触网前报错（无状态）", async () => {
    const result = await client.callTool({ name: "wikipali_channels", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text as string, /缺少凭据|Authorization/);
  });

  it("读类工具无需凭据，仍可正常进入业务校验", async () => {
    // 读工具不要求 Authorization 头；这里用非法坐标触发纯业务校验错误（不触网）
    const result = await client.callTool({ name: "wikipali_get", arguments: { coords: ["x:y"] } });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text as string, /坐标格式不对/);
  });
});
