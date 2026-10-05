/**
 * 「下一版本」「管理员视角」以及 /api/admin/* 的门禁。
 * 未登录转到登录页；已登录但不是网站管理员则返回 404，避免把内部入口暴露成「无权限」。
 */
import { SESSION_COOKIE, sanitizeRedirect, verifySessionToken, type SessionUser } from "./auth";
import { isSiteAdmin } from "./site-admin";

type CookieJar = { get(name: string): { value: string } | undefined };

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  Vary: "Cookie",
};

export function isPrivilegedPath(pathname: string): boolean {
  return (
    pathname === "/next" ||
    pathname.startsWith("/next/") ||
    pathname === "/staff" ||
    pathname.startsWith("/staff/") ||
    pathname === "/api/admin" ||
    pathname.startsWith("/api/admin/")
  );
}

export function readSessionUser(cookies: CookieJar): SessionUser | undefined {
  return verifySessionToken(cookies.get(SESSION_COOKIE)?.value)?.user;
}

/** 已是网站管理员时返回 undefined；否则返回应直接送出的响应。 */
export function denyPrivilegedRequest(context: { url: URL; cookies: CookieJar }): Response | undefined {
  const user = readSessionUser(context.cookies);
  if (user && isSiteAdmin(user.account)) return undefined;

  if (context.url.pathname.startsWith("/api/")) {
    const status = user ? 404 : 401;
    return new Response(JSON.stringify({ error: user ? "not_found" : "unauthorized" }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", ...PRIVATE_HEADERS },
    });
  }
  if (!user) {
    const back = sanitizeRedirect(context.url.pathname, "/");
    return new Response(null, {
      status: 302,
      headers: { Location: `/login?redirect=${encodeURIComponent(back)}`, ...PRIVATE_HEADERS },
    });
  }
  return new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...PRIVATE_HEADERS },
  });
}
