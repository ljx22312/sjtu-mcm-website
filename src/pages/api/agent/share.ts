import type { APIRoute } from "astro";
import { resolveAgentAccount } from "../../../lib/agent/account";
import { createShare } from "../../../lib/agent/history";

export const prerender = false;

/**
 * POST /api/agent/share  { sessionId, messageId? }
 * messageId 有值时分享那一轮问答，否则分享整场仍在界面上的对话。
 */
export const POST: APIRoute = async ({ request, cookies, url }) => {
  const account = resolveAgentAccount(cookies);
  if (!account) return Response.json({ error: "unauthorized" }, { status: 401 });
  let sessionId = 0;
  let messageId: number | undefined;
  try {
    const body = (await request.json()) as { sessionId?: unknown; messageId?: unknown };
    sessionId = Number(body.sessionId);
    if (body.messageId != null && body.messageId !== "") {
      const parsed = Number(body.messageId);
      if (Number.isFinite(parsed) && parsed > 0) messageId = parsed;
    }
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const share = createShare(account, sessionId, messageId);
  if (!share) return Response.json({ error: "not_found" }, { status: 404 });
  const link = new URL(`/share/${share.id}`, url.origin).toString();
  return Response.json({ ok: true, url: link, title: share.title });
};
