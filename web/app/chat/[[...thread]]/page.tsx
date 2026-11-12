import ChatApp from "../ChatApp";

/**
 * /agent/chat 与 /agent/chat/<threadId>：后者打开那个历史会话接着问（只认 uuid）。
 */
export default async function ChatPage({ params }: { params: Promise<{ thread?: string[] }> }) {
  const { thread } = await params;
  const id = thread?.[0];
  const threadId = id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
  return <ChatApp initialThreadId={threadId} />;
}
