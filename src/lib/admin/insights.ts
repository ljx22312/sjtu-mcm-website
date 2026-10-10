/**
 * 管理端数据聚合：把日志文件（logs/app-*.log）、jAccount 资料缓存、助手用量库
 * 汇成仪表盘所需的「今日概览 / 登录记录 / 用户总览 / 最近错误」。
 *
 * 只在服务端（SSR 管理页 / 管理 API）引用。日志文件很小（按天分文件，保留期由
 * 运维决定），每次请求全量读入并在内存过滤即可，不值得做缓存。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProfiles } from "../profiles";
import { accountUsageOverview } from "../agent/history";
import { jaccountConfigured } from "../auth";
import { agentConfigured } from "../agent/config";

const LOG_DIR = process.env.LOG_DIR ?? join(process.cwd(), "logs");

export interface LogEvent {
  t: string; // ISO 时间
  level: string;
  event: string;
  [key: string]: unknown;
}

/** 读全部服务端日志事件，新→旧排序。目录缺失或行损坏时静默跳过。 */
export function readAppEvents(): LogEvent[] {
  const out: LogEvent[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(LOG_DIR).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    let raw = "";
    try {
      raw = readFileSync(join(LOG_DIR, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const e = JSON.parse(s) as LogEvent;
        if (e && typeof e.event === "string" && typeof e.t === "string") out.push(e);
      } catch {
        /* 单行损坏不影响其余 */
      }
    }
  }
  return out.sort((a, b) => (a.t < b.t ? 1 : -1));
}

export interface LoginRecord {
  t: string;
  account: string;
  name: string;
  code: string;
  type: string;
}

export interface UserRow {
  account: string;
  name: string;
  code: string;
  type: string;
  lastLoginAt: number; // 毫秒；0 表示资料表缺时间
  agentToday: number;
  agentTotal: number;
}

export interface DashboardInsights {
  today: {
    loginCount: number;
    loginUnique: number;
    agentQuestions: number;
    rateLimited: number;
    blockedAttempts: number;
    errors: number;
  };
  logins: LoginRecord[];
  users: UserRow[];
  recentErrors: { t: string; event: string; message: string }[];
  logCoverageFrom: string; // 日志里最早的事件时间（ISO；空串=无日志）
  service: {
    uptimeSec: number;
    rssMB: number;
    nodeVersion: string;
    jaccountConfigured: boolean;
    agentConfigured: boolean;
    nowIso: string;
  };
}

export function getDashboardInsights(loginLimit = 30, errorLimit = 10): DashboardInsights {  const events = readAppEvents();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayStartIso = dayStart.toISOString();

  const isToday = (e: LogEvent) => e.t >= dayStartIso;
  const str = (e: LogEvent, key: string) => (typeof e[key] === "string" ? (e[key] as string) : "");

  const loginsAll: LoginRecord[] = events
    .filter((e) => e.event === "login_success")
    .map((e) => ({ t: e.t, account: str(e, "account"), name: str(e, "name"), code: str(e, "code"), type: str(e, "type") }));
  const todayLogins = loginsAll.filter((l) => l.t >= dayStartIso);

  const usage = accountUsageOverview();
  const usageMap = new Map(usage.map((u) => [u.account, u]));
  const profiles = getProfiles();

  /* 用户总览 = 资料表 ∪ 助手用量里出现过但资料表缺失的账号 */
  const accounts = [...new Set([...Object.keys(profiles), ...usageMap.keys()])];
  const users: UserRow[] = accounts
    .map((account) => {
      const p = profiles[account];
      const u = usageMap.get(account);
      return {
        account,
        name: p?.name ?? "",
        code: p?.code ?? "",
        type: p?.type ?? "",
        lastLoginAt: p?.t ?? 0,
        agentToday: u?.today ?? 0,
        agentTotal: u?.total ?? 0,
      };
    })
    .sort((a, b) => b.lastLoginAt - a.lastLoginAt);

  const memory = process.memoryUsage();

  return {
    today: {
      loginCount: todayLogins.length,
      loginUnique: new Set(todayLogins.map((l) => l.account)).size,
      agentQuestions: usage.reduce((sum, u) => sum + u.today, 0),
      rateLimited: events.filter((e) => e.event === "agent_rate_limited" && isToday(e)).length,
      blockedAttempts: events.filter((e) => e.event === "agent_blocked_attempt" && isToday(e)).length,
      errors: events.filter((e) => e.level === "error" && isToday(e)).length,
    },
    logins: loginsAll.slice(0, loginLimit),
    users,
    recentErrors: events
      .filter((e) => e.level === "error")
      .slice(0, errorLimit)
      .map((e) => {
        const m = typeof e.message === "string" ? e.message : typeof e.msg === "string" ? e.msg : "";
        return { t: e.t, event: e.event, message: m.length > 160 ? `${m.slice(0, 160)}…` : m };
      }),
    logCoverageFrom: events.length > 0 ? events[events.length - 1].t : "",
    service: {
      uptimeSec: Math.floor(process.uptime()),
      rssMB: Math.round(memory.rss / 1024 / 1024),
      nodeVersion: process.version,
      jaccountConfigured,
      agentConfigured,
      nowIso: new Date().toISOString(),
    },
  };
}

/* ---------------- 审计流水 ---------------- */

/** 需要进审计时间线的敏感操作（管理员主动改动，区别于用户自己的使用行为） */
const AUDIT_EVENTS: Record<string, string> = {
  site_admin_added: "添加网站管理员",
  site_admin_removed: "移除网站管理员",
  agent_limit_set: "调整助手限额",
  agent_limit_cleared: "清除助手限额",
  agent_session_retracted_by_admin: "撤回用户会话",
};

export interface AuditEntry {
  t: string;
  actor: string;
  actorName: string;
  action: string; // 事件名
  label: string; // 中文操作名
  target: string; // 目标账号（可空）
  targetName: string;
  detail: string; // 参数摘要
}

/** 审计时间线（新→旧）：管理员增删、限额调整、会话处置。来源同登录记录。 */
export function getAuditTrail(limit = 100): AuditEntry[] {
  const profiles = getProfiles();
  const nameOf = (a: string) => profiles[a]?.name ?? "";
  const str = (e: LogEvent, key: string) => (typeof e[key] === "string" ? (e[key] as string) : "");
  const num = (e: LogEvent, key: string) => (typeof e[key] === "number" ? (e[key] as number) : null);

  return readAppEvents()
    .filter((e) => AUDIT_EVENTS[e.event])
    .slice(0, limit)
    .map((e) => {
      const parts: string[] = [];
      if (e.event === "agent_limit_set") {
        if (typeof e.window === "number") parts.push(`每窗口 ${e.window} 条`);
        if (typeof e.hourly === "number") parts.push(`每小时 ${e.hourly} 条`);
        if (typeof e.daily === "number") parts.push(`每日 ${e.daily} 条`);
        if (e.blocked === true) parts.push("禁用");
        if (e.blocked === false) parts.push("解除禁用");
        if (typeof e.note === "string" && e.note) parts.push(`备注「${e.note}」`);
      }
      if (e.event === "agent_session_retracted_by_admin") {
        const n = num(e, "messages");
        if (n !== null) parts.push(`隐藏 ${n} 条消息`);
        const sid = num(e, "sessionId");
        if (sid !== null) parts.push(`会话 #${sid}`);
      }
      return {
        t: e.t,
        actor: str(e, "actor"),
        actorName: nameOf(str(e, "actor")),
        action: e.event,
        label: AUDIT_EVENTS[e.event],
        target: str(e, "account"),
        targetName: nameOf(str(e, "account")),
        detail: parts.join(" · "),
      };
    });
}
