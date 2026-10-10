import type { APIRoute } from "astro";
import { denyPrivilegedRequest } from "../../../../lib/site-gate";
import { accountUsageOverview, windowUsage } from "../../../../lib/agent/history";
import { effectiveLimits, getUserLimits } from "../../../../lib/agent/usage";
import { agentRateLimitCustomPerHour, agentWindowMinutes, agentWindowMessages } from "../../../../lib/agent/config";
import { getProfiles } from "../../../../lib/profiles";

export const prerender = false;

/**
 * GET /api/admin/agent/overview
 * 助手用量一览：每个账号的窗口用量/重置时间、今日/累计提问、会话数、最后活跃、生效限额。
 */
export const GET: APIRoute = async ({ url, cookies }) => {
  const denied = denyPrivilegedRequest({ url, cookies });
  if (denied) return denied;

  const profiles = getProfiles();
  const overrides = getUserLimits();
  const users = accountUsageOverview().map((u) => {
    const eff = effectiveLimits(u.account);
    const win = windowUsage(u.account, eff.windowMinutes * 60_000);
    const profile = profiles[u.account];
    return {
      account: u.account,
      name: profile?.name ?? "",
      type: profile?.type ?? "",
      windowUsed: win.used,
      windowStartAt: win.windowStart,
      windowResetsAt: win.resetsAt,
      today: u.today,
      total: u.total,
      sessions: u.sessions,
      lastActiveAt: u.lastActiveAt,
      limits: {
        window: eff.windowMessages,
        blocked: eff.blocked,
        overridden: eff.overridden,
        note: overrides[u.account]?.note ?? "",
      },
    };
  });
  return new Response(
    JSON.stringify({
      defaults: {
        windowMessages: agentWindowMessages,
        windowMinutes: agentWindowMinutes,
        customHourly: agentRateLimitCustomPerHour,
      },
      users,
    }),
    { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" } },
  );
};
