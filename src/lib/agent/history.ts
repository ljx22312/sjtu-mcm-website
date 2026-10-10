/**
 * 按用户保存 agent 对话历史（纯文字），按「会话」分组。
 *
 * 存储：单文件 SQLite（better-sqlite3，WAL 模式），路径见 config.agentHistoryDbPath。
 * 表结构存 account + session_id + 角色 + 内容 + 思考 + 时间戳，不落姓名等额外身份信息。
 * 旧库升级：无 session_id 的存量行按 30 分钟会话间隔回填分组。
 * 保留期：默认 180 天，写入时低概率惰性清理（pruneExpired）。
 */
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { agentHistoryDbPath, agentHistoryRetentionDays } from "./config";

export interface HistoryMessage {
  id: number;
  session_id: number;
  role: "user" | "assistant";
  content: string;
  /** assistant 消息的思考过程（开启思考流后随回复一起存档，恢复对话时可见） */
  thinking?: string | null;
  created_at: number;
  /** 1 赞，-1 踩，0 或空表示没有表态 */
  vote?: number | null;
}

export interface SessionSummary {
  session_id: number;
  /** 首条用户消息摘要（列表展示用） */
  title: string;
  message_count: number;
  started_at: number;
  last_active_at: number;
}

let db: Database.Database | null = null;

/** 存量数据回填分组：超过该间隔（毫秒）没新消息即视为新会话 */
const SESSION_GAP_MS = 30 * 60 * 1000;

