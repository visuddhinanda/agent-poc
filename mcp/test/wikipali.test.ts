/**
 * WikiPali 纯函数单测：坐标解析 / 文献层次 / HTML 清洗 / 站点别名 / 凭据辅助。
 * 不涉及网络。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCoord, parseCoords, fmtCite, fmtPath, textLayer, v3Layer } from "../src/wikipali/coords.ts";
import { stripMarkup, looksMachine, rowText } from "../src/wikipali/markup.ts";
import { anchor, checkGlossary } from "../src/wikipali/anchors.ts";
import { csParaRanges, parsePageMarker, parsePcds } from "../src/wikipali/api/read.ts";
import { modelUidOf } from "../src/wikipali/api/discuss.ts";
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

  it("v3 tags 是字符串数组", () => {
    assert.equal(v3Layer(["aṭṭhakathā"]), "aṭṭhakathā");
    assert.equal(v3Layer(["mūlaṭīkā"]), "ṭīkā");
    assert.equal(v3Layer(["pāḷi"]), "mūla");
    assert.equal(v3Layer([]), "");
  });

  it("出处由服务端 ref / link 合成，不自己拼", () => {
    const refs = [
      { type: "WP", title: "dī.ni.ṭī.2.", page: 1411 },
      { type: "My", title: "dī-ṭī 2", page: 340 },
      { type: "PTS", title: "DnT II", page: 429 },
    ];
    assert.equal(
      fmtCite(186, 1411, refs, "https://x/read#1411"),
      "[dī.ni.ṭī.2. 186-1411; 缅 dī-ṭī 2 p.340; PTS DnT II p.429](https://x/read#1411)",
    );
    assert.equal(fmtCite(186, 1411, [], undefined), "186-1411");
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
    assert.equal(stripMarkup(html), "abc 【命中】 **黑体** **x**");
  });

  it("<strong> 黑体不丢", () => {
    assert.equal(stripMarkup("Abhūtapubbaṃ bhūtanti <strong>abbhutaṃ</strong> ."), "Abhūtapubbaṃ bhūtanti **abbhutaṃ** .");
  });

  it("按 content_type 决定是否转换正文", () => {
    assert.equal(rowText({ content: "译文 **原样**  <b>x</b>", content_type: "markdown" }), "译文 **原样** <b>x</b>");
    assert.equal(rowText({ content: "<strong>a</strong> b", content_type: "html" }), "**a** b");
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

describe("anchors", () => {
  it("按码点算位置（与服务端 mb_strlen 同口径）", () => {
    // 𠀀 是 BMP 之外的字：JS 下标算 2，码点算 1
    const text = "𠀀如是我闻，一时佛在";
    const [s, e, pre, suf] = anchor(text, { quote_exact: "我闻" });
    assert.deepEqual([s, e, pre, suf], [3, 5, "𠀀如是", "，一时佛在"]);
  });

  it("不给摘录就是整句挂", () => {
    assert.deepEqual(anchor("abc", {}), [null, null, null, null]);
  });

  it("摘录不在句中、多次出现无法消歧时报错", () => {
    assert.throws(() => anchor("abc", { quote_exact: "x" }), /不在该句原文里/);
    assert.throws(() => anchor("ab ab", { quote_exact: "ab" }), /出现多次/);
    assert.deepEqual(anchor("ab ab", { quote_exact: "ab", quote_prefix: "ab " }).slice(0, 2), [3, 5]);
  });

  it("外挂术语不能套在已有标记上", () => {
    assert.throws(() => checkGlossary("比丘**住**处", 1, 5, "bhikkhu"), /重叠/);
    assert.throws(() => checkGlossary("比丘[[x]]住", 0, 4, "bhikkhu"), /\[ \] \{ \}/);
    assert.throws(() => checkGlossary("比丘", 0, 2, "a#b"), /词头/);
    checkGlossary("比丘住", 0, 2, "bhikkhu");
  });
});

describe("page / related 辅助", () => {
  it("解析页码", () => {
    assert.deepEqual(parsePageMarker("M2.241"), ["M", 2, 241, undefined]);
    assert.deepEqual(parsePageMarker("2.249-250"), ["M", 2, 249, 250]);
    assert.deepEqual(parsePageMarker("P47"), ["P", 0, 47, undefined]);
    assert.throws(() => parsePageMarker("x"), /看不懂页码/);
    assert.deepEqual(parsePcds("70, 71"), [70, 71]);
    assert.throws(() => parsePcds(""), /pcd/);
  });

  it("段号压缩成区间", () => {
    assert.equal(csParaRanges([1, 2, 3, 5, 7, 8, 9]), "1-3,5,7-9");
    assert.equal(csParaRanges([4]), "4");
  });

  it("从 modelToken 取模型 uid", () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    assert.equal(modelUidOf(`${enc({ alg: "HS512" })}.${enc({ uid: "m-1", typ: "ai-model" })}.sig`), "m-1");
    assert.throws(() => modelUidOf(`${enc({ alg: "HS512" })}.${enc({ uid: "u-1", id: 3 })}.sig`), /不是模型身份/);
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
    assert.equal(expandSiteAlias("staging.cc"), "https://staging.wikipali.cc/api");
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
