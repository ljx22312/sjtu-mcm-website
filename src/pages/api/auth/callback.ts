import type { APIRoute } from "astro";
import {
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  cookieOptions,
  exchangeCode,
  isRequestSecure,
  sanitizeRedirect,
  signSession,
  verifyIdToken,
} from "../../../lib/auth";
import { logEvent } from "../../../lib/logger";

export const prerender = false;

/**
 * GET /api/auth/callback?code=...&state=...
 * 校验 state（与登录时写入的 httpOnly cookie 比对）→ 换 token → 验签 id_token → 发会话。
 * 任何一步失败都回 /login 带错误说明，不暴露细节。
 */
export const GET: APIRoute = async ({ url, request, cookies, redirect }) => {
  const fail = (msg: string) => redirect(`/login?notice=error&msg=${encodeURIComponent(msg)}`, 302);

  const stateCookie = cookies.get(OAUTH_STATE_COOKIE)?.json() as { s?: string; n?: string } | null;
  cookies.delete(OAUTH_STATE_COOKIE, { path: "/" });

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return fail("jAccount 授权被拒绝或失败");
  if (!code || !state || !stateCookie?.s || state !== stateCookie.s) {
    return fail("登录状态校验失败，请重新登录");
  }

  try {
    const callbackUrl = new URL("/api/auth/callback", url.origin).toString();
    const tokens = await exchangeCode(code, callbackUrl);
    const user = verifyIdToken(tokens.id_token);
    const secure = isRequestSecure(url, request.headers);
    cookies.set(SESSION_COOKIE, signSession(user), cookieOptions(secure, 7 * 24 * 3600));
    return redirect(sanitizeRedirect(stateCookie.n), 302);
  } catch (e) {
    const err = e as Error & { stack?: string };
    logEvent("error", "auth_callback_failed", { message: err?.message ?? String(e), stack: err?.stack ?? "" });
    return fail("登录处理失败，请稍后重试");
  }
};
