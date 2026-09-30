/**
 * 按用户保存 agent 对话历史（纯文字），按「会话」分组。
 *
 * 存储：单文件 SQLite（better-sqlite3，WAL 模式），路径见 config.agentHistoryDbPath。
 * 表结构存 account + session_id + 角色 + 内容 + 思考 + 时间戳，不落姓名等额外身份信息。
 * 旧库升级：无 session_id 的存量行按 30 分钟会话间隔回填分组。
 * 保留期：默认 180 天，写入时低概率惰性清理（pruneExpired）。
 */
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

/** 追加一条消息（同步写，单进程下无并发问题）；assistant 可附带思考过程。
 *  session_id 为空时自动开新会话，否则续在该会话。 */
export function appendMessage(
  account: string,
  role: "user" | "assistant",
  content: string,
  thinking?: string,
  sessionId?: number,
): number {
  const d = open();
  let sid = sessionId;
  if (!sid) {
    const last = d
      .prepare("SELECT session_id, created_at FROM messages WHERE account = ? ORDER BY id DESC LIMIT 1")
      .get(account) as { session_id: number; created_at: number } | undefined;
    /* 未显式指定会话：距上条消息超过间隔则开新会话（与回填口径一致） */
    sid =
      last && last.session_id != null && Date.now() - last.created_at <= SESSION_GAP_MS
        ? last.session_id
        : (d.prepare("SELECT COALESCE(MAX(session_id), 0) + 1 AS n FROM messages").get() as { n: number }).n;
  }
  d.prepare(
    "INSERT INTO messages (account, role, content, thinking, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(account, role, content, thinking?.trim() ? thinking : null, sid, Date.now());
  // 惰性清理：约 2% 的写入触发一次过期清扫
  if (Math.random() < 0.02) pruneExpired();
  return sid;
}

/** 某用户全部会话（按最近活跃倒序），含首条用户消息作标题 */
export function listSessions(account: string, limit = 30): SessionSummary[] {
  return open()
    .prepare(
      `SELECT s.session_id,
              COALESCE((SELECT substr(content, 1, 40) FROM messages m2
                        WHERE m2.account = s.account AND m2.session_id = s.session_id AND m2.role = 'user'
                        ORDER BY m2.id LIMIT 1), '(无提问)') AS title,
              COUNT(*) AS message_count,
              MIN(created_at) AS started_at,
              MAX(created_at) AS last_active_at
       FROM messages s
       WHERE s.account = ?
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
      "SELECT id, session_id, role, content, thinking, created_at FROM messages WHERE account = ? AND session_id = ? ORDER BY id",
    )
    .all(account, sessionId) as HistoryMessage[];
}

/** 兼容旧接口：某用户最近 limit 条消息（跨会话拼接，时间正序） */
export function listRecent(account: string, limit = 50): HistoryMessage[] {
  const rows = open()
    .prepare(
      "SELECT id, session_id, role, content, thinking, created_at FROM messages WHERE account = ? ORDER BY id DESC LIMIT ?",
    )
    .all(account, limit) as HistoryMessage[];
  return rows.reverse();
}

/** 清除某用户的全部对话记录，返回删除条数 */
export function clearHistory(account: string): number {
  const info = open().prepare("DELETE FROM messages WHERE account = ?").run(account);
  return info.changes;
}

/** 删除单个会话 */
export function deleteSession(account: string, sessionId: number): number {
  const info = open()
    .prepare("DELETE FROM messages WHERE account = ? AND session_id = ?")
    .run(account, sessionId);
  return info.changes;
}

/** 删除超过保留期的所有用户记录，返回删除条数 */
export function pruneExpired(): number {
  const cutoff = Date.now() - agentHistoryRetentionDays * 24 * 3600 * 1000;
  const info = open().prepare("DELETE FROM messages WHERE created_at < ?").run(cutoff);
  return info.changes;
}

/** 仅供测试：重置模块级连接缓存 */
export function _resetForTest(): void {
  db?.close();
  db = null;
}
