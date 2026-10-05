// @ts-check
import { logEvent } from "./lib/logger";
import { warmRetrieval } from "./lib/agent/corpus";
import { ensureLectureCatalog } from "./lib/agent/lectures";
import { denyPrivilegedRequest, isPrivilegedPath } from "./lib/site-gate";

setImmediate(() => {
  try {
    ensureLectureCatalog();
    warmRetrieval();
  } catch (err) {
    const e = err as Error;
    logEvent("error", "knowledge_warm_failed", { message: e?.message ?? String(err) });
  }
});

/**
 * /next、/staff、/api/admin/* 只放行网站管理员。
 * 其余动态路由未处理异常记结构化日志后返回 500，避免错误只进 journald。
 * 预渲染静态页不经过此处；SSE（/api/agent/chat）在流内自行处理并发 error 事件。
 */
export const onRequest = async (context: any, next: () => Promise<Response>): Promise<Response> => {
  const privileged = isPrivilegedPath(context.url.pathname);
  try {
    if (privileged) {
      const denied = denyPrivilegedRequest(context);
      if (denied) return denied;
    }
    const response = await next();
    if (privileged) {
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("X-Robots-Tag", "noindex, nofollow");
      response.headers.set("Vary", "Cookie");
    }
    if (response.status >= 500) {
      logEvent("error", "http_5xx", { url: context.url.pathname, status: response.status });
    }
    return response;
  } catch (err) {
    const e = err as Error & { stack?: string };
    logEvent("error", "unhandled_exception", {
      url: context.url.pathname,
      method: context.request.method,
      message: e?.message ?? String(err),
      stack: e?.stack ?? "",
    });
    if (context.url.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
};
