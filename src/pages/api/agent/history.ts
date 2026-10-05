import type { APIRoute } from "astro";
import { resolveAgentAccount } from "../../../lib/agent/account";
import { clearHistory, listRecent } from "../../../lib/agent/history";

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/** GET /api/agent/history → 当前登录用户最近 50 条对话（时间正序），供面板恢复上下文 */
export const GET: APIRoute = async ({ cookies }) => {
  const account = resolveAgentAccount(cookies);
  if (!account) return json({ error: "unauthorized" }, 401);
  const messages = listRecent(account, 50);
  return json({ messages });
};

/** DELETE /api/agent/history → 清除当前登录用户的全部对话记录 */
export const DELETE: APIRoute = async ({ cookies }) => {
  const account = resolveAgentAccount(cookies);
  if (!account) return json({ error: "unauthorized" }, 401);
  const cleared = clearHistory(account);
  return json({ cleared });
};
