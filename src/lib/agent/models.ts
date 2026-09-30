/**
 * agent 的模型层：用 pi-ai 接智谱 BigModel 的 Anthropic 兼容端点。
 *
 * 正式模式：createProvider + anthropicMessagesApi，Key 从 AGENT_API_KEY 读取。
 * 演示模式：pi-ai 的 fauxProvider，返回脚本化回复（联调/测试用，不产生 API 调用）。
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
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { agentApiKey, agentBaseUrl, agentModelId, agentMockAllowed } from "./config";

const PROVIDER_ID = "zhipu";

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
  /** 演示模式下注入下一条脚本化回复；正式模式为 null */
  setMockResponse: ((reply: string) => void) | null;
}

let cached: AgentRuntime | null = null;

/** 构建进程级单例的模型运行时 */
export function getAgentRuntime(): AgentRuntime {
  if (cached) return cached;

  if (agentApiKey) {
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
    const model = models.getModel(PROVIDER_ID, agentModelId) ?? CATALOG[0];
    cached = { models, model, mode: "live", setMockResponse: null };
    return cached;
  }

  if (!agentMockAllowed) {
    throw new Error("agent 未配置 AGENT_API_KEY，且演示模式已关闭");
  }

  // 演示模式：faux provider 不发真实请求，回复由 setMockResponse 注入
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

  cached = { models, model: faux.getModel(), mode: "mock", setMockResponse };
  return cached;
}
