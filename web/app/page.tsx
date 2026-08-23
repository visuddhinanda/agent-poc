"use client";

// 经典 CopilotKit 组合：
// - CopilotKit（@copilotkit/react-core/v2 的向后兼容包装器，官方 quickstart 同款）
// - CopilotChat（@copilotkit/react-ui 的预制聊天组件）
// useSingleEndpoint={false}：runtime 运行在多路由模式（GET /info + POST /agent/:id/run）
import { CopilotKit } from "@copilotkit/react-core/v2";
import { CopilotChat } from "@copilotkit/react-ui";

// runtime 地址：默认本机 3001；部署时用 NEXT_PUBLIC_RUNTIME_URL 覆盖
const runtimeUrl =
  process.env.NEXT_PUBLIC_RUNTIME_URL || "http://localhost:3001/api/copilotkit";

export default function Home() {
  return (
    <CopilotKit
      runtimeUrl={runtimeUrl}
      agent="pali_agent"
      useSingleEndpoint={false}
    >
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          minHeight: "100vh",
          background: "#f7f3ea",
        }}
      >
        <h1 style={{ margin: "18px 0 4px", fontSize: 22 }}>
          巴利经文 AI 问答助手（POC）
        </h1>
        <p style={{ margin: 0, color: "#8a7a5c", fontSize: 14 }}>
          Runtime: {runtimeUrl} · 试试问「什么是四圣谛？」「缘起是什么？」「慈经讲了什么？」
        </p>
        <div
          style={{
            flex: 1,
            width: "100%",
            maxWidth: 760,
            padding: 16,
            boxSizing: "border-box",
            minHeight: 0,
          }}
        >
          <CopilotChat
            labels={{
              title: "法音 Pali-QA",
              initial:
                "你好！我是巴利经文问答助手。可以问我关于四圣谛、八正道、缘起、无常、无我、慈经等问题。",
            }}
          />
        </div>
      </main>
    </CopilotKit>
  );
}
