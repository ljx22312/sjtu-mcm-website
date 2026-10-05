import type { APIRoute } from "astro";
import { resolveAgentAccount } from "../../../lib/agent/account";
import { recordFeedback } from "../../../lib/agent/history";

export const prerender = false;

/** POST /api/agent/feedback  { messageId, vote }  vote 为 1、-1 或 0。每次都追加记录。 */
export const POST: APIRoute = async ({ request, cookies }) => {
  const account = resolveAgentAccount(cookies);
  if (!account) return Response.json({ error: "unauthorized" }, { status: 401 });
  let messageId = 0;
  let vote = 0;
  try {
    const body = (await request.json()) as { messageId?: unknown; vote?: unknown };
    messageId = Number(body.messageId);
    vote = Number(body.vote);
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (!Number.isFinite(messageId) || messageId <= 0 || ![1, -1, 0].includes(vote)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const stored = recordFeedback(account, messageId, vote);
  if (stored === null) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true, vote: stored });
};
