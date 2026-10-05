import type { APIRoute } from "astro";
import {
  SESSION_COOKIE,
  cookieOptions,
  isRequestSecure,
  signSession,
} from "../../../lib/auth";
import { ROOT_ADMIN_ACCOUNT, ROOT_ADMIN_NAME, rootAdminConfigured, verifyRootAdminPassword } from "../../../lib/root-admin";

export const prerender = false;

const fails = new Map<string, { n: number; until: number }>();

function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "local";
}

function locked(key: string): boolean {
  const row = fails.get(key);
  if (!row) return false;
  if (row.until > Date.now() && row.n >= 8) return true;
  if (row.until <= Date.now()) fails.delete(key);
  return false;
}

function noteFail(key: string): void {
  const row = fails.get(key) ?? { n: 0, until: Date.now() + 15 * 60 * 1000 };
  row.n += 1;
  row.until = Date.now() + 15 * 60 * 1000;
  fails.set(key, row);
}

/**
 * POST /api/auth/root  { password }
 * 口令正确则签发主管理员会话（账号 root）。错误口令不说明细节。
 */
export const POST: APIRoute = async ({ request, cookies, url }) => {
  if (!rootAdminConfigured()) {
    return Response.json({ error: "主管理员口令尚未配置。" }, { status: 503 });
  }
  const key = clientKey(request);
  if (locked(key)) {
    return Response.json({ error: "尝试次数过多，请稍后再试。" }, { status: 429 });
  }
  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    password = "";
  }
  if (!verifyRootAdminPassword(password)) {
    noteFail(key);
    return Response.json({ error: "密码不正确。" }, { status: 401 });
  }
  fails.delete(key);
  const secure = isRequestSecure(url, request.headers);
  cookies.set(
    SESSION_COOKIE,
    signSession({
      account: ROOT_ADMIN_ACCOUNT,
      name: ROOT_ADMIN_NAME,
      code: "",
      type: "admin",
    }),
    cookieOptions(secure, 7 * 24 * 3600),
  );
  return Response.json({ ok: true, account: ROOT_ADMIN_ACCOUNT, name: ROOT_ADMIN_NAME });
};
