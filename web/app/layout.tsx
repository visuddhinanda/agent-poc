import type { Metadata } from "next";
import "./globals.css";
// CopilotKit 聊天组件的官方样式（经典 @copilotkit/react-ui）
import "@copilotkit/react-ui/styles.css";

export const metadata: Metadata = {
  title: "巴利经文 AI 问答助手（POC）",
  description: "LangGraph + CopilotKit 佛教巴利经文问答 POC",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
