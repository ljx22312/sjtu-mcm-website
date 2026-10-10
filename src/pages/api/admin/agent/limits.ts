import type { APIRoute } from "astro";
import { logEvent } from "../../../../lib/logger";
import { denyPrivilegedRequest, readSessionUser } from "../../../../lib/site-gate";
import { clearUserLimit, getUserLimits, setUserLimit } from "../../../../lib/agent/usage";

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
  });

/** 窗口条数：-1 不限、0 禁止、正数条数；null 表示显式清除该字段的覆盖；undefined 表示取值非法 */
function parseLimitValue(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n >= -1 && n <= 100000 ? n : undefined;
}

/**
 * GET    /api/admin/agent/limits            全部覆盖项
 * POST   /api/admin/agent/limits            {account, window?, blocked?, note?} 设覆盖（null=清除该字段）
 * DELETE /api/admin/agent/limits?account=   删掉整个覆盖项，回到全局默认
 */
export const GET: APIRoute = async ({ url, cookies }) => {
  const denied = denyPrivilegedRequest({ url, cookies });
  if (denied) return denied;
  return json({ limits: getUserLimits() });
};

export const POST: APIRoute = async ({ url, cookies, request }) => {
  const denied = denyPrivilegedRequest({ url, cookies });
  if (denied) return denied;
  let account = "";
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
    if (typeof body.account === "string") account = body.account.trim();
  } catch {
    return json({ error: "bad_request", message: "请求格式不正确。" }, 400);
  }
  if (!account || account.length > 64) {
    return json({ error: "invalid_account", message: "账号不能为空。" }, 400);
  }
  /* 部分更新：只校验提交了的字段（例如仅勾选禁用时不必带 window） */
  const patch: { window?: number | null; blocked?: boolean; note?: string } = {};
  if ("window" in body) {
    const v = parseLimitValue(body.window);
    if (v === undefined) return json({ error: "invalid_limit", message: "window 取值非法：-1 不限、0 禁止、正数为条数。" }, 400);
    patch.window = v;
  }
  if (body.blocked !== undefined) patch.blocked = body.blocked === true;
  if (body.note !== undefined) patch.note = String(body.note).slice(0, 200);
  const limit = setUserLimit(account, patch);
  logEvent("info", "agent_limit_set", {
    actor: readSessionUser(cookies)?.account ?? "",
    account,
    window: limit.window ?? null,
    blocked: Boolean(limit.blocked),
  });
  return json({ account, limit });
};

export const DELETE: APIRoute = async ({ url, cookies }) => {
  const denied = denyPrivilegedRequest({ url, cookies });
  if (denied) return denied;
  const account = url.searchParams.get("account")?.trim() ?? "";
  if (!account) return json({ error: "invalid_account", message: "账号不能为空。" }, 400);
  const removed = clearUserLimit(account);
  logEvent("info", "agent_limit_cleared", { actor: readSessionUser(cookies)?.account ?? "", account });
  return json({ account, removed });
};
