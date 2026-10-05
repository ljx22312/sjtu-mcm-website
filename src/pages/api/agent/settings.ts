import type { APIRoute } from "astro";
import { resolveAgentAccount } from "../../../lib/agent/account";
import { agentConfigured } from "../../../lib/agent/config";
import { getAdminConfig, isAdminAccount, saveAdminConfig, REASONING_LEVELS, type ReasoningLevel } from "../../../lib/agent/admin";

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/**
 * GET /api/agent/settings → 面板设置页所需的公共信息：
 *   { configured, officialModel, officialReasoning, admin, reasoningLevels }
 * officialModel/officialReasoning 是官方模型用户的运行参数（由服务器端文件控制）；
 * admin 表示当前用户是否管理员（可看到并修改官方参数）。
 */
export const GET: APIRoute = async ({ cookies }) => {
  const account = resolveAgentAccount(cookies);
  if (!account) return json({ error: "unauthorized" }, 401);
  const cfg = getAdminConfig();
  return json({
    configured: agentConfigured,
    officialModel: cfg.officialModel,
    officialReasoning: cfg.officialReasoning,
    admin: isAdminAccount(account),
    reasoningLevels: REASONING_LEVELS,
  });
};

/** POST /api/agent/settings body: {officialModel?, officialReasoning?} → 仅管理员，写回 data/agent-admin.json */
export const POST: APIRoute = async ({ request, cookies }) => {
  const account = resolveAgentAccount(cookies);
  if (!account) return json({ error: "unauthorized" }, 401);
  if (!isAdminAccount(account)) return json({ error: "forbidden" }, 403);

  let model: string | undefined;
  let reasoning: ReasoningLevel | undefined;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.officialModel === "string") {
      model = body.officialModel.trim().slice(0, 100) || undefined;
    }
    if (REASONING_LEVELS.some((r) => r.value === body.officialReasoning)) {
      reasoning = body.officialReasoning as ReasoningLevel;
    }
  } catch {
    /* 空_body 等情况：不改任何字段 */
  }
  if (!model && !reasoning) return json({ error: "bad_request" }, 400);

  const cfg = saveAdminConfig({ officialModel: model, officialReasoning: reasoning });
  return json({ officialModel: cfg.officialModel, officialReasoning: cfg.officialReasoning });
};
