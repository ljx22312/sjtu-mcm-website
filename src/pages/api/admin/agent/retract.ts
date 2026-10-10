import type { APIRoute } from "astro";
import { logEvent } from "../../../../lib/logger";
import { denyPrivilegedRequest, readSessionUser } from "../../../../lib/site-gate";
import { deleteSession } from "../../../../lib/agent/history";

export const prerender = false;

/**
 * POST /api/admin/agent/retract  {account, sessionId}
 * 管理员撤回某账号的一场会话：对用户和管理端都不可见，行保留可审计。
 */
export const POST: APIRoute = async ({ url, cookies, request }) => {
  const denied = denyPrivilegedRequest({ url, cookies });
  if (denied) return denied;
  let account = "";
  let sessionId = 0;
  try {
    const body = (await request.json()) as { account?: unknown; sessionId?: unknown };
    if (typeof body.account === "string") account = body.account.trim();
    const sid = Number(body.sessionId);
    if (Number.isInteger(sid) && sid > 0) sessionId = sid;
  } catch {
    /* 走下面的参数校验 */
  }
  if (!account || account.length > 64 || sessionId <= 0) {
    return new Response(JSON.stringify({ error: "bad_request", message: "参数不完整。" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
    });
  }
  const removed = deleteSession(account, sessionId);
  logEvent("warn", "agent_session_retracted_by_admin", {
    actor: readSessionUser(cookies)?.account ?? "",
    account,
    sessionId,
    messages: removed,
  });
  return new Response(JSON.stringify({ account, sessionId, removed }), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
  });
};
