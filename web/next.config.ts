import type { NextConfig } from "next";

/**
 * 部署在 next.wikipali.org/agent，与 dashboard-v6（/pcd-v2026/）同源：
 * 登录 token 在同源 storage 里共用，登录页的回跳也只接受同源地址（docs/trace.md）。
 */
const basePath = "/agent";

const nextConfig: NextConfig = {
  basePath,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    // CopilotKit 在浏览器里也会上报遥测（telemetry.copilotkit.ai）：关掉，CSP 也不放行外站
    COPILOTKIT_TELEMETRY_DISABLED: "true",
  },
};

export default nextConfig;