function open(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(agentHistoryDbPath), { recursive: true });
  db = new Database(agentHistoryDbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_account_id ON messages (account, id);
  `);
  const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "thinking")) {
    db.exec("ALTER TABLE messages ADD COLUMN thinking TEXT");
  }
  if (!cols.some((c) => c.name === "session_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN session_id INTEGER");
    backfillSessions();
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (account, session_id, id)");
  }
  const colsNow = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!colsNow.some((c) => c.name === "retracted")) {
    db.exec("ALTER TABLE messages ADD COLUMN retracted INTEGER NOT NULL DEFAULT 0");
  }
  if (!colsNow.some((c) => c.name === "custom")) {
    db.exec("ALTER TABLE messages ADD COLUMN custom INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_alloc (
      id INTEGER PRIMARY KEY,
      account TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      vote INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

/** 给无 session_id 的存量行按时间间隔分组回填 */
function backfillSessions(): void {
  const rows = db!
    .prepare("SELECT id, created_at FROM messages WHERE session_id IS NULL ORDER BY id")
    .all() as { id: number; created_at: number }[];
  if (rows.length === 0) return;
  const maxSession = (
    db!.prepare("SELECT COALESCE(MAX(session_id), 0) AS m FROM messages").get() as { m: number }
  ).m;
  const update = db!.prepare("UPDATE messages SET session_id = ? WHERE id = ?");
  let sid = maxSession;
  let prevTs = 0;
  const tx = db!.transaction(() => {
    for (const r of rows) {
      if (prevTs === 0 || r.created_at - prevTs > SESSION_GAP_MS) sid += 1;
      update.run(sid, r.id);
      prevTs = r.created_at;
    }
  });
  tx();
}

export interface AppendedMessage {
  sessionId: number;
  messageId: number;
}

/** 新开一场会话，不并入最近 30 分钟里的上一场。 */
export function beginSession(account: string): number {
  const d = open();
  return d.transaction(() => {
    const row = d
      .prepare(
        `SELECT COALESCE(MAX(n), 0) + 1 AS n FROM (
           SELECT MAX(session_id) AS n FROM messages
           UNION ALL
           SELECT MAX(id) FROM session_alloc
         )`,
      )
      .get() as { n: number };
    d.prepare("INSERT INTO session_alloc (id, account, created_at) VALUES (?, ?, ?)").run(row.n, account, Date.now());
    return row.n;
  })();
}

/** 这场会话是否属于该身份。空编号不算。别人的编号不算。 */
export function sessionOwnedBy(account: string, sessionId: number): boolean {
  const d = open();
  const alloc = d.prepare("SELECT account FROM session_alloc WHERE id = ?").get(sessionId) as
    | { account: string }
    | undefined;
  if (alloc) return alloc.account === account;
  const msg = d.prepare("SELECT account FROM messages WHERE session_id = ? LIMIT 1").get(sessionId) as
    | { account: string }
    | undefined;
  return Boolean(msg && msg.account === account);
}

/** 追加一条消息。未指定会话时新开一场，不再按 30 分钟自动续进上一场。custom=1 表示自带 API 的用量，不计协会额度。 */
export function appendMessage(
  account: string,
  role: "user" | "assistant",
  content: string,
  thinking?: string,
  sessionId?: number,
  custom?: boolean,
): AppendedMessage {
  const d = open();
  const sid = sessionId && sessionOwnedBy(account, sessionId) ? sessionId : beginSession(account);
  const info = d
    .prepare(
      "INSERT INTO messages (account, role, content, thinking, session_id, created_at, retracted, custom) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    )
    .run(account, role, content, thinking?.trim() ? thinking : null, sid, Date.now(), custom ? 1 : 0);
  return { sessionId: sid, messageId: Number(info.lastInsertRowid) };
}

/**
 * 撤回一轮：标记这条用户消息和紧随的助手回复，使它们离开界面和模型上下文。
 * 行仍留在库里。传入助手消息编号时，撤回它前面那条用户消息组成的一轮。
 */
export function retractTurn(account: string, messageId: number): boolean {
  const d = open();
  const msg = d
    .prepare("SELECT id, session_id, role FROM messages WHERE id = ? AND account = ?")
    .get(messageId, account) as { id: number; session_id: number; role: string } | undefined;
  if (!msg) return false;
  let userId = msg.id;
  if (msg.role === "assistant") {
    const prev = d
      .prepare(
        "SELECT id, role FROM messages WHERE account = ? AND session_id = ? AND id < ? AND retracted = 0 ORDER BY id DESC LIMIT 1",
      )
      .get(account, msg.session_id, msg.id) as { id: number; role: string } | undefined;
    if (prev?.role === "user") userId = prev.id;
    else {
      d.prepare("UPDATE messages SET retracted = 1 WHERE id = ? AND account = ?").run(msg.id, account);
      return true;
    }
  } else if (msg.role !== "user") {
    return false;
  }
  const next = d
    .prepare(
      "SELECT id, role FROM messages WHERE account = ? AND session_id = ? AND id > ? AND retracted = 0 ORDER BY id LIMIT 1",
    )
    .get(account, msg.session_id, userId) as { id: number; role: string } | undefined;
  const ids = [userId];
  if (next?.role === "assistant") ids.push(next.id);
  const mark = d.prepare("UPDATE messages SET retracted = 1 WHERE id = ? AND account = ?");
  const tx = d.transaction(() => {
    for (const id of ids) mark.run(id, account);
  });
  tx();
  return true;
}

/** 某用户全部会话（按最近活跃倒序），含首条用户消息作标题 */
export function listSessions(account: string, limit = 30): SessionSummary[] {
  return open()
    .prepare(
      `SELECT s.session_id,
              COALESCE((SELECT substr(content, 1, 40) FROM messages m2
                        WHERE m2.account = s.account AND m2.session_id = s.session_id AND m2.role = 'user' AND m2.retracted = 0
                        ORDER BY m2.id LIMIT 1), '(无提问)') AS title,
              COUNT(*) AS message_count,
              MIN(created_at) AS started_at,
              MAX(created_at) AS last_active_at
       FROM messages s
       WHERE s.account = ? AND s.retracted = 0
       GROUP BY s.session_id
       ORDER BY last_active_at DESC
       LIMIT ?`,
    )
    .all(account, limit) as SessionSummary[];
}

/** 某会话的全部消息（时间正序） */
export function listSessionMessages(account: string, sessionId: number): HistoryMessage[] {
  return open()
    .prepare(
      `SELECT id, session_id, role, content, thinking, created_at,
              (SELECT vote FROM message_feedback f
                WHERE f.account = messages.account AND f.message_id = messages.id
                ORDER BY f.id DESC LIMIT 1) AS vote
       FROM messages WHERE account = ? AND session_id = ? AND retracted = 0 ORDER BY id`,
    )
    .all(account, sessionId) as HistoryMessage[];
}

/** 兼容旧接口：某用户最近 limit 条消息（跨会话拼接，时间正序） */
export function listRecent(account: string, limit = 50): HistoryMessage[] {
  const rows = open()
    .prepare(
      "SELECT id, session_id, role, content, thinking, created_at FROM messages WHERE account = ? AND retracted = 0 ORDER BY id DESC LIMIT ?",
    )
    .all(account, limit) as HistoryMessage[];
  return rows.reverse();
}

/** 某身份自 sinceMs 以来的协会额度提问条数（含已撤回；自带 API 的不计） */
export function countUserMessages(account: string, sinceMs: number): number {
  const row = open()
    .prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE account = ? AND role = 'user' AND created_at > ? AND custom = 0",
    )
    .get(account, sinceMs) as { c: number };
  return row.c;
}

export interface WindowUsage {
  /** 当前窗口内已用条数；窗口已过期或从未使用时为 0 */
  used: number;
  /** 当前窗口起点（首条提问时间）；无进行中窗口时为 null */
  windowStart: number | null;
  /** 窗口到期时间（windowStart + windowMs）；无进行中窗口时为 null */
  resetsAt: number | null;
}

/**
 * 5 小时固定窗口用量：窗口从首条提问起算，窗口内消息计入同一窗，到期整窗恢复，
 * 下一条提问再开新窗。按时间正序链式判定：消息距当前窗口起点不足 windowMs 则同窗，
 * 否则它自己开新窗。
 */
export function windowUsage(account: string, windowMs: number): WindowUsage {
  const rows = open()
    .prepare(
      "SELECT created_at FROM messages WHERE account = ? AND role = 'user' AND custom = 0 ORDER BY id",
    )
    .all(account) as { created_at: number }[];
  let start: number | null = null;
  let used = 0;
  for (const r of rows) {
    if (start === null || r.created_at >= start + windowMs) {
      start = r.created_at;
      used = 1;
    } else {
      used += 1;
    }
  }
  if (start !== null && Date.now() >= start + windowMs) {
    return { used: 0, windowStart: null, resetsAt: null };
  }
  return { used, windowStart: start, resetsAt: start === null ? null : start + windowMs };
}

export interface AccountUsage {
  account: string;
  h1: number; // 最近一小时提问
  today: number; // 今日（服务器本地时区零点起）提问
  total: number; // 累计提问
  sessions: number; // 会话数
  lastActiveAt: number; // 最后活跃（毫秒）
}

/** 全部账号的用量一览（管理端用，只统计协会额度）。 */
export function accountUsageOverview(): AccountUsage[] {
  const d = open();
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const rows = d
    .prepare(
      `SELECT account,
              SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS h1,
              SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS today,
              COUNT(*) AS total,
              MAX(created_at) AS lastActiveAt
       FROM messages WHERE role = 'user' AND custom = 0 GROUP BY account`,
    )
    .all(now - 3600_000, todayStart.getTime()) as {
    account: string;
    h1: number;
    today: number;
    total: number;
    lastActiveAt: number;
  }[];
  const sessions = d
    .prepare("SELECT account, COUNT(DISTINCT session_id) AS c FROM messages GROUP BY account")
    .all() as { account: string; c: number }[];
  const sessionMap = new Map(sessions.map((r) => [r.account, r.c]));
  return rows
    .map((r) => ({
      account: r.account,
      h1: r.h1,
      today: r.today,
      total: r.total,
      sessions: sessionMap.get(r.account) ?? 0,
      lastActiveAt: r.lastActiveAt,
    }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/** 从界面和上下文拿掉该身份的全部消息，行仍保留。 */
export function clearHistory(account: string): number {
  const info = open().prepare("UPDATE messages SET retracted = 1 WHERE account = ? AND retracted = 0").run(account);
  return info.changes;
}

/** 从界面和上下文拿掉一场会话，行仍保留。 */
export function deleteSession(account: string, sessionId: number): number {
  const info = open()
    .prepare("UPDATE messages SET retracted = 1 WHERE account = ? AND session_id = ? AND retracted = 0")
    .run(account, sessionId);
  return info.changes;
}

/** 记下一次赞或踩。每次点击都新增一行，不覆盖旧记录。vote 为 1、-1 或 0。 */
export function recordFeedback(account: string, messageId: number, vote: number): number | null {
  const d = open();
  const msg = d
    .prepare("SELECT id, role FROM messages WHERE id = ? AND account = ?")
    .get(messageId, account) as { id: number; role: string } | undefined;
  if (!msg || msg.role !== "assistant") return null;
  const stored = vote === 1 || vote === -1 ? vote : 0;
  d.prepare("INSERT INTO message_feedback (account, message_id, vote, created_at) VALUES (?, ?, ?, ?)").run(
    account,
    messageId,
    stored,
    Date.now(),
  );
  return stored;
}

export interface FeedbackRow {
  id: number;
  account: string; // 评价人
  messageId: number;
  vote: number; // 1 赞 / -1 踩 / 0 撤销
  createdAt: number;
  content: string | null; // 被评的助手回答（消息可能已被撤回或清理，此时为 null）
  sessionId: number | null;
  owner: string | null; // 回答所属账号
  retracted: boolean;
}

/** 管理端反馈列表（新→旧），联出被评内容与会话归属，供「直达对话」定位。 */
export function listFeedback(limit = 200): FeedbackRow[] {
  return open()
    .prepare(
      `SELECT f.id, f.account, f.message_id AS messageId, f.vote, f.created_at AS createdAt,
              m.content AS content, m.session_id AS sessionId, m.account AS owner, m.retracted
       FROM message_feedback f LEFT JOIN messages m ON m.id = f.message_id
       ORDER BY f.id DESC LIMIT ?`,
    )
    .all(limit) as FeedbackRow[];
}

/** 赞/踩总量统计（不受 limit 影响） */
export function feedbackStats(): { up: number; down: number; cancel: number } {
  const rows = open()
    .prepare("SELECT vote, COUNT(*) AS c FROM message_feedback GROUP BY vote")
    .all() as { vote: number; c: number }[];
  const get = (v: number) => rows.find((r) => r.vote === v)?.c ?? 0;
  return { up: get(1), down: get(-1), cancel: get(0) };
}

export interface ShareSnapshot {
  id: string;
  title: string;
  body: string;
  created_at: number;
}

/** 把一轮或整场对话做成可公开打开的快照。之后撤回不影响这条分享。 */
export function createShare(account: string, sessionId: number, userMessageId?: number): ShareSnapshot | null {
  const d = open();
  if (!sessionOwnedBy(account, sessionId)) return null;
  const rows = listSessionMessages(account, sessionId);
  let picked = rows;
  if (userMessageId) {
    const start = rows.findIndex((row) => row.id === userMessageId && row.role === "user");
    if (start < 0) return null;
    picked = rows.slice(start, start + 2).filter((row, index) => index === 0 || row.role === "assistant");
  }
  if (picked.length === 0) return null;
  const lines = picked.map((row) => `${row.role === "user" ? "问" : "答"}：\n${row.content}`);
  const title = (picked.find((row) => row.role === "user")?.content || "对话").replace(/\s+/g, " ").slice(0, 40);
  const id = randomShareId();
  const body = lines.join("\n\n");
  const created = Date.now();
  d.prepare("INSERT INTO shares (id, account, title, body, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    account,
    title,
    body,
    created,
  );
  return { id, title, body, created_at: created };
}

export function getShare(id: string): ShareSnapshot | null {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  const row = open()
    .prepare("SELECT id, title, body, created_at FROM shares WHERE id = ?")
    .get(id) as ShareSnapshot | undefined;
  return row ?? null;
}

function randomShareId(): string {
  return randomBytes(12).toString("hex");
}

/** 保留全部消息，包括已撤回的。不再按天数删除。 */
export function pruneExpired(): number {
  void agentHistoryRetentionDays;
  return 0;
}

/** 仅供测试：重置模块级连接缓存 */
export function _resetForTest(): void {
  db?.close();
  db = null;
}
