import type { APIRoute } from "astro";
import { SESSION_COOKIE, verifySessionToken } from "../../../lib/auth";
import {
  AGENT_MAX_MESSAGE_CHARS,
  agentAllowAnonymous,
  agentRateLimitCustomPerHour,
  agentRateLimitPerHour,
} from "../../../lib/agent/config";
import { runAgentTurn } from "../../../lib/agent/runner";
import { getCustomRuntime, type CustomLlmConfig } from "../../../lib/agent/models";
import { REASONING_LEVELS, type ReasoningLevel } from "../../../lib/agent/admin";

export const prerender = false;

/** 单进程内存限流：account → 最近一小时的消息时间戳（key: account / account|custom） */
const rateWindow = new Map<string, number[]>();

function allowMessage(key: string, limit: number): boolean {
  const now = Date.now();
  const windowStart = now - 3600_000;
  const hits = (rateWindow.get(key) ?? []).filter((t) => t > windowStart);
  if (hits.length >= limit) {
    rateWindow.set(key, hits);
    return false;
  }
  hits.push(now);
  rateWindow.set(key, hits);
  return true;
}

/** 解析并校验自带 API 配置（存于用户浏览器，随请求携带，服务端不落盘） */
function parseCustomConfig(raw: unknown): CustomLlmConfig | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "custom 配置格式错误" };
  const c = raw as Record<string, unknown>;
  const baseUrl = typeof c.baseUrl === "string" ? c.baseUrl.trim().replace(/\/+$/, "") : "";
  const apiKey = typeof c.apiKey === "string" ? c.apiKey.trim() : "";
  const model = typeof c.model === "string" ? c.model.trim() : "";
  const reasoning = c.reasoning as ReasoningLevel;
  if (!baseUrl || !apiKey || !model) return { error: "自带 API 配置不完整" };
  /* 仅允许 https，防止把服务器当跳板探测内网（SSRF） */
  if (!/^https:\/\/[^\s/$.?#][^\s]*$/.test(baseUrl)) return { error: "API 地址必须以 https:// 开头" };
  if (baseUrl.length > 300 || apiKey.length > 500 || model.length > 100) {
    return { error: "自带 API 配置超长" };
  }
  if (!REASONING_LEVELS.some((r) => r.value === reasoning)) return { error: "思考深度取值非法" };
  return { baseUrl, apiKey, model, reasoning };
}

/**
 * POST /api/agent/chat  body: {"message": "...", "sessionId": 123?, "custom"?: {baseUrl,apiKey,model,reasoning}}
 * 需登录（jAccount 会话）；内测期可设 AGENT_ALLOW_ANONYMOUS=1 免登录。SSE 流式返回：
 *   {"type":"session","sessionId":123}            本轮归入的会话 id（首个事件）
 *   {"type":"thinking","text":"..."}             思考增量（正文出现前）
 *   {"type":"tool","name":"search_curriculum"}   工具执行提示
 *   {"type":"delta","text":"..."}                回复增量
 *   {"type":"done"}                              结束（回复已入库）
 *   {"type":"error","message":"..."}             失败
 * custom 为用户自带 API（Anthropic 协议）配置：存于用户浏览器，随请求携带，服务端不落盘；
 * 官方 Key 未配置（演示模式）时忽略 custom。
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

  let message = "";
  let sessionId: number | undefined;
  let customRaw: unknown = undefined;
  try {
    const body = (await request.json()) as { message?: unknown; sessionId?: unknown; custom?: unknown };
    message = typeof body.message === "string" ? body.message.trim() : "";
    const sid = Number(body.sessionId);
    sessionId = Number.isFinite(sid) && sid > 0 ? sid : undefined;
    customRaw = body.custom;
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

  /* 自带 API 的用户走独立限流（默认 100 条/小时，花自己的额度） */
  const custom = customRaw === undefined ? null : parseCustomConfig(customRaw);
  if (custom && "error" in custom) {
    return new Response(JSON.stringify({ error: custom.error }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const rateKey = custom ? `${account}|custom` : account;
  if (!allowMessage(rateKey, custom ? agentRateLimitCustomPerHour : agentRateLimitPerHour)) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
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
        ...(custom ? { runtime: getCustomRuntime(custom) } : {}),
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
        console.error(`[agent] account=${account}${custom ? "(custom)" : ""} 回复失败:`, err.stack ?? err);
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
