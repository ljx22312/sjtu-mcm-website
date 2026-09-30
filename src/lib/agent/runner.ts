/**
 * 单轮对话的执行入口：装配 pi 的 Agent（每请求无状态），把事件桥接到 SSE，
 * 结束后把用户消息与回复文本写回 SQLite 历史。
 */
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { AGENT_CONTEXT_MESSAGES } from "./config";
import { appendMessage, listSessionMessages } from "./history";
import { getAgentRuntime } from "./models";
import { buildSystemPrompt } from "./prompt";
import { agentTools } from "./tools";

export interface AgentTurnHandlers {
  /** 助手回复的增量文本 */
  onDelta: (text: string) => void;
  /** 思考过程的增量文本（glm-4.6 深度思考流） */
  onThinking: (text: string) => void;
  /** 工具开始执行（用于前端展示“正在检索…”） */
  onTool: (name: string) => void;
  /** 用户消息落库后立刻回调本场会话 id（前端据此把消息归场） */
  onSession?: (sessionId: number) => void;
}

export interface AgentTurnResult {
  reply: string;
  /** 本轮消息归入的会话 id（前端恢复/续聊时使用） */
  sessionId: number;
  error?: string;
}

/**
 * 把 SQLite 历史转成模型上下文：合并相邻同角色消息（上一轮失败可能留下连续 user）。
 * 重建的 assistant 消息必须带零值 usage —— pi-ai 的上下文估算会读取
 * assistant.usage.totalTokens，缺字段会抛 TypeError。
 */
/** 模型上下文取自当前会话（恢复的那场对话），跨会话内容不带入 */
function toContextMessages(account: string, sessionId?: number): Message[] {
  const rows = sessionId ? listSessionMessages(account, sessionId) : [];
  const merged: Message[] = [];
  for (const r of rows) {
    const last = merged[merged.length - 1];
    if (last && last.role === r.role && last.role !== "assistant") {
      (last.content[0] as { text: string }).text += `\n\n${r.content}`;
    } else if (r.role === "assistant") {
      merged.push({
        role: "assistant",
        content: [{ type: "text", text: r.content }],
        timestamp: r.created_at,
        stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      } as Message);
    } else {
      merged.push({ role: r.role, content: [{ type: "text", text: r.content }], timestamp: r.created_at });
    }
  }
  return merged;
}

function mockReply(question: string): string {
  const brief = question.length > 60 ? question.slice(0, 60) + "…" : question;
  return `（演示模式）已收到你的消息：「${brief}」。\n\n当前尚未接入模型服务（AGENT_API_KEY 未配置），这只是联调用回复；正式配置后我可以在这里回答协会、集训课程、资料与回放的查找问题。`;
}

export async function runAgentTurn(opts: {
  account: string;
  message: string;
  handlers: AgentTurnHandlers;
  /** 续聊的会话；不传则由存储层决定（近期活跃则续，间隔超时则新开） */
  sessionId?: number;
  signal?: AbortSignal;
}): Promise<AgentTurnResult> {
  const { account, message, handlers, sessionId, signal } = opts;

  const runtime = getAgentRuntime();
  if (runtime.mode === "mock" && runtime.setMockResponse) runtime.setMockResponse(mockReply(message));

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(),
      model: runtime.model,
      tools: agentTools,
      messages: toContextMessages(account, sessionId) as AgentMessage[],
    },
    streamFn: (model, context, options) =>
      runtime.models.streamSimple(model, context, {
        ...options,
        /* 开启思考流：glm-4.6 经 Anthropic 兼容端点返回 thinking 增量 */
        reasoning: "medium",
      }),
  });

  let thinking = "";
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      handlers.onDelta(event.assistantMessageEvent.delta);
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      thinking += event.assistantMessageEvent.delta;
      handlers.onThinking(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      handlers.onTool(event.toolName);
    }
  });

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        agent.abort();
      },
      { once: true },
    );
  }

  // 用户消息先落库（即使本轮失败，用户的提问也保留在历史里），并确定本场会话 id
  const sid = appendMessage(account, "user", message, undefined, sessionId);
  handlers.onSession?.(sid);

  try {
    await agent.prompt(message);
  } catch (err) {
    return { reply: "", sessionId: sid, error: err instanceof Error ? err.message : "agent 执行异常" };
  }

  const msgs = agent.state.messages;
  const lastAssistant = [...msgs].reverse().find((m) => (m as Message).role === "assistant") as Message | undefined;

  if (agent.state.errorMessage) {
    return { reply: "", sessionId: sid, error: agent.state.errorMessage };
  }
  const reply = lastAssistant ? contentText(lastAssistant.content) : "";
  if (lastAssistant?.stopReason === "error") {
    return { reply: "", sessionId: sid, error: "模型调用失败，请稍后重试" };
  }
  if (!reply.trim()) {
    return { reply: "", sessionId: sid, error: "模型返回为空，请稍后重试" };
  }

  appendMessage(account, "assistant", reply, thinking, sid);
  return { reply, sessionId: sid };
}
