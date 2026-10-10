import type { APIRoute } from "astro";
import {
  OAUTH_STATE_COOKIE,
  buildAuthorizeUrl,
  cookieOptions,
  isRequestSecure,
  jaccountConfigured,
  randomState,
  sanitizeRedirect,
} from "../../../lib/auth";

export const prerender = false;

/**
 * GET /api/auth/login?redirect=/join
 * 正式凭据已配置 → 302 到 jAccount 授权页（带随机 state，存 httpOnly cookie 防 CSRF）；
 * 未配置 → 503 说明页。
 */
export const GET: APIRoute = async ({ url, request, cookies, redirect }) => {
  const next = sanitizeRedirect(url.searchParams.get("redirect"));
  const secure = isRequestSecure(url, request.headers);

  if (!jaccountConfigured) {
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>登录暂不可用</title>
<p>jAccount 统一认证尚未配置（凭据审批或配置中），暂时无法登录。</p>`,
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
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
