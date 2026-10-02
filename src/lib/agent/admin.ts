/**
 * 官方模型运行参数的管理控制台：data/agent-admin.json（服务器本地文件，不在 git 内）。
 *
 * 使用官方提供模型的用户，其模型与思考深度完全由此文件决定，前端不暴露任何调节入口；
 * 管理员账号（此文件 admins 字段或 AGENT_ADMIN_ACCOUNTS 环境变量）额外能在面板里
 * 看到官方模型的当前参数并即时调整（写回此文件）。
 *
 * 文件结构（均可省略，省略时回退 .env / 代码默认值）：
 * {
 *   "officialModel": "glm-4.6",          // 官方用户使用的模型 id
 *   "officialReasoning": "medium",        // 官方用户思考深度：off|minimal|low|medium|high
 *   "admins": ["alice", "bob"]            // 管理员 jAccount 账号
 * }
 *
 * 读取按 mtime 缓存，改文件即生效，无需重启进程。
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { agentAdminAccounts, agentAdminConfigPath, agentModelId } from "./config";

export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high";

export const REASONING_LEVELS: { value: ReasoningLevel; label: string }[] = [
  { value: "off", label: "关闭思考" },
  { value: "minimal", label: "极浅" },
  { value: "low", label: "快速" },
  { value: "medium", label: "标准" },
  { value: "high", label: "深度" },
];

export interface AdminConfig {
  officialModel: string;
  officialReasoning: ReasoningLevel;
  admins: string[];
}

let cached: { mtimeMs: number; config: AdminConfig } | null = null;

function normalizeReasoning(v: unknown): ReasoningLevel {
  return REASONING_LEVELS.some((r) => r.value === v) ? (v as ReasoningLevel) : "medium";
}

/** 读取管理配置（mtime 变化时重读；文件缺失/损坏时回退默认值） */
export function getAdminConfig(): AdminConfig {
  try {
    const st = statSync(agentAdminConfigPath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.config;
    const raw = JSON.parse(readFileSync(agentAdminConfigPath, "utf8")) as Record<string, unknown>;
    const config: AdminConfig = {
      officialModel: typeof raw.officialModel === "string" && raw.officialModel ? raw.officialModel : agentModelId,
      officialReasoning: normalizeReasoning(raw.officialReasoning),
      admins: Array.isArray(raw.admins)
        ? raw.admins.filter((a): a is string => typeof a === "string" && a.length > 0)
        : [],
    };
    cached = { mtimeMs: st.mtimeMs, config };
    return config;
  } catch {
    /* 文件不存在或 JSON 损坏：回退 .env 模型 + medium，管理员仅来自环境变量 */
    return { officialModel: agentModelId, officialReasoning: "medium", admins: [] };
  }
}

/** 是否管理员（agent-admin.json admins ∪ AGENT_ADMIN_ACCOUNTS） */
export function isAdminAccount(account: string): boolean {
  return agentAdminAccounts.includes(account) || getAdminConfig().admins.includes(account);
}

/** 管理员写回配置（原子写：临时文件 + rename 由 writeFileSync 简化为直接写，单进程足够） */
export function saveAdminConfig(patch: { officialModel?: string; officialReasoning?: ReasoningLevel }): AdminConfig {
  const current = getAdminConfig();
  const next: AdminConfig = {
    ...current,
    officialModel: patch.officialModel ?? current.officialModel,
    officialReasoning: patch.officialReasoning ?? current.officialReasoning,
  };
  writeFileSync(agentAdminConfigPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  cached = null; // 立即失效缓存（mtime 精度问题兜底）
  return getAdminConfig();
}
