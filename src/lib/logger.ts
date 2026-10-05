// @ts-check
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 极简 JSON 行日志：每事件一行 JSON 追加到 logs/<name>-YYYYMMDD.log（按天分文件）。
 *  - 服务端事件 → app-*.log（logEvent）
 *  - 前端错误上报 → client-*.log（logClientEvent，字段固定且全部截断）
 * scripts/healthcheck.mjs 每分钟增量扫描这两类文件并推送飞书告警。
 * 同步写文件即可：本站量级小，O_APPEND 下单行追加原子。
 */

const LOG_DIR = process.env.LOG_DIR ?? join(process.cwd(), "logs");
const MAX_FIELD = 2000;

function daystamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function trunc(value: unknown, max: number = MAX_FIELD): string {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  return s.length > max ? `${s.slice(0, max)}…[截断]` : s;
}

function write(name: "app" | "client", line: Record<string, unknown>): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${name}-${daystamp()}.log`), `${JSON.stringify(line)}\n`);
  } catch {
    /* 写日志失败不能影响业务；error 级别仍有 console 输出兜底进 journald */
  }
}

export function logEvent(
  level: "error" | "warn" | "info",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  write("app", { t: new Date().toISOString(), src: "server", level, event, ...fields });
  const line = `[${level}] ${event} ${JSON.stringify(fields)}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

/** 前端上报专用：客户端不可信，只落固定字段并逐项截断，绝不接收业务数据（对话、密钥） */
export function logClientEvent(fields: {
  kind: string;
  msg: string;
  stack?: string;
  page: string;
  ua?: string;
  account?: string | null;
  ip?: string | null;
}): void {
  write("client", {
    t: new Date().toISOString(),
    src: "client",
    kind: trunc(fields.kind, 20),
    msg: trunc(fields.msg, 500),
    stack: trunc(fields.stack ?? ""),
    page: trunc(fields.page, 200),
    ua: trunc(fields.ua ?? "", 300),
    account: fields.account ?? null,
    ip: fields.ip ?? null,
  });
}
