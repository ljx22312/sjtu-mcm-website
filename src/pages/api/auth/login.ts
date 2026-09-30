import type { APIRoute } from "astro";
import {
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  MOCK_USER,
  buildAuthorizeUrl,
  cookieOptions,
  isRequestSecure,
  jaccountConfigured,
  mockAllowed,
  randomState,
  sanitizeRedirect,
  signSession,
} from "../../../lib/auth";

export const prerender = false;

/**
 * GET /api/auth/login?redirect=/join
 * 正式凭据已配置 → 302 到 jAccount 授权页（带随机 state，存 httpOnly cookie 防 CSRF）；
 * 未配置（申请审批中）→ 引导到 /login 说明页；?mock=1 时发演示会话供开发联调。
 */
export const GET: APIRoute = async ({ url, request, cookies, redirect }) => {
  const next = sanitizeRedirect(url.searchParams.get("redirect"));
  const secure = isRequestSecure(url, request.headers);

  if (!jaccountConfigured) {
    if (mockAllowed && url.searchParams.get("mock") === "1") {
      cookies.set(SESSION_COOKIE, signSession(MOCK_USER), cookieOptions(secure, 7 * 24 * 3600));
      return redirect(next, 302);
    }
    const q = new URLSearchParams({ notice: "pending" });
    if (next !== "/") q.set("redirect", next);
    return redirect(`/login?${q.toString()}`, 302);
  }

  const state = randomState();
  const callbackUrl = new URL("/api/auth/callback", url.origin).toString();
  cookies.set(
    OAUTH_STATE_COOKIE,
    JSON.stringify({ s: state, n: next }),
    cookieOptions(secure, 600),
  );
  return redirect(buildAuthorizeUrl(callbackUrl, state).toString(), 302);
};
