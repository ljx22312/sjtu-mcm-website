import type { APIRoute } from "astro";
import { SESSION_COOKIE, verifySessionToken } from "../../../lib/auth";
import { clearHistory, listRecent } from "../../../lib/agent/history";
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

/** GET /api/agent/history → 当前登录用户最近 50 条对话（时间正序），供面板恢复上下文 */
export const GET: APIRoute = async ({ cookies }) => {
  const account = resolveAccount(cookies);
  if (!account) return json({ error: "unauthorized" }, 401);
  const messages = listRecent(account, 50);
  return json({ messages });
};

/** DELETE /api/agent/history → 清除当前登录用户的全部对话记录 */
export const DELETE: APIRoute = async ({ cookies }) => {
  const account = resolveAccount(cookies);
  if (!account) return json({ error: "unauthorized" }, 401);
  const cleared = clearHistory(account);
  return json({ cleared });
};
