/**
 * client + 读端 API 的 mock-fetch 测试：验证 {ok,data,message} 信封解析与错误/回退路径。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { WikiClient } from "../src/wikipali/client.ts";
import { fetchForms } from "../src/wikipali/api/read.ts";
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
