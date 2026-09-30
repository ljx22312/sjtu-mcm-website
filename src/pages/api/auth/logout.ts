import type { APIRoute } from "astro";
import {
  SESSION_COOKIE,
  clientId,
  jaccountConfigured,
  randomState,
} from "../../../lib/auth";

export const prerender = false;

/**
 * GET /api/auth/logout        仅清除本站会话
 * GET /api/auth/logout?slo=1  同时跳 jAccount 单点登出后再回来
 */
export const GET: APIRoute = async ({ url, redirect, cookies }) => {
  cookies.delete(SESSION_COOKIE, { path: "/" });

  if (url.searchParams.get("slo") === "1" && jaccountConfigured) {
    const u = new URL("https://jaccount.sjtu.edu.cn/oauth2/logout");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("post_logout_redirect_uri", new URL("/", url.origin).toString());
    u.searchParams.set("state", randomState());
    return redirect(u.toString(), 302);
  }
  return redirect("/", 302);
};
