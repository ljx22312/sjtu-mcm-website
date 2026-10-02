/**
 * agent 的模型层：用 pi-ai 接智谱 BigModel 的 Anthropic 兼容端点。
 *
 * 正式模式：createProvider + anthropicMessagesApi，Key 从 AGENT_API_KEY 读取。
 * 演示模式：pi-ai 的 fauxProvider，返回脚本化回复（联调/测试用，不产生 API 调用）。
 *
 * 两种正式运行时：
 *  - 官方模型：进程级缓存，模型与思考深度由 data/agent-admin.json（管理员）控制；
 *  - 自带 API（BYOK）：用户在浏览器 localStorage 配置端点/Key/模型/深度，随请求携带，
 *    服务端不落盘；运行时按 baseUrl+model 缓存，Key 走请求级覆盖（options.apiKey）。
 */
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type AssistantMessage,
  type Model,
  type Models,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { agentApiKey, agentBaseUrl, agentMockAllowed } from "./config";
import { getAdminConfig, type ReasoningLevel } from "./admin";

const PROVIDER_ID = "zhipu";
const CUSTOM_PROVIDER_ID = "custom";

/** 可用模型清单（按智谱 Anthropic 兼容端点整理） */
const CATALOG: Model<"anthropic-messages">[] = [
  {
    id: "glm-4.6",
    name: "GLM-4.6",
    provider: PROVIDER_ID,
    baseUrl: agentBaseUrl,
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 8192,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
  },
  {
    id: "glm-4.5-air",
    name: "GLM-4.5-Air",
    provider: PROVIDER_ID,
    baseUrl: agentBaseUrl,
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 8192,
    input: ["text"],
    cost: { input: 0.5, output: 0.5, cacheRead: 0.05, cacheWrite: 0.5 },
  },
];

export interface AgentRuntime {
  models: Models;
  model: Model<any>;
  mode: "live" | "mock";
  /** 思考深度；undefined = 关闭思考 */
  reasoning?: ThinkingLevel;
  /** 请求级 API Key 覆盖（BYOK；官方运行时为 undefined，走进程环境 Key） */
  apiKey?: string;
  /** 演示模式下注入下一条脚本化回复；正式模式为 null */
  setMockResponse: ((reply: string) => void) | null;
}

/** 用户自带 API 配置（浏览器 localStorage 存放，随聊天请求携带） */
export interface CustomLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoning: ReasoningLevel;
}

function reasoningToThinking(level: ReasoningLevel): ThinkingLevel | undefined {
  return level === "off" ? undefined : (level as ThinkingLevel);
}

/* ---------- 官方模型运行时（模型/深度由管理配置决定） ---------- */

let officialCache: { modelId: string; runtime: AgentRuntime } | null = null;

export function getOfficialRuntime(): AgentRuntime {
  if (!agentApiKey) {
    const mock = getMockRuntime();
    return { ...mock, reasoning: reasoningToThinking(getAdminConfig().officialReasoning) };
  }
  const modelId = getAdminConfig().officialModel;
  if (officialCache && officialCache.modelId === modelId) return officialCache.runtime;

  const provider = createProvider({
    id: PROVIDER_ID,
    name: "智谱 BigModel（Anthropic 协议）",
    baseUrl: agentBaseUrl,
    auth: { apiKey: envApiKeyAuth("智谱 API Key", ["AGENT_API_KEY"]) },
    api: anthropicMessagesApi(),
    models: CATALOG,
  });
  const models = createModels();
  models.setProvider(provider);
  const model = CATALOG.find((m) => m.id === modelId) ?? CATALOG[0];
  const runtime: AgentRuntime = {
    models,
    model,
    mode: "live",
    reasoning: reasoningToThinking(getAdminConfig().officialReasoning),
    setMockResponse: null,
  };
  officialCache = { modelId: model.id, runtime };
  return runtime;
}

/* ---------- 自带 API 运行时（BYOK） ---------- */

const customCache = new Map<string, AgentRuntime>();
/** 缓存上限：超出后逐出最旧条目（防大量用户不同端点撑爆内存，重建成本很低） */
const CUSTOM_CACHE_MAX = 32;

export function getCustomRuntime(cfg: CustomLlmConfig): AgentRuntime {
  const key = `${cfg.baseUrl}|${cfg.model}`;
  const hit = customCache.get(key);
  if (hit) return { ...hit, apiKey: cfg.apiKey, reasoning: reasoningToThinking(cfg.reasoning) };

  const model: Model<"anthropic-messages"> = {
    id: cfg.model,
    name: cfg.model,
    provider: CUSTOM_PROVIDER_ID,
    baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
    reasoning: true,
    /* 未知模型按保守默认；深度思考预算由 pi-ai 在该上限内自动腾挪 */
    contextWindow: 128_000,
    maxTokens: 8192,
    input: ["text"],
    /* pi-ai 收到 usage 后会读 model.cost 计费，缺失会抛错；未知价格全记 0 */
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const provider = createProvider({
    id: CUSTOM_PROVIDER_ID,
    name: "自带 API（Anthropic 协议）",
    baseUrl: model.baseUrl,
    /* 请求级 apiKey 优先于环境解析；这里只是让 provider 可被解析，不读任何环境变量 */
    auth: { apiKey: envApiKeyAuth("自带 API Key", []) },
    api: anthropicMessagesApi(),
    models: [model],
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime: AgentRuntime = {
    models,
    model,
    mode: "live",
    reasoning: reasoningToThinking(cfg.reasoning),
    apiKey: cfg.apiKey,
    setMockResponse: null,
  };
  customCache.set(key, runtime);
  if (customCache.size > CUSTOM_CACHE_MAX) {
    customCache.delete(customCache.keys().next().value as string);
  }
  return { ...runtime, apiKey: cfg.apiKey, reasoning: reasoningToThinking(cfg.reasoning) };
}

/* ---------- 演示模式（未配置官方 Key 时） ---------- */

let mockCached: AgentRuntime | null = null;

function getMockRuntime(): AgentRuntime {
  if (mockCached) return mockCached;
  if (!agentMockAllowed) {
    throw new Error("agent 未配置 AGENT_API_KEY，且演示模式已关闭");
  }
  const faux = fauxProvider({ models: [{ id: "demo-model", name: "演示模型" }] });
  const models = createModels();
  models.setProvider(faux.provider);

  let scripted = "（演示模式）agent 尚未配置模型服务。";
  const setMockResponse = (reply: string) => {
    scripted = reply;
    faux.setResponses([
      (): AssistantMessage => fauxAssistantMessage([fauxText(scripted)]),
    ]);
  };
  setMockResponse(scripted);

  mockCached = { models, model: faux.getModel(), mode: "mock", setMockResponse };
  return mockCached;
}

/** 兼容旧调用（测试等）：官方运行时 */
export function getAgentRuntime(): AgentRuntime {
  return getOfficialRuntime();
}
