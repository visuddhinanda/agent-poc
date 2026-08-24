/**
 * WikiPali 登录脚本（无状态版）：一次性取得 userToken，写入**客户端侧**凭据文件
 * `~/.wikipali/credentials.json`（0600，可用 WIKIPALI_CREDS_PATH 覆盖），由客户端读取。
 *
 * server 无状态、不读这个文件；token 由客户端放进 HTTP 请求头 Authorization: Bearer。
 *
 * 密码只经三种途径进入，绝不经过 MCP/LLM：
 *   1. 真实终端的隐藏输入（readline + 静音输出，等价 getpass）；
 *   2. --password-stdin 管道（供自动化，别让密码进 argv/对话）；
 *   3. （无终端时）提示用户另开终端或改用 --password-stdin。
 *
 * 用法：
 *   npm run login                       # 交互式（隐藏密码）
 *   npm run login -- --api next         # 只为本次登录换站点
 *   npm run login -- --username me      # 免输用户名
 *   printf '%s' "$PW" | npm run login -- --username me --password-stdin
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";

import { WikiClient } from "./wikipali/client.ts";
import { fmtTs, isoNow, tokenExpiry } from "./wikipali/creds.ts";
import { DEFAULT_API_URL, expandSiteAlias, normalizeApiUrl, siteLabel } from "./wikipali/sites.ts";
import { ApiError, WpError } from "./wikipali/errors.ts";

export const CREDS_PATH = process.env.WIKIPALI_CREDS_PATH ?? join(homedir(), ".wikipali", "credentials.json");

interface ClientCreds {
  userToken?: string;
  nickname?: string;
  realName?: string;
  uid?: string;
  loggedInAt?: string;
  expiresAt?: number;
  modelToken?: string;
  modelName?: string;
  modelUid?: string;
}

/** 读-改-写客户端侧凭据文件：只更新 userToken 相关字段，保留已有的 modelToken。 */
async function saveUserToken(token: string, current: Record<string, any>): Promise<void> {
  let creds: ClientCreds = {};
  try {
    const raw = await readFile(CREDS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) creds = parsed as ClientCreds;
  } catch {
    // 无文件或解析失败，从头建
  }
  Object.assign(creds, {
    userToken: token,
    nickname: current?.nickName,
    realName: current?.realName,
    uid: current?.id,
    loggedInAt: isoNow(),
    expiresAt: tokenExpiry(token),
  });

  await mkdir(join(CREDS_PATH, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${CREDS_PATH}.tmp`;
  await writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, CREDS_PATH);
  await chmod(CREDS_PATH, 0o600);
}

interface Args {
  api?: string;
  username?: string;
  passwordStdin: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { passwordStdin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--api") {
      const v = argv[++i];
      if (v !== undefined) args.api = v;
    } else if (a === "--username") {
      const v = argv[++i];
      if (v !== undefined) args.username = v;
    } else if (a === "--password-stdin") args.passwordStdin = true;
  }
  return args;
}

function readLine(prompt: string, hidden = false): Promise<string> {
  return new Promise((resolve, reject) => {
    if (hidden) process.stdout.write(prompt);
    const output = hidden ? new Writable({ write(_c, _e, cb) { cb(); } }) : process.stdout;
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    rl.question(hidden ? "" : prompt, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
    rl.on("error", reject);
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const apiUrl = args.api
    ? normalizeApiUrl(expandSiteAlias(args.api))
    : (process.env.WIKIPALI_API_URL?.trim() || DEFAULT_API_URL);
  const client = new WikiClient(apiUrl);

  console.log(`登录站点：${apiUrl}（${siteLabel(apiUrl)}）`);
  const interactive = Boolean(process.stdin.isTTY);

  let username = args.username;
  if (!username) {
    if (interactive) username = (await readLine("用户名或邮箱：")).trim();
    else {
      console.error("错误：--password-stdin 模式必须同时给 --username。");
      return 1;
    }
  }
  if (!username) {
    console.error("错误：用户名为空。");
    return 1;
  }

  let password: string;
  if (args.passwordStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    password = Buffer.concat(chunks).toString("utf-8").replace(/\r?\n$/, "");
  } else if (interactive) {
    password = await readLine("密码（不会被保存）：", true);
  } else {
    console.error(
      "错误：当前既没有交互式终端，也没有 --password-stdin。\n" +
        "  · 请在真实终端里跑：npm run login（密码隐藏输入）；\n" +
        "  · 自动化环境：printf '%s' \"$PW\" | npm run login -- --username <名字> --password-stdin。\n" +
        "无论哪种，都不要把密码写进命令行参数，也不要打进与 AI 的对话里。",
    );
    return 1;
  }
  if (!password) {
    console.error("错误：密码为空。");
    return 1;
  }

  try {
    const token = await client.call("POST", "v2/sign-in", { body: { username, password } });
    if (typeof token !== "string" || !token) {
      console.error("错误：服务端没有返回 token。");
      return 1;
    }
    const current = (await client.call("GET", "v2/auth/current", { token })) as Record<string, any>;
    await saveUserToken(token, current);
    console.log(`\n登录成功：${current?.nickName}（realName=${current?.realName}，用作 studio_name）`);
    console.log(`userToken 已写入 ${CREDS_PATH}（0600），到期 ${fmtTs(tokenExpiry(token))}。`);
    console.log("server 无状态、不读这个文件；它由**客户端**读取，用于 HTTP 请求头 Authorization: Bearer <userToken>。");
    console.log("下一步：wikipali_ensure_model（Authorization: Bearer <userToken>）拿 modelToken 并同样存到客户端侧。");
    return 0;
  } catch (exc) {
    if (exc instanceof ApiError && (exc.status === 400 || exc.status === 401)) {
      console.error("错误：用户名或密码不正确。");
    } else if (exc instanceof WpError) {
      console.error(`错误：${exc.message}`);
    } else {
      console.error(`错误：登录失败：${String(exc)}`);
    }
    return 1;
  } finally {
    password = "";
  }
}

void main().then((code) => process.exit(code));
