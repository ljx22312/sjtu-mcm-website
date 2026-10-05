/**
 * 主管理员口令校验。口令明文不进代码库，只比对 .env 里的 scrypt 哈希。
 * 通过后签发的会话账号是 root，与演示账号、各个匿名身份分开。
 */
import { scryptSync, timingSafeEqual } from "node:crypto";

export const ROOT_ADMIN_ACCOUNT = "root";
export const ROOT_ADMIN_NAME = "主管理员";

function env(key: string): string {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = p?.[key] ?? (import.meta as { env?: Record<string, string | undefined> }).env?.[key];
  return typeof v === "string" ? v : "";
}

/** 主管理员口令是否已配置（只表示哈希存在，不表示当前请求已通过） */
export function rootAdminConfigured(): boolean {
  return env("ROOT_ADMIN_PASSWORD_HASH").includes(":");
}

/** 常量时间比较口令。未配置哈希时一律拒绝。 */
export function verifyRootAdminPassword(password: string): boolean {
  const stored = env("ROOT_ADMIN_PASSWORD_HASH").trim();
  const split = stored.indexOf(":");
  if (split <= 0 || !password) return false;
  const salt = Buffer.from(stored.slice(0, split), "hex");
  const expect = Buffer.from(stored.slice(split + 1), "hex");
  if (salt.length === 0 || expect.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expect.length);
  } catch {
    return false;
  }
  if (actual.length !== expect.length) return false;
  return timingSafeEqual(actual, expect);
}
