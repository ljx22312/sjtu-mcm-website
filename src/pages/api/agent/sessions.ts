import type { APIRoute } from "astro";
import { SESSION_COOKIE, verifySessionToken } from "../../../lib/auth";
import { deleteSession, listSessionMessages, listSessions } from "../../../lib/agent/history";
import { agentAllowAnonymous } from "../../../lib/agent/config";

export const prerender = false;

/** 登录用户返回其账号；未登录且开启匿名模式时返回 "anonymous"，否则 null（401） */
function resolveAccount(cookies: { get(name: string): { value?: string } | undefined }): string | null {
  const session = verifySessionToken(cookies.get(SESSION_COOKIE)?.value);
  return session?.user.account ?? (agentAllowAnonymous ? "anonymous" : null);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/**
 * GET /api/agent/sessions            → 该用户全部会话（最近活跃倒序，含标题/条数/时间）
 * GET /api/agent/sessions?id=123     → 该会话完整消息（时间正序，含思考）
 * DELETE /api/agent/sessions?id=123  → 删除单个会话
 */
export const GET: APIRoute = async ({ url, cookies }) => {
  const account = resolveAccount(cookies);
  if (!account) return json({ error: "unauthorized" }, 401);

  const idRaw = url.searchParams.get("id");
  if (idRaw) {
    const id = Number.parseInt(idRaw, 10);
    if (!Number.isFinite(id) || id <= 0) return json({ error: "bad_request" }, 400);
    const messages = listSessionMessages(account, id);
    if (messages.length === 0) return json({ error: "not_found" }, 404);
    return json({ session_id: id, messages });
  }
  return json({ sessions: listSessions(account) });
};

export const DELETE: APIRoute = async ({ url, cookies }) => {
  const account = resolveAccount(cookies);
  if (!account) return json({ error: "unauthorized" }, 401);
  const id = Number.parseInt(url.searchParams.get("id") ?? "", 10);
  if (!Number.isFinite(id) || id <= 0) return json({ error: "bad_request" }, 400);
  const deleted = deleteSession(account, id);
  return json({ deleted });
};
