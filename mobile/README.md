# mobile/ —— Expo App（Android 真机，Expo Go）

Expo SDK 57（React Native 0.86，TypeScript 模板）+ `@copilotkit/react-native` 1.69：

- 入口 `index.ts`：最前面导入 polyfill（顺序是强制的，勿调整）：
  `react-native-get-random-values`（第 1 行）→ `@copilotkit/react-native/polyfills`
- `App.tsx`：`<CopilotKitProvider runtimeUrl={...}>` 包住预制 `<CopilotChat agentName="pali_agent" />`
- `metro.config.js`：官方文档的 jose 修复（否则 Metro 打 bundle 报 `Unable to resolve module node:buffer`）

## 端口

- Expo/Metro **8081**（`npx expo start`）
- 依赖 runtime **3001**（再往前 backend **8000**），两个服务均已绑定 `0.0.0.0`

## 真机测试前必做

1. **手机和电脑连同一个 WiFi**
2. **电脑防火墙放行 3001（runtime）和 8081（Metro）端口**，否则手机连不上
3. 把 runtime 地址改成电脑的局域网 IP：

```bash
cd mobile
cp .env.example .env
# 编辑 .env：EXPO_PUBLIC_RUNTIME_URL=http://<电脑IP>:3001/api/copilotkit
# 查看电脑 IP：Windows `ipconfig`；macOS/Linux `ifconfig` 或 `ip addr`
```

> 手机上不能用 localhost/127.0.0.1（那指向手机自己）。

## 启动（先启动 backend 和 runtime）

```bash
cd mobile
npm install
npx expo start          # 或 npm start
# 用手机上的 Expo Go（Play 商店安装）扫终端里的二维码（Android）
# 改过 .env 后需要重启 expo start
```

## 验证

1. Expo Go 扫码加载应用（首次 bundle 可能要等 1-2 分钟）
2. 输入「什么是四圣谛？」发送
3. 预期：先看到工具调用状态（`retrieve_sutta_passage`），随后流式回答
   （引用 SN 56.11 经文；未配置 DEEPSEEK_API_KEY 时带「mock 演示模式」前缀）
4. 若一直转圈：确认手机浏览器能打开 `http://<电脑IP>:3001/api/copilotkit/info`（通则网络/防火墙 OK）

## 已知坑（已处理）

- **jose 的 node:* 导入**：Metro 打包报错，`metro.config.js` 里用官方 resolveRequest 修复
- **polyfill 顺序**：安全随机源必须第一行，否则 CopilotKit 锁死非加密随机回退
- **导入面**：`/components`（CopilotChat）与根入口都要装全 peer 依赖
  （@gorhom/bottom-sheet、expo-document-picker、expo-file-system 等，已用 expo install 装好）
