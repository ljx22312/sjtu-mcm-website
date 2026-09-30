import type { APIRoute } from "astro";
import { SESSION_COOKIE, verifySessionToken } from "../../../lib/auth";
import { AGENT_MAX_MESSAGE_CHARS, agentAllowAnonymous, agentRateLimitPerHour } from "../../../lib/agent/config";
import { runAgentTurn } from "../../../lib/agent/runner";

export const prerender = false;

/** 单进程内存限流：account → 最近一小时的消息时间戳 */
const rateWindow = new Map<string, number[]>();

function allowMessage(account: string): boolean {
  const now = Date.now();
  const windowStart = now - 3600_000;
  const hits = (rateWindow.get(account) ?? []).filter((t) => t > windowStart);
  if (hits.length >= agentRateLimitPerHour) {
    rateWindow.set(account, hits);
    return false;
  }
  hits.push(now);
  rateWindow.set(account, hits);
  return true;
}

/**
 * POST /api/agent/chat  body: {"message": "...", "sessionId": 123?}
 * 需登录（jAccount 会话）；内测期可设 AGENT_ALLOW_ANONYMOUS=1 免登录。SSE 流式返回：
 *   {"type":"session","sessionId":123}            本轮归入的会话 id（首个事件）
 *   {"type":"thinking","text":"..."}             思考增量（正文出现前）
 *   {"type":"tool","name":"search_curriculum"}   工具执行提示
 *   {"type":"delta","text":"..."}                回复增量
 *   {"type":"done"}                              结束（回复已入库）
 *   {"type":"error","message":"..."}             失败
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  /* 登录用户按账号隔离；未登录且开启匿名模式时共用匿名身份（内测期临时开关） */
  const session = verifySessionToken(cookies.get(SESSION_COOKIE)?.value);
  const account = session?.user.account ?? (agentAllowAnonymous ? "anonymous" : null);
  if (!account) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (!allowMessage(account)) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  let message = "";
  let sessionId: number | undefined;
  try {
    const body = (await request.json()) as { message?: unknown; sessionId?: unknown };
    message = typeof body.message === "string" ? body.message.trim() : "";
    const sid = Number(body.sessionId);
    sessionId = Number.isFinite(sid) && sid > 0 ? sid : undefined;
  } catch {
    message = "";
  }
  if (!message) {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (message.length > AGENT_MAX_MESSAGE_CHARS) {
    message = message.slice(0, AGENT_MAX_MESSAGE_CHARS);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* 客户端已断开 */
        }
      };
      const result = await runAgentTurn({
        account,
        message,
        sessionId,
        handlers: {
          onDelta: (text) => send({ type: "delta", text }),
          onThinking: (text) => send({ type: "thinking", text }),
          onTool: (name) => send({ type: "tool", name }),
          onSession: (sessionId) => send({ type: "session", sessionId }),
        },
        signal: request.signal,
      });
      if (result.error) {
        const err = result.error as Error & { stack?: string };
        console.error(`[agent] account=${account} 回复失败:`, err.stack ?? err);
        send({ type: "error", message: "出错了，请稍后重试。" });
      } else {
        send({ type: "done" });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
};
