/**
 * jAccount（交大统一身份认证）OIDC 客户端 + 会话签名。
 *
 * 协议：授权码模式 + OIDC（scope=openid）
 *   授权  GET https://jaccount.sjtu.edu.cn/oauth2/authorize
 *   换票  POST https://jaccount.sjtu.edu.cn/oauth2/token（Basic 认证）
 *   登出  GET https://jaccount.sjtu.edu.cn/oauth2/logout
 * id_token 为 HS256 JWT（签名密钥 = client_secret），含 sub(账号)/name/code(学工号)/type。
 *
 * 本模块只在服务端（API 路由）中引用，静态页面不得 import。
 *
 * 环境变量：
 *   JACCOUNT_CLIENT_ID / JACCOUNT_CLIENT_SECRET  交我办「jAccount接口申请」通过后填
 *   AUTH_SESSION_SECRET  会话 cookie 签名密钥（openssl rand -hex 32；不设则每次启动随机）
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const JACCOUNT_ISSUER = "https://jaccount.sjtu.edu.cn/oauth2/";
const AUTHORIZE_URL = "https://jaccount.sjtu.edu.cn/oauth2/authorize";
const TOKEN_URL = "https://jaccount.sjtu.edu.cn/oauth2/token";

export const SESSION_COOKIE = "sjtumcm_session";
export const OAUTH_STATE_COOKIE = "sjtumcm_oauth_state";
const SESSION_TTL_SEC = 7 * 24 * 3600;

/* 环境变量：独立 node 运行时只有 process.env；astro dev/build 下 import.meta.env 也可用 */
function env(key: string): string {
  const p = (globalThis as any).process?.env;
  const v = p?.[key] ?? (import.meta as any).env?.[key];
  return typeof v === "string" ? v : "";
}

export const clientId = env("JACCOUNT_CLIENT_ID");
export const clientSecret = env("JACCOUNT_CLIENT_SECRET");
/** 正式 jAccount 凭据是否已配置 */
export const jaccountConfigured = Boolean(clientId && clientSecret);

let ephemeralSecret: string | null = null;
function sessionSecret(): string {
  const s = env("AUTH_SESSION_SECRET");
  if (s) return s;
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32).toString("hex");
    console.warn("[auth] AUTH_SESSION_SECRET 未设置，使用临时密钥（服务重启后所有登录态失效）");
  }
  return ephemeralSecret;
}

export interface SessionUser {
  account: string; // jAccount 账号（学号/工号或自定义账号名）
  name: string; // 姓名
  code: string; // 学工号
  type: string; // student / faculty / ...
}

export interface Session {
  user: SessionUser;
  exp: number; // unix 秒
}

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64url");

/* ---------------- 会话 cookie（HMAC-SHA256 签名的 JSON，无第三方依赖） ---------------- */

export function signSession(user: SessionUser, ttlSec = SESSION_TTL_SEC): string {
  const payload = b64url(JSON.stringify({ user, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string | undefined | null): Session | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expect = Buffer.from(createHmac("sha256", sessionSecret()).update(payload).digest("base64url"));
  if (sig.length !== expect.length || !timingSafeEqual(sig, expect)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (!session?.user?.account || typeof session.exp !== "number") return null;
    if (session.exp < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

/* ---------------- OAuth2 / OIDC ---------------- */

export function randomState(): string {
  return randomBytes(16).toString("hex");
}

export function buildAuthorizeUrl(redirectUri: string, state: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token: string;
}

/** 授权码换 token（Basic 认证，官方推荐方式） */
export async function exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`jaccount token 接口返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * 校验 id_token（HS256，密钥为 client_secret）并取出用户信息。
 * 官方文档：jaccount.sjtu.edu.cn/oauth2/ 签发，aud = client_id。
 */
export function verifyIdToken(idToken: string): SessionUser {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token 格式错误");
  const [h, p, s] = parts;
  const expect = createHmac("sha256", clientSecret).update(`${h}.${p}`).digest("base64url");
  const a = Buffer.from(expect);
  const b = Buffer.from(s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("id_token 签名不匹配");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp < now - 60) throw new Error("id_token 已过期");
  if (claims.aud !== clientId) throw new Error("id_token audience 不匹配");
  if (typeof claims.iss === "string" && !claims.iss.startsWith("https://jaccount.sjtu.edu.cn/oauth2")) {
    throw new Error("id_token 签发者不匹配");
  }
  if (!claims.sub) throw new Error("id_token 缺少 sub");
  return {
    account: String(claims.sub),
    name: typeof claims.name === "string" ? claims.name : "",
    code: typeof claims.code === "string" ? claims.code : "",
    type: typeof claims.type === "string" ? claims.type : "",
  };
}

/* ---------------- 工具 ---------------- */

/** 登录后的回跳地址：只允许站内相对路径，防开放重定向 */
export function sanitizeRedirect(raw: string | null | undefined, fallback = "/"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return fallback;
  if (raw.length > 512) return fallback;
  return raw;
}

export function cookieOptions(secure: boolean, maxAge: number) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge,
  };
}

/** 是否走 https：优先看反向代理传来的 x-forwarded-proto */
export function isRequestSecure(url: URL, headers: Headers): boolean {
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto) return proto === "https";
  return url.protocol === "https:";
}
