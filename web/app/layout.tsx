import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
// CopilotKit 聊天组件的官方样式（经典 @copilotkit/react-ui）
import "@copilotkit/react-core/v2/styles.css";

export const metadata: Metadata = {
  title: "巴利经文 AI 问答助手（POC）",
  description: "LangGraph + CopilotKit 佛教巴利经文问答 POC",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 读一次请求头：让页面按请求动态渲染，middleware 生成的 CSP nonce 才能挂到 Next 的脚本上
  await headers();
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
