import type { APIRoute } from "astro";
import { logEvent } from "../../../lib/logger";
import { denyPrivilegedRequest, readSessionUser } from "../../../lib/site-gate";
import { addSiteAdmin, listSiteAdmins, removeSiteAdmin } from "../../../lib/site-admin";

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });

function gate(context: { url: URL; cookies: { get(name: string): { value: string } | undefined } }): Response | undefined {
  return denyPrivilegedRequest(context);
}

/** GET /api/admin/accounts → 网站管理员名单（仅管理员） */
export const GET: APIRoute = async ({ url, cookies }) => {
  const denied = gate({ url, cookies });
  if (denied) return denied;
  return json({ admins: listSiteAdmins() });
};

/** POST /api/admin/accounts  {account} → 写入 data/site-admins.json */
export const POST: APIRoute = async ({ url, cookies, request }) => {
  const denied = gate({ url, cookies });
  if (denied) return denied;
  let account = "";
  try {
    const body = (await request.json()) as { account?: unknown };
    if (typeof body.account === "string") account = body.account;
  } catch {
    return json({ error: "bad_request", message: "请求格式不正确。" }, 400);
  }
  const result = addSiteAdmin(account);
  if (!result.ok) return json({ error: result.error, message: result.message }, 400);
  logEvent("info", "site_admin_added", { actor: readSessionUser(cookies)?.account ?? "", account: account.trim() });
  return json({ admins: result.admins });
};

/** DELETE /api/admin/accounts  {account} → 从名单文件移除（不能移除最后一名，也不能删环境变量里的账号） */
export const DELETE: APIRoute = async ({ url, cookies, request }) => {
  const denied = gate({ url, cookies });
  if (denied) return denied;
  let account = "";
  try {
    const body = (await request.json()) as { account?: unknown };
    if (typeof body.account === "string") account = body.account;
  } catch {
    return json({ error: "bad_request", message: "请求格式不正确。" }, 400);
  }
  const result = removeSiteAdmin(account);
  if (!result.ok) return json({ error: result.error, message: result.message }, 400);
  logEvent("info", "site_admin_removed", { actor: readSessionUser(cookies)?.account ?? "", account: account.trim() });
  return json({ admins: result.admins });
};
