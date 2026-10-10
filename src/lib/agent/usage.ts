/**
 * 助手按用户的用量限制：账号 → 每窗口条数、禁用标记。
 *
 * 窗口规则（与 history.ts 的 windowUsage 配合）：从用户首条提问起算 windowMs 毫秒，
 * 窗口内最多 windowMessages 条，到期整窗恢复，下次提问再开新窗。不设每日上限。
 *
 * 存储：data/agent-limits.json（服务器本地文件，不进 git），按 mtime 缓存，改完即生效。
 * 覆盖值语义：null/缺省 = 跟随全局默认（AGENT_WINDOW_MESSAGES / AGENT_WINDOW_MINUTES）；
 *   正整数 = 该账号每窗口条数；0 = 禁止使用协会额度；-1 = 不限。
 * 禁用（blocked）针对整个助手，包括自带 API 的用户（他们的请求不再经由本站转发）。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentWindowMessages, agentWindowMinutes } from "./config";

export interface UserLimit {
  /** 每窗口条数覆盖；null 跟默认 */
  window?: number | null;
  /** 禁用助手 */
  blocked?: boolean;
  /** 管理员备注 */
  note?: string;
  updatedAt?: number;
}

export interface EffectiveLimits {
  windowMessages: number; // -1 不限，0 禁止，>0 条数
  windowMinutes: number; // 窗口时长（全局统一，不做按账号覆盖）
  blocked: boolean;
  overridden: boolean; // 是否存在本账号的覆盖项
}

function envPath(key: string, fallback: string): string {
  const v = process.env[key];
  if (!v) return fallback;
  return v.startsWith("/") ? v : resolve(process.cwd(), v);
}

export const agentLimitsPath = envPath("AGENT_LIMITS_CONFIG", join(process.cwd(), "data", "agent-limits.json"));

function normalizeInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  return n >= -1 && n <= 100000 ? n : null;
}

function normalizeLimit(raw: unknown): UserLimit {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: UserLimit = {};
  const window = normalizeInt(r.window);
  if (window !== null) out.window = window;
  if (r.blocked === true) out.blocked = true;
  if (typeof r.note === "string" && r.note.trim()) out.note = r.note.trim().slice(0, 200);
  if (typeof r.updatedAt === "number") out.updatedAt = r.updatedAt;
  return out;
}

let cached: { mtimeMs: number; limits: Record<string, UserLimit> } | null = null;

/** 全部覆盖项（账号 → 限额） */
export function getUserLimits(): Record<string, UserLimit> {
  try {
    const st = statSync(agentLimitsPath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.limits;
    const raw = JSON.parse(readFileSync(agentLimitsPath, "utf8")) as { users?: unknown };
    const limits: Record<string, UserLimit> = {};
    if (raw && typeof raw === "object" && typeof raw.users === "object" && raw.users !== null) {
      for (const [account, value] of Object.entries(raw.users as Record<string, unknown>)) {
        const limit = normalizeLimit(value);
        if (Object.keys(limit).length > 0) limits[account] = limit;
      }
    }
    cached = { mtimeMs: st.mtimeMs, limits };
    return limits;
  } catch {
    /* 文件不存在或损坏：无覆盖项，全部走默认 */
    return {};
  }
}

/** 某账号的生效限额：覆盖项合并全局默认 */
export function effectiveLimits(account: string): EffectiveLimits {
  const override = getUserLimits()[account] ?? {};
  return {
    windowMessages: override.window ?? agentWindowMessages,
    windowMinutes: agentWindowMinutes,
    blocked: Boolean(override.blocked),
    overridden: Boolean(getUserLimits()[account]),
  };
}

/** 写入/更新一个账号的覆盖项并落盘 */
export function setUserLimit(account: string, patch: UserLimit): UserLimit {
  const all = getUserLimits();
  const prev = all[account] ?? {};
  const next: UserLimit = {
    ...prev,
    ...(patch.window !== undefined ? { window: patch.window } : {}),
    ...(patch.blocked !== undefined ? { blocked: patch.blocked } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    updatedAt: Date.now(),
  };
  all[account] = next;
  persist(all);
  return next;
}

/** 删除一个账号的覆盖项（回到全局默认） */
export function clearUserLimit(account: string): boolean {
  const all = getUserLimits();
  if (!(account in all)) return false;
  delete all[account];
  persist(all);
  return true;
}

function persist(all: Record<string, UserLimit>): void {
  mkdirSync(dirname(agentLimitsPath), { recursive: true });
  const tmp = `${agentLimitsPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ users: all }, null, 2)}\n`, "utf8");
  renameSync(tmp, agentLimitsPath);
  cached = null;
}
