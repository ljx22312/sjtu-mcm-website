/**
 * 单轮对话的执行入口：装配 pi 的 Agent（每请求无状态），把事件桥接到 SSE，
 * 结束后把用户消息与回复文本写回 SQLite 历史。
 */
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { AGENT_CONTEXT_MESSAGES } from "./config";
import { appendMessage, listSessionMessages, type HistoryMessage } from "./history";
import { getOfficialRuntime, type AgentRuntime } from "./models";
import { buildSystemPrompt } from "./prompt";
import { lookupLectures } from "./lectures";
import { citationSnapshot, runWithScope } from "./scope";
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
  /** 工具给出的可点击出处 */
  onCitations?: (items: { n: number; title: string; locator: string; quote: string; url: string }[]) => void;
  /** 本轮用户消息的库内编号，供撤回 */
  onUserMessage?: (messageId: number) => void;
}

export interface AgentTurnResult {
  reply: string;
  /** 本轮消息归入的会话 id（前端恢复/续聊时使用） */
  sessionId: number;
  userMessageId?: number;
  assistantMessageId?: number;
  /** 用户中止了生成。已写出的文字仍入库。 */
  stopped?: boolean;
  error?: string;
}

/**
 * 把 SQLite 历史转成模型上下文：合并相邻同角色消息（上一轮失败可能留下连续 user）。
 * 重建的 assistant 消息必须带零值 usage —— pi-ai 的上下文估算会读取
 * assistant.usage.totalTokens，缺字段会抛 TypeError。
 */
/** 只保留「用户提问 + 紧随的助手回复」。半截、已撤回的不进上下文。 */
function completePairs(rows: HistoryMessage[]): HistoryMessage[] {
  const pairs: HistoryMessage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const next = rows[i + 1];
    if (cur.role === "user" && next?.role === "assistant") {
      pairs.push(cur, next);
      i += 1;
    }
  }
  return pairs.slice(-AGENT_CONTEXT_MESSAGES);
}

/** 同一身份同时只跑一轮。新的一轮会先停掉上一轮，再读上下文。 */
const turnChain = new Map<string, Promise<void>>();
const turnStop = new Map<string, AbortController>();

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a && b && typeof AbortSignal.any === "function") return AbortSignal.any([a, b]);
  return b ?? a;
}

/** 模型上下文取自当前会话里已完成的回合，跨会话内容不带入 */
function toContextMessages(account: string, sessionId?: number): Message[] {
  const rows = sessionId ? completePairs(listSessionMessages(account, sessionId)) : [];
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
  /** 续聊的会话。不传则新开一场，不并入上一场。 */
  sessionId?: number;
  /** 学生在知识库勾选的讲次，形如 cumcm:12。空则检索全库。 */
  lectures?: string[];
  /** 本轮使用的运行时；不传则用官方模型（管理员配置的模型/深度） */
  runtime?: AgentRuntime;
  signal?: AbortSignal;
}): Promise<AgentTurnResult> {
  turnStop.get(opts.account)?.abort();
  const stop = new AbortController();
  turnStop.set(opts.account, stop);
  const prev = turnChain.get(opts.account) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  turnChain.set(
    opts.account,
    prev.then(() => gate, () => gate),
  );
  await prev.catch(() => undefined);
  try {
    return await runAgentTurnBody({ ...opts, signal: combineSignals(opts.signal, stop.signal) });
  } finally {
    if (turnStop.get(opts.account) === stop) turnStop.delete(opts.account);
    release();
  }
}

async function runAgentTurnBody(opts: {
  account: string;
  message: string;
  handlers: AgentTurnHandlers;
  sessionId?: number;
  lectures?: string[];
  runtime?: AgentRuntime;
  signal?: AbortSignal;
}): Promise<AgentTurnResult> {
  const { account, message, handlers, sessionId, signal } = opts;

  const runtime = opts.runtime ?? getOfficialRuntime();
  if (runtime.mode === "mock" && runtime.setMockResponse) runtime.setMockResponse(mockReply(message));
  const lectureLabels = lookupLectures(opts.lectures ?? []).map((item) => item.label);

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(lectureLabels),
      model: runtime.model,
      tools: agentTools,
      messages: toContextMessages(account, sessionId) as AgentMessage[],
    },
    streamFn: (model, context, options) =>
      runtime.models.streamSimple(model, context, {
        ...options,
        /* 思考深度：官方用户由管理配置决定，自带 API 用户由自己决定；
           reasoning 为 undefined 时 pi-ai 不请求思考（更快更省） */
        ...(runtime.reasoning ? { reasoning: runtime.reasoning } : {}),
        /* 自带 API：请求级 Key 覆盖（官方运行时为 undefined，走进程环境 Key） */
        ...(runtime.apiKey ? { apiKey: runtime.apiKey } : {}),
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
    } else if (event.type === "tool_execution_end") {
      const cites = citationSnapshot();
      if (cites.length > 0) handlers.onCitations?.(cites);
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

  // 用户消息先落库（撤回后仍保留），并确定本场会话 id
  let streamed = "";
  const userRow = appendMessage(account, "user", message, undefined, sessionId);
  const sid = userRow.sessionId;
  handlers.onSession?.(sid);
  handlers.onUserMessage?.(userRow.messageId);

  const originalOnDelta = handlers.onDelta;
  handlers.onDelta = (text) => {
    streamed += text;
    originalOnDelta(text);
  };

  let stopped = false;
  try {
    await runWithScope(opts.lectures?.length ? opts.lectures : null, () => agent.prompt(message));
  } catch (err) {
    if (signal?.aborted) stopped = true;
    else return { reply: "", sessionId: sid, userMessageId: userRow.messageId, error: err instanceof Error ? err.message : "agent 执行异常" };
  }
  if (signal?.aborted) stopped = true;

  const msgs = agent.state.messages;
  const lastAssistant = [...msgs].reverse().find((m) => (m as Message).role === "assistant") as Message | undefined;
  const modelText = lastAssistant ? contentText(lastAssistant.content) : "";

  if (!stopped && agent.state.errorMessage) {
    return { reply: "", sessionId: sid, userMessageId: userRow.messageId, error: agent.state.errorMessage };
  }
  const reply = (stopped ? streamed || modelText : modelText || streamed).trim();
  if (!stopped && lastAssistant?.stopReason === "error") {
    return { reply: "", sessionId: sid, userMessageId: userRow.messageId, error: "模型调用失败，请稍后重试" };
  }
  if (!reply) {
    if (!stopped) return { reply: "", sessionId: sid, userMessageId: userRow.messageId, error: "模型返回为空，请稍后重试" };
  }

  const stored = reply || "（已停止）";
  const assistantRow = appendMessage(account, "assistant", stored, thinking, sid);
  return {
    reply: stored,
    sessionId: sid,
    userMessageId: userRow.messageId,
    assistantMessageId: assistantRow.messageId,
    stopped,
  };
}
