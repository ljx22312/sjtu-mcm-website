import type { APIRoute } from "astro";
import { identityLabel, resolveAgentAccount } from "../../../lib/agent/account";
import { beginSession, deleteSession, listSessionMessages, listSessions } from "../../../lib/agent/history";

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/**
 * GET /api/agent/sessions            → 该身份的会话（最近活跃倒序）
 * GET /api/agent/sessions?id=123     → 该会话未撤回的消息
 * POST /api/agent/sessions           → 新开一场空会话，返回 session_id
 * DELETE /api/agent/sessions?id=123  → 从界面拿掉该场，记录仍留在库里
 */
export const GET: APIRoute = async ({ url, cookies }) => {
  const account = resolveAgentAccount(cookies);
  if (!account) return json({ error: "unauthorized" }, 401);

  const idRaw = url.searchParams.get("id");
  if (idRaw) {
    const id = Number.parseInt(idRaw, 10);
    if (!Number.isFinite(id) || id <= 0) return json({ error: "bad_request" }, 400);
    const messages = listSessionMessages(account, id);
    if (messages.length === 0) return json({ error: "not_found" }, 404);
    return json({ session_id: id, messages });
  }
  return json({ identity: identityLabel(account), account, sessions: listSessions(account) });
};

export const POST: APIRoute = async ({ cookies }) => {
  const account = resolveAgentAccount(cookies);
  if (!account) return json({ error: "unauthorized" }, 401);
  return json({ session_id: beginSession(account), identity: identityLabel(account) });
};

export const DELETE: APIRoute = async ({ url, cookies }) => {
  const account = resolveAgentAccount(cookies);
  if (!account) return json({ error: "unauthorized" }, 401);
  const id = Number.parseInt(url.searchParams.get("id") ?? "", 10);
  if (!Number.isFinite(id) || id <= 0) return json({ error: "bad_request" }, 400);
  const hidden = deleteSession(account, id);
  return json({ hidden });
};
