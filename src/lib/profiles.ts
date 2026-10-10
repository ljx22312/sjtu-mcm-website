/**
 * jAccount 用户资料缓存：账号 → 姓名/学工号/身份类型。
 * 登录成功时由 /api/auth/callback 写入（data/jaccount-profiles.json），
 * 管理员名单页等处用真名展示。只是显示用的缓存：文件缺失或损坏时
 * 回退显示账号，对应账号下次登录时自动重建。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface JaccountProfile {
  name: string;
  code: string;
  type: string;
  t: number; // 最后一次登录的毫秒时间戳
}

function profilesPath(): string {
  const fromEnv = process.env.JACCOUNT_PROFILES_PATH ?? "";
  if (fromEnv) return fromEnv.startsWith("/") ? fromEnv : resolve(process.cwd(), fromEnv);
  return join(process.cwd(), "data", "jaccount-profiles.json");
}

export function saveProfile(account: string, name: string, code: string, type: string): void {
  try {
    const file = profilesPath();
    let all: Record<string, JaccountProfile> = {};
    try {
      all = JSON.parse(readFileSync(file, "utf8")) as Record<string, JaccountProfile>;
    } catch {
      /* 首次写入或文件损坏，从空表开始 */
    }
    all[account] = { name, code, type, t: Date.now() };
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
    renameSync(tmp, file);
  } catch {
    /* 资料缓存写失败不影响登录本身 */
  }
}

export function getProfiles(): Record<string, JaccountProfile> {
  try {
    const all = JSON.parse(readFileSync(profilesPath(), "utf8")) as Record<string, JaccountProfile>;
    return all && typeof all === "object" ? all : {};
  } catch {
    return {};
  }
}
