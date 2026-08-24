/**
 * WikiPali 纯函数单测：坐标解析 / 文献层次 / HTML 清洗 / 站点别名 / 凭据辅助。
 * 不涉及网络。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCoord, parseCoords, fmtPath, textLayer } from "../src/wikipali/coords.ts";
import { stripMarkup, looksMachine } from "../src/wikipali/markup.ts";
import { expandSiteAlias, normalizeApiUrl, siteLabel, SITES } from "../src/wikipali/sites.ts";
import { mask, tokenExpiry } from "../src/wikipali/creds.ts";
import { ApiError, explainApiError } from "../src/wikipali/errors.ts";

describe("coords", () => {
  it("解析 book:paragraph", () => {
    assert.deepEqual(parseCoord("216:35"), [216, 35]);
    assert.deepEqual(parseCoord("216-35"), [216, 35]);
    assert.deepEqual(parseCoord("216_35"), [216, 35]);
  });

  it("拒绝非法坐标", () => {
    assert.throws(() => parseCoord("abc"), /坐标格式不对/);
  });

  it("按 book 分组并去重保序", () => {
    assert.deepEqual(parseCoords(["216:35,216:36", "216:35", "141:63"]), { 216: [35, 36], 141: [63] });
  });

  it("判断文献层次", () => {
    assert.equal(textLayer([{ name: "mūla" }]), "mūla");
    assert.equal(textLayer([{ name: "mūla" }, { name: "aṭṭhakathā" }]), "aṭṭhakathā");
    assert.equal(textLayer([{ name: "ṭīkā" }]), "ṭīkā");
    assert.equal(textLayer([]), "");
  });

  it("压缩章节路径", () => {
    const path = [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }, { title: "E" }];
    assert.equal(fmtPath(path), "A › … › D › E");
    assert.equal(fmtPath([{ title: "A" }, { title: "B" }]), "A › B");
  });
});

describe("markup", () => {
  it("保留命中高亮与黑体，去其余标签", () => {
    const html = "abc <span class='hl'>命中</span> <span class=\"bld\">黑体</span> <b>x</b>";
    assert.equal(stripMarkup(html), "abc 【命中】 **黑体** x");
  });

  it("版本页码保留在原位", () => {
    const html = "Evaṃ <code>M1.1</code> <code>V1.1</code>";
    assert.equal(stripMarkup(html), "Evaṃ [M1.1] [V1.1]");
  });

  it("清掉 MdTpl 模板标记", () => {
    assert.equal(stripMarkup("a <MdTpl props='x'></MdTpl> b"), "a b");
  });

  it("机器译名提示", () => {
    assert.equal(looksMachine("deepseek"), true);
    assert.equal(looksMachine("庄春江"), false);
  });
});

describe("sites", () => {
  it("别名展开", () => {
    assert.equal(expandSiteAlias("next"), "https://next.wikipali.org/api");
    assert.equal(expandSiteAlias("2"), SITES[1]!.url);
    assert.equal(expandSiteAlias("https://www.wikipali.org/api"), "https://www.wikipali.org/api");
  });

  it("拒绝 http 的非本地地址", () => {
    assert.throws(() => normalizeApiUrl("http://evil.example/api"), /必须 https/);
    assert.equal(normalizeApiUrl("http://127.0.0.1:8000/api/"), "http://127.0.0.1:8000/api");
  });

  it("站点标签", () => {
    assert.equal(siteLabel("https://next.wikipali.org/api"), "最新版 · .org");
    assert.equal(siteLabel("https://x.example/api"), "自定义地址");
  });
});

describe("creds / errors", () => {
  it("打码 token", () => {
    assert.equal(mask(""), "(无)");
    assert.equal(mask("abcd"), "abcd…"); // ≤16 字符：前 4 位
    assert.equal(mask("abcdefgh1234567890"), "abcdefgh…7890"); // >16：前 8 + 后 4
  });

  it("解析 JWT 过期时间", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: 1700000000 })).toString("base64url");
    assert.equal(tokenExpiry(`${header}.${payload}.sig`), 1700000000);
  });

  it("错误状态码翻译", () => {
    assert.match(explainApiError(new ApiError(401, "x"), "写句子").message, /401 凭据失效/);
    assert.match(explainApiError(new ApiError(403, "x"), "写句子").message, /403 无权限/);
    assert.match(explainApiError(new ApiError(404, "x"), "查").message, /404/);
    assert.match(explainApiError(new ApiError(409, "x"), "建").message, /409 同名记录已存在/);
  });
});
