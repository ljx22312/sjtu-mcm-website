/**
 * 网页导览 agent 的环境变量解析（风格对齐 src/lib/auth.ts）。
 *
 * 环境变量：
 *   AGENT_API_KEY    智谱 BigModel API Key（配置后进入正式模式）
 *   AGENT_BASE_URL   Anthropic 兼容端点，默认 https://open.bigmodel.cn/api/anthropic
 *   AGENT_MODEL      模型 id，默认 glm-4.6（可选 glm-4.5-air）
 *   AGENT_ALLOW_MOCK 配置正式 Key 后是否仍允许演示模式（默认否；未配置 Key 时自动演示）
 *   AGENT_ALLOW_ANONYMOUS  设为 1 时未登录也可使用 agent（内测期临时开关；匿名访客共用 "anonymous" 身份与历史）
 *   AGENT_RATE_LIMIT 每用户每小时可发送的消息数，默认 20
 *   AGENT_HISTORY_DB        SQLite 历史库路径，默认 <项目根>/data/agent-history.db
 *   AGENT_HISTORY_RETENTION_DAYS 对话记录保留天数，默认 180
 */

/* 独立 node 运行时只有 process.env；astro dev/build 下 import.meta.env 也可用 */
function env(key: string): string {
  const p = (globalThis as any).process?.env;
  const v = p?.[key] ?? (import.meta as any).env?.[key];
  return typeof v === "string" ? v : "";
}

function envInt(key: string, fallback: number): number {
  const n = Number.parseInt(env(key), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const agentApiKey = env("AGENT_API_KEY");
export const agentBaseUrl = env("AGENT_BASE_URL") || "https://open.bigmodel.cn/api/anthropic";
export const agentModelId = env("AGENT_MODEL") || "glm-4.6";
/** 正式 LLM 凭据是否已配置 */
export const agentConfigured = Boolean(agentApiKey);
/** 是否提供演示模式（与 jAccount 演示登录同一策略：未配置自动开启，配置后需显式允许） */
export const agentMockAllowed = !agentConfigured || env("AGENT_ALLOW_MOCK") === "1";
/** 内测期是否允许未登录使用（匿名共用同一份历史；正式部署保持关闭，回到 jAccount 登录门槛） */
export const agentAllowAnonymous = env("AGENT_ALLOW_ANONYMOUS") === "1";
/** 每用户每小时的聊天消息上限 */
export const agentRateLimitPerHour = envInt("AGENT_RATE_LIMIT", 20);
/** 单条消息长度上限（字符） */
export const AGENT_MAX_MESSAGE_CHARS = 2000;
/** 每次请求携带的历史消息条数上限 */
export const AGENT_CONTEXT_MESSAGES = 24;
/** 对话记录保留天数 */
export const agentHistoryRetentionDays = envInt("AGENT_HISTORY_RETENTION_DAYS", 180);

import { join, resolve } from "node:path";
function envPath(key: string, fallback: string): string {
  const v = env(key);
  if (!v) return fallback;
  return v.startsWith("/") ? v : resolve(process.cwd(), v);
}

/** SQLite 历史库文件路径 */
export const agentHistoryDbPath = envPath("AGENT_HISTORY_DB", join(process.cwd(), "data", "agent-history.db"));
