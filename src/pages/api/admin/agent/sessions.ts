import type { APIRoute } from "astro";
import { denyPrivilegedRequest } from "../../../../lib/site-gate";
import { listSessions } from "../../../../lib/agent/history";

export const prerender = false;

/**
 * GET /api/admin/agent/sessions?account=xxx
 * 管理员查看某账号的会话列表。与管理员名单不同：这里可以看任何使用者。
 */
export const GET: APIRoute = async ({ url, cookies }) => {
  const denied = denyPrivilegedRequest({ url, cookies });
  if (denied) return denied;
  const account = url.searchParams.get("account")?.trim() ?? "";
  if (!account || account.length > 64) {
    return new Response(JSON.stringify({ error: "invalid_account" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
    });
  }
  return new Response(JSON.stringify({ account, sessions: listSessions(account, 200) }), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
  });
};
