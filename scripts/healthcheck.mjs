#!/usr/bin/env node
/**
 * 站点健康巡检 + 错误日志告警（systemd timer 每分钟触发，也可手动运行）
 *  1. 拨测关键页面与接口（SITE_BASE_URL 可覆盖，默认本机 4321）
 *  2. 增量扫描 logs/app-*.log（level=error）与 logs/client-*.log（全部为前端上报）
 *  3. 异常推送飞书群机器人（.env 配 FEISHU_WEBHOOK_URL=...）；
 *     同一问题 5 分钟静默去重，持续故障会每 5 分钟提醒一次；拨测恢复时发恢复通知
 *  4. 顺带清理 14 天前的旧日志
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const LOG_DIR = join(ROOT, "logs");
const STATE_FILE = join(LOG_DIR, "healthcheck-state.json");
const BASE = (process.env.SITE_BASE_URL || "http://127.0.0.1:4321").replace(/\/+$/, "");
const WEBHOOK = process.env.FEISHU_WEBHOOK_URL || "";
const MUTE_MS = 5 * 60_000;
const KEEP_DAYS = 14;

const PATHS = [
  "/", "/news", "/calendar", "/ai-tools", "/about", "/join", "/team-up", "/knowledge",
  "/login", "/api/auth/me",
];

/** @type {{offsets: Record<string, number>, mutes: Record<string, number>, down: Record<string, number>}} */
let state = { offsets: {}, mutes: {}, down: {} };
if (existsSync(STATE_FILE)) {
  try {
    state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {
    /* 状态文件损坏则从头开始 */
  }
}

async function notify(text) {
  if (!WEBHOOK) {
    console.warn(`[healthcheck] 未配置 FEISHU_WEBHOOK_URL，告警仅打印：\n${text}`);
    return;
  }
  try {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
    });
    if (!res.ok) console.error("[healthcheck] webhook 响应异常: HTTP", res.status);
  } catch (e) {
    console.error("[healthcheck] webhook 发送失败:", e.message);
  }
}

async function probe(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(BASE + path, { signal: ctrl.signal, redirect: "manual" });
    return res.status;
  } catch {
    return 0; // 连接失败 / 超时
  } finally {
    clearTimeout(timer);
  }
}

/** 只读自上次偏移以来新增的完整行，并推进偏移。
 *  偏移按字节计：必须用 Buffer 切片再解码，字符串 slice 按字符数切，中文内容下会错位。 */
function readNewLines(file) {
  const p = join(LOG_DIR, file);
  let buf;
  try {
    buf = readFileSync(p);
  } catch {
    return [];
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return []; // 尚无完整行（写入中途），下次再读
  const end = lastNl + 1;
  const prev = Math.min(state.offsets[file] ?? 0, end);
  state.offsets[file] = end;
  if (end <= prev) return []; // 无新增；文件变小则视为轮转，从当前末尾续读
  return buf.subarray(prev, end).toString("utf8").split("\n").filter(Boolean);
}

/** 错误正文归一化（数字打码）后作静默 key，避免同类报错刷屏 */
function normalize(s) {
  return String(s).replace(/\d+/g, "N").slice(0, 120);
}

async function main() {
  const problems = [];

  /* 1. 拨测 */
  for (const path of PATHS) {
    const status = await probe(path);
    if (status === 200) {
      if (state.down[path] !== undefined) {
        delete state.down[path];
        delete state.mutes[`probe:${path}`];
        await notify(`✅ [sjtu-mcm-website] 拨测恢复：${path} 已恢复正常`);
      }
      continue;
    }
    if (state.down[path] === undefined) state.down[path] = Date.now();
    const detail = status === 0 ? "连接失败/超时" : `HTTP ${status}`;
    problems.push({ key: `probe:${path}`, text: `拨测失败 ${path}：${detail}` });
  }

  /* 2. 增量扫描结构化日志 */
  mkdirSync(LOG_DIR, { recursive: true });
  for (const file of readdirSync(LOG_DIR)) {
    if (!/^(app|client)-\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue;
    const isClient = file.startsWith("client-");
    for (const line of readNewLines(file)) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isClient && ev.level !== "error") continue; // warn（如限流）不告警
      const where = ev.page || ev.url || "";
      const who = ev.account ? `账号=${ev.account}` : ev.ip ? `IP=${ev.ip}` : "";
      const head = String(ev.message || ev.msg || ev.event || "").split("\n")[0];
      const text = isClient
        ? `[用户端] ${where} ${head} ${who}`.trim()
        : `[服务端] ${ev.event} ${where} ${head}`.trim();
      problems.push({ key: `${isClient ? "client" : "server"}:${normalize(head)}`, text });
    }
  }

  /* 3. 静默去重后推送 */
  const now = Date.now();
  const toSend = [];
  for (const p of problems) {
    if ((state.mutes[p.key] ?? 0) > now - MUTE_MS) continue;
    state.mutes[p.key] = now;
    toSend.push(p.text);
  }
  if (toSend.length) {
    const shown = toSend.slice(0, 20);
    const more = toSend.length - shown.length;
    await notify(
      `🚨 [sjtu-mcm-website] ${new Date().toLocaleString("zh-CN", { hour12: false })}\n` +
        shown.map((t) => `• ${t}`).join("\n") +
        (more > 0 ? `\n…另有 ${more} 条` : ""),
    );
  }

  /* 4. 清理旧日志与过期静默项 */
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const f of readdirSync(LOG_DIR)) {
    if (!f.endsWith(".log")) continue;
    try {
      if (statSync(join(LOG_DIR, f)).mtimeMs < cutoff) unlinkSync(join(LOG_DIR, f));
    } catch {}
  }
  for (const k of Object.keys(state.mutes)) {
    if (state.mutes[k] < now - MUTE_MS * 4) delete state.mutes[k];
  }
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

main().catch((e) => {
  console.error("[healthcheck] 运行失败:", e);
  process.exit(1);
});
