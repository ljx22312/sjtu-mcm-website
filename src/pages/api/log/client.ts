import type { APIRoute } from "astro";
import { SESSION_COOKIE, verifySessionToken } from "../../../lib/auth";
import { logClientEvent } from "../../../lib/logger";

export const prerender = false;

/**
 * POST /api/log/client —— 前端错误上报（BaseLayout 内联脚本 sendBeacon，见 layouts/BaseLayout.astro）。
 * 只接受 ≤8KB 的固定字段 JSON；按来源 IP 内存限流（30 条 / 5 分钟）；
 * 账号从会话 cookie 服务端判定，不信任客户端自报身份。
 * 注意：本机直连时 x-forwarded-for 可伪造，仅用于日志溯源，限流被绕过也只是日志灌水，风险可接受。
 */

const RATE_WINDOW_MS = 300_000;
const RATE_LIMIT = 30;
const rateWindow = new Map<string, number[]>();

function allow(ip: string): boolean {
  const now = Date.now();
  const hits = (rateWindow.get(ip) ?? []).filter((t) => t > now - RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) {
    rateWindow.set(ip, hits);
    return false;
  }
  hits.push(now);
  rateWindow.set(ip, hits);
  return true;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "direct";
  if (!allow(ip)) return new Response(null, { status: 429 });

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 8192) return new Response(null, { status: 413 });
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 400 });
  }

  const session = verifySessionToken(cookies.get(SESSION_COOKIE)?.value);
  logClientEvent({
    kind: typeof body.kind === "string" ? body.kind : "unknown",
    msg: typeof body.msg === "string" ? body.msg : "unparseable",
    stack: typeof body.stack === "string" ? body.stack : "",
    page: typeof body.page === "string" ? body.page : "",
    ua: request.headers.get("user-agent") ?? "",
    account: session?.user.account ?? null,
    ip,
  });
  return new Response(null, { status: 204 });
};
