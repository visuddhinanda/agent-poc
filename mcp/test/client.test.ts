/**
 * client + 读端 API 的 mock-fetch 测试：验证 {ok,data,message} 信封解析与错误/回退路径。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { WikiClient } from "../src/wikipali/client.ts";
import { fetchForms, search } from "../src/wikipali/api/read.ts";
import { ApiError, WpError } from "../src/wikipali/errors.ts";

const origFetch = globalThis.fetch;

function fakeResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

afterEach(() => {
  globalThis.fetch = origFetch;
});

function client(): WikiClient {
  return new WikiClient("https://www.wikipali.org/api");
}

describe("client + read api（mock fetch）", () => {
  it("解析信封并过滤掉 case 为空的候选", async () => {
    globalThis.fetch = (async () => fakeResponse({
      ok: true,
      data: {
        rows: [
          { word: "parivāsa", case: [{ word: "parivāsaṃ", count: 10, bold: 2 }] },
          { word: "查无此词", case: [] },
        ],
      },
      message: "",
    })) as unknown as typeof fetch;

    const rows = await fetchForms(client(), "parivāsa");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.word, "parivāsa");
  });

  it("非 ok 响应抛 ApiError（含服务端 message）", async () => {
    globalThis.fetch = (async () => fakeResponse({ ok: false, data: null, message: "boom" }, false, 400)) as unknown as typeof fetch;
    await assert.rejects(
      () => client().call("GET", "v2/x"),
      (err) => err instanceof ApiError && err.status === 400 && /boom/.test(err.message),
    );
  });

  it("v3 无 ok 字段，按状态码判成败；错误取 Problem 的 detail", async () => {
    globalThis.fetch = (async () => fakeResponse({ data: [{ book_name: "dn1" }], meta: { total: 1 } })) as unknown as typeof fetch;
    assert.deepEqual(await client().call("GET", "v3/x", { v3: true }), [{ book_name: "dn1" }]);
    assert.deepEqual(await client().call("GET", "v3/x", { v3: true, envelope: true }), { data: [{ book_name: "dn1" }], meta: { total: 1 } });

    globalThis.fetch = (async () => fakeResponse({ title: "Unprocessable", detail: "score 必填", status: 422 }, false, 422)) as unknown as typeof fetch;
    await assert.rejects(
      () => client().call("POST", "v3/x", { v3: true, body: {} }),
      (err) => err instanceof ApiError && err.status === 422 && err.message === "score 必填",
    );
  });

  it("请求带 Accept-Language 与带版本的 User-Agent，以及额外请求头", async () => {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return fakeResponse({ data: {} });
    }) as unknown as typeof fetch;
    await client().call("GET", "v3/x", { v3: true, headers: { "X-Agent-Grant": "g" } });
    assert.equal(seen["Accept-Language"], "zh-Hans");
    assert.match(seen["User-Agent"]!, /^wikipali-mcp\/\d+\.\d+\.\d+$/);
    assert.equal(seen["X-Agent-Grant"], "g");
  });

  it("search 的出处与链接原样取服务端 ref / link", async () => {
    globalThis.fetch = (async () => fakeResponse({
      ok: true,
      data: {
        count: 1,
        rows: [{
          book: 93, paragraph: 6, rank: 3, paliTitle: "Sīlakkhandhavagga",
          path: [{ book: 93, paragraph: 5, title: "Brahmajāla", level: 2 }],
          highlight: "x <span class='hl'>evaṃ</span>",
          link: "https://server/link/93-6",
          ref: [{ type: "WP", title: "dī.ni.1.", page: 6 }, { type: "PTS", title: "D I", page: 1 }],
        }],
      },
    })) as unknown as typeof fetch;
    const res = await search(client(), { forms: ["evaṃ"], limit: 10, offset: 0, width: 200 });
    const row = res.rows[0];
    assert.equal(row.link, "https://server/link/93-6");
    assert.equal(row.cite, "[dī.ni.1. 93-6; PTS D I p.1](https://server/link/93-6)");
    assert.deepEqual(row.ref, [{ type: "WP", title: "dī.ni.1.", page: 6 }, { type: "PTS", title: "D I", page: 1 }]);
  });

  it("所有站点网络不可达时抛 WpError", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => client().call("GET", "v2/x"),
      (err) => err instanceof WpError && /所有可用站点都连不上/.test(err.message),
    );
  });
});
