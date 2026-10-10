import type { APIRoute } from "astro";
import { SESSION_COOKIE, jaccountConfigured, verifySessionToken } from "../../../lib/auth";
import { isSiteAdmin } from "../../../lib/site-admin";

export const prerender = false;

/** GET /api/auth/me → {authenticated, configured, admin, user?}（供前端静态页查询登录态） */
export const GET: APIRoute = async ({ cookies }) => {
  const session = verifySessionToken(cookies.get(SESSION_COOKIE)?.value);
  return new Response(
    JSON.stringify({
      authenticated: Boolean(session),
      configured: jaccountConfigured,
      admin: session ? isSiteAdmin(session.user.account) : false,
      user: session
        ? { account: session.user.account, name: session.user.name, code: session.user.code, type: session.user.type }
        : null,
    }),
    { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } },
  );
};
