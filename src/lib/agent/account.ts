/**
 * 助手认人：已登录用自己的账号；未登录且开了匿名模式时，每个浏览器一份匿名身份。
 * 匿名身份只隔开会话和限额，不是模型管理员。主管理员要另用口令确认。
 */
import { randomBytes } from "node:crypto";
import { SESSION_COOKIE, verifySessionToken } from "../auth";
import { agentAllowAnonymous } from "./config";

export const AGENT_ANON_COOKIE = "sjtumcm_agent_anon";
const ANON_RE = /^anon_[a-f0-9]{24}$/;

type CookieJar = {
  get(name: string): { value?: string } | undefined;
  set?(name: string, value: string, options?: Record<string, unknown>): void;
};

export function identityLabel(account: string): string {
  if (account.startsWith("anon_")) return `匿名身份 ${account.slice(5, 9)}`;
  if (account === "root") return "主管理员";
  return account;
}

/** 解析当前请求属于谁。匿名访客第一次访问时写入长期 cookie。 */
export function resolveAgentAccount(cookies: CookieJar): string | null {
  const session = verifySessionToken(cookies.get(SESSION_COOKIE)?.value);
  if (session?.user.account) return session.user.account;
  if (!agentAllowAnonymous) return null;
  const existing = cookies.get(AGENT_ANON_COOKIE)?.value ?? "";
  if (ANON_RE.test(existing)) return existing;
  const id = `anon_${randomBytes(12).toString("hex")}`;
  cookies.set?.(AGENT_ANON_COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 60 * 60 * 24 * 400,
  });
  return id;
}
