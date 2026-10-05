import type { APIRoute } from "astro";
import { logEvent } from "../../../lib/logger";
import {
  AGENT_MAX_MESSAGE_CHARS,
  agentRateLimitCustomPerHour,
  agentRateLimitPerHour,
} from "../../../lib/agent/config";
import { resolveAgentAccount } from "../../../lib/agent/account";
import { sessionOwnedBy } from "../../../lib/agent/history";
import { agentTurnTimeoutMs, runAgentTurn } from "../../../lib/agent/runner";
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
 *   {"type":"truncated"}                         回答达到模型输出上限被截断（在 done 之前发）
 *   {"type":"done","stopped":true?,"timeout":true?,"messageId":123}  结束（回复已入库）
 *       stopped=true：本轮被中止（用户手动停止或回合总超时），已生成文字保留；
 *       timeout=true：本次中止由总超时（AGENT_TURN_TIMEOUT_MS，默认 180s）触发
 *   {"type":"error","message":"..."}             失败
 * custom 为用户自带 API（Anthropic 协议）配置：存于用户浏览器，随请求携带，服务端不落盘；
 * 官方 Key 未配置（演示模式）时忽略 custom。
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  /* 已登录用自己的账号；未登录的匿名访客每人一份身份，不再共用 anonymous */
  const account = resolveAgentAccount(cookies);
  if (!account) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  let message = "";
  let sessionId: number | undefined;
  let customRaw: unknown = undefined;
  let lectures: string[] | undefined;
  try {
    const body = (await request.json()) as { message?: unknown; sessionId?: unknown; custom?: unknown; lectures?: unknown };
    message = typeof body.message === "string" ? body.message.trim() : "";
    const sid = Number(body.sessionId);
    sessionId = Number.isFinite(sid) && sid > 0 ? sid : undefined;
    customRaw = body.custom;
    if (Array.isArray(body.lectures)) {
      lectures = body.lectures
        .filter((key): key is string => typeof key === "string" && /^(cumcm|mcm):\d+$/.test(key))
        .slice(0, 24);
    }
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
  if (sessionId && !sessionOwnedBy(account, sessionId)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
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
    logEvent("warn", "agent_rate_limited", { account, custom: Boolean(custom) });
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
      /* 兜底护栏：runner 内部已按 AGENT_TURN_TIMEOUT_MS 给整轮加超时并在到点 abort；
         若超时后仍极端悬挂（abort 未生效等），再宽限 15 秒后强制按 stopped 收尾，
         保证 SSE 一定关闭、前端输入框一定能恢复。 */
      let result: Awaited<ReturnType<typeof runAgentTurn>> | null = null;
      let failure: unknown = null;
      const turn = runAgentTurn({
        account,
        message,
        sessionId,
        lectures,
        ...(custom ? { runtime: getCustomRuntime(custom) } : {}),
        handlers: {
          onDelta: (text) => send({ type: "delta", text }),
          onThinking: (text) => send({ type: "thinking", text }),
          onTool: (name) => send({ type: "tool", name }),
          onCitations: (items) => send({ type: "citations", items }),
          onSession: (sessionId) => send({ type: "session", sessionId }),
          onUserMessage: (messageId) => send({ type: "user", messageId }),
        },
        signal: request.signal,
      }).then(
        (r) => {
          result = r;
        },
        (err) => {
          failure = err;
        },
      );
      await Promise.race([turn, new Promise((resolve) => setTimeout(resolve, agentTurnTimeoutMs() + 15_000))]);
      try {
        if (failure) {
          const err = failure as Error & { stack?: string };
          logEvent("error", "agent_turn_failed", {
            account,
            custom: Boolean(custom),
            message: err.message,
            stack: err.stack ?? "",
          });
          send({ type: "error", message: "出错了，请稍后重试。" });
        } else if (result) {
          if (result.error) {
            const err = result.error as Error & { stack?: string };
            logEvent("error", "agent_turn_failed", {
              account,
              custom: Boolean(custom),
              message: err.message,
              stack: err.stack ?? "",
            });
            send({ type: "error", message: "出错了，请稍后重试。" });
          } else {
            /* 截断提示：最终 assistant 消息以 max_tokens 类原因结束时先发 truncated，再 done */
            if (result.truncated) send({ type: "truncated" });
            if (result.stopped) {
              send({
                type: "done",
                stopped: true,
                ...(result.timedOut ? { timeout: true } : {}),
                messageId: result.assistantMessageId,
              });
            } else {
              send({ type: "done", messageId: result.assistantMessageId });
            }
          }
        } else {
          /* 极端悬挂：runner 超时 + 宽限期后仍未返回，按超时停止收尾并关闭连接 */
          logEvent("error", "agent_turn_hard_close", { account, custom: Boolean(custom) });
          send({ type: "done", stopped: true, timeout: true });
        }
      } finally {
        controller.close();
      }
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
