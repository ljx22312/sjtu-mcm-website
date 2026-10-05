/**
 * 网站管理员名单：决定谁能看到「下一版本」和「管理员视角」。
 *
 * 与助手的模型管理员（data/agent-admin.json / AGENT_ADMIN_ACCOUNTS）不是同一份名单。
 *
 * 来源（合并）：
 *   - data/site-admins.json 的 admins（/staff 页面可增删，改完即生效）
 *   - 环境变量 SITE_ADMIN_ACCOUNTS（逗号分隔；页面上只展示，不能删除）
 *
 * 账号必须与 jAccount 的 sub 完全一致（演示登录的账号是 demo）。
 * 名单为空时，没有任何账号能打开内部视角。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logEvent } from "./logger";

function env(key: string): string {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = p?.[key] ?? (import.meta as { env?: Record<string, string | undefined> }).env?.[key];
  return typeof v === "string" ? v : "";
}

function envPath(key: string, fallback: string): string {
  const v = env(key);
  if (!v) return fallback;
  return v.startsWith("/") ? v : resolve(process.cwd(), v);
}

/** jAccount 账号：字母或数字开头，其余为字母、数字、点、下划线、连字符 */
export const ADMIN_ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const siteAdminConfigPath = envPath("SITE_ADMIN_CONFIG", join(process.cwd(), "data", "site-admins.json"));

export interface SiteAdminEntry {
  account: string;
  inFile: boolean;
  inEnv: boolean;
}

let cached: { mtimeMs: number; fileAdmins: string[] } | null = null;

function uniqueValid(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const account = value.trim();
    if (!ADMIN_ACCOUNT_RE.test(account) || out.includes(account)) continue;
    out.push(account);
  }
  return out;
}

function envAdmins(): string[] {
  return uniqueValid(env("SITE_ADMIN_ACCOUNTS").split(","));
}

function readFileAdmins(): string[] {
  try {
    const st = statSync(siteAdminConfigPath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.fileAdmins;
    const raw = JSON.parse(readFileSync(siteAdminConfigPath, "utf8")) as { admins?: unknown };
    const fileAdmins = uniqueValid(Array.isArray(raw.admins) ? raw.admins.filter((a): a is string => typeof a === "string") : []);
    cached = { mtimeMs: st.mtimeMs, fileAdmins };
    return fileAdmins;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logEvent("error", "site_admin_config_unreadable", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return [];
  }
}

function writeFileAdmins(admins: string[]): void {
  mkdirSync(dirname(siteAdminConfigPath), { recursive: true });
  const tmp = `${siteAdminConfigPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ admins }, null, 2)}\n`, "utf8");
  renameSync(tmp, siteAdminConfigPath);
  cached = null;
}

export function isSiteAdmin(account: string): boolean {
  if (!ADMIN_ACCOUNT_RE.test(account)) return false;
  return readFileAdmins().includes(account) || envAdmins().includes(account);
}

export function listSiteAdmins(): SiteAdminEntry[] {
  const file = readFileAdmins();
  const fromEnv = envAdmins();
  const fileSet = new Set(file);
  const envSet = new Set(fromEnv);
  return [...new Set([...fromEnv, ...file])].map((account) => ({
    account,
    inFile: fileSet.has(account),
    inEnv: envSet.has(account),
  }));
}

export function addSiteAdmin(account: string): { ok: true; admins: SiteAdminEntry[] } | { ok: false; error: string; message: string } {
  const name = account.trim();
  if (!ADMIN_ACCOUNT_RE.test(name)) {
    return { ok: false, error: "invalid_account", message: "请填写 jAccount 账号：字母或数字开头，只能含字母、数字、点、下划线和连字符。" };
  }
  const file = readFileAdmins();
  if (!file.includes(name)) writeFileAdmins([...file, name]);
  return { ok: true, admins: listSiteAdmins() };
}

export function removeSiteAdmin(account: string): { ok: true; admins: SiteAdminEntry[] } | { ok: false; error: string; message: string } {
  const name = account.trim();
  if (!ADMIN_ACCOUNT_RE.test(name)) {
    return { ok: false, error: "invalid_account", message: "账号格式不正确。" };
  }
  const file = readFileAdmins();
  if (!file.includes(name)) {
    if (envAdmins().includes(name)) {
      return {
        ok: false,
        error: "env_admin",
        message: "这个账号写在环境变量 SITE_ADMIN_ACCOUNTS 里，页面上不能移除。",
      };
    }
    return { ok: false, error: "not_found", message: "名单里没有这个账号。" };
  }
  const next = file.filter((item) => item !== name);
  if (new Set([...next, ...envAdmins()]).size === 0) {
    return { ok: false, error: "last_admin", message: "至少保留一名管理员。请先添加接替的账号，再移除这一名。" };
  }
  writeFileAdmins(next);
  return { ok: true, admins: listSiteAdmins() };
}
