# 当前状态（2026-08-23）

> 远程开发告一段落，转向本地开发验证。此文件记录交接状态，勿对外公开真实 IP/账号。

## 1. 代码仓库

- GitHub：`git@github.com:visuddhinanda/agent-poc.git`，分支 `main`
- 远程服务器工作副本已全部推送，工作区干净（`main...origin/main`）
- web/mobile 子目录里的模板残留 `.git` 已删除，GitHub 自动生成的 LICENSE 保留
- `.env*`、`node_modules` 不入库，clone 后自行 `cp .env.example .env`

## 2. 远程服务器当前进程

四层服务全部在跑：

| 服务 | 端口 | 状态 |
|---|---|---|
| backend（uvicorn） | 8000（0.0.0.0） | ✅ 运行中 |
| runtime | 3001（0.0.0.0） | ✅ 运行中 |
| web（next dev） | 3000 | ✅ 运行中 |
| mobile（expo） | 8081 | ⚠️ `--tunnel` 模式（手机端下载失败） |

expo 进程在 tmux 会话 `agent-run` window 0。退出 SSH 后 tmux 里的进程会继续跑。

## 3. 远程联调进度

**已打通：**

- SSH 隧道（runtime）：`ssh -p <SSH端口> -L 0.0.0.0:3080:localhost:3001 <用户名>@<远程服务器IP>`
- 手机浏览器可开 `http://<电脑IP>:3080/api/copilotkit/info`（返回 JSON）
- 热点 AP 隔离已关闭，电脑防火墙放行 ssh

**未打通（待办）：**

- Metro 8081：`--tunnel` 在手机上报 `Failed to download remote update`
  （exp.direct 不可达，与 runtime 链路无关）
- 下一步方案——第二条隧道 + hostname 覆盖（详见 README「远程开发调试 4)」）：
  ```bash
  ssh -p <SSH端口> -L 0.0.0.0:8081:localhost:8081 <用户名>@<远程服务器IP>
  REACT_NATIVE_PACKAGER_HOSTNAME=<电脑IP> npx expo start
  ```
  验证链：远程 `ss -tulpn | grep 8081` → 电脑 `curl http://localhost:8081` →
  手机浏览器 `http://<电脑IP>:8081` 通了再扫码
- 非阻塞：React Native DevTools 安装报 chrome-sandbox SUID 错，不影响 Metro
  （修复见 README 已知坑 5）

## 4. 本地开发（下一步）

```bash
git clone git@github.com:visuddhinanda/agent-poc.git
```

按 README「完整启动顺序」：

1. backend：`cp .env.example .env`（DEEPSEEK_API_KEY 可选，不填走 mock 演示模型）→ `./run.sh`
2. runtime：`npm install && npm start`
3. web：`npm install && npm run dev` → http://localhost:3000
4. mobile：`npm install`；`mobile/.env` 填本机局域网 IP：
   `EXPO_PUBLIC_RUNTIME_URL=http://<电脑IP>:3001/api/copilotkit`；`npx expo start`

手机真机：与电脑同一 WiFi，防火墙放行 3001 和 8081，直接扫码
（本地 Metro 的 QR 就是电脑 IP，**不需要任何 SSH 隧道**）。

**与远程模式的差异**：本地 runtime 直连 3001；远程模式才用 3080 隧道端口，
`mobile/.env` 两者不能混用。
