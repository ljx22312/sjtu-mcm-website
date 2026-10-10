import type { APIRoute } from "astro";
import { denyPrivilegedRequest } from "../../../../lib/site-gate";
import { listSessionMessages } from "../../../../lib/agent/history";

export const prerender = false;

/**
 * GET /api/admin/agent/messages?account=xxx&session=123
 * 管理员查看某账号某场会话的消息（不含已撤回）。只读：处置入口是 retract。
 */
export const GET: APIRoute = async ({ url, cookies }) => {
  const denied = denyPrivilegedRequest({ url, cookies });
  if (denied) return denied;
  const account = url.searchParams.get("account")?.trim() ?? "";
  const session = Number(url.searchParams.get("session"));
  if (!account || account.length > 64 || !Number.isInteger(session) || session <= 0) {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
    });
  }
  return new Response(JSON.stringify({ account, sessionId: session, messages: listSessionMessages(account, session) }), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
  });
};
