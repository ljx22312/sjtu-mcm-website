/**
 * 助手认人：jAccount 会话为准，未登录一律 401（登录引导在 widget 里）。
 * 角标优先显示资料缓存里的真名。
 */
import { SESSION_COOKIE, verifySessionToken } from "../auth";
import { getProfiles } from "../profiles";

type CookieJar = {
  get(name: string): { value?: string } | undefined;
  set?(name: string, value: string, options?: Record<string, unknown>): void;
};

export function identityLabel(account: string): string {
  const name = getProfiles()[account]?.name;
  return name || account;
}

/** 解析当前请求属于谁：无有效 jAccount 会话则返回 null（上层回 401）。 */
export function resolveAgentAccount(cookies: CookieJar): string | null {
  return verifySessionToken(cookies.get(SESSION_COOKIE)?.value)?.user.account ?? null;
}
