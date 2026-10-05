import type { APIRoute } from "astro";
import { resolveAgentAccount } from "../../../lib/agent/account";
import { retractTurn } from "../../../lib/agent/history";

export const prerender = false;

/**
 * POST /api/agent/messages  { messageId }
 * 撤回一轮（用户消息及其助手回复）。行仍保留，只是不再进入界面和模型上下文。
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  const account = resolveAgentAccount(cookies);
  if (!account) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  let messageId = 0;
  try {
    const body = (await request.json()) as { messageId?: unknown };
    messageId = Number(body.messageId);
  } catch {
    messageId = 0;
  }
  if (!Number.isFinite(messageId) || messageId <= 0) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const ok = retractTurn(account, messageId);
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true });
};
