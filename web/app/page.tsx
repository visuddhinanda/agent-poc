import { redirect } from "next/navigation";

/** /agent → /agent/chat */
export default function Root() {
  redirect("/chat");
}
