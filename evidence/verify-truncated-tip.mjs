/**
 * 免 GLM 验证：前端对 {"type":"truncated"} 事件的渲染（缺陷1 前端路径）。
 * 用 Playwright 路由拦截 /api/agent/chat，注入脚本化 SSE：
 *   session → user → thinking → delta… → truncated → done
 * 断言：回答气泡正常渲染 + 该条回答下出现指定文案的 status 提示 + 输入框恢复 + 无 JS 报错。
 */
import { writeFileSync } from "node:fs";

const { chromium } = await import("file:///root/sjtu-mcm-website/node_modules/playwright/index.mjs");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("dialog", (d) => d.accept());
const jsErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") jsErrors.push(m.text());
});
page.on("pageerror", (e) => jsErrors.push(e.message));

const answerText =
  "模糊综合评价法的基本步骤：\n\n1. 确定因素集 U={u1,u2,…,un} 与评语集 V={v1,…,vm}；\n2. 构造隶属度矩阵 R，r_ij 为第 i 个因素对第 j 等级的隶属度；\n\n归一化权重 A 与 R 合成得到 B=A∘R。数值例：三个因素、四个等级，R 的第二行是 (0.2, 0.5, 0.2, 0.1)，合成后按最大隶属度定为“良好”。最终评级公式为 w_j = (1 - entropy) / (1 -";

const sse = [
  `data: ${JSON.stringify({ type: "session", sessionId: 9901 })}\n\n`,
  `data: ${JSON.stringify({ type: "user", messageId: 9902 })}\n\n`,
  `data: ${JSON.stringify({ type: "thinking", text: "（模拟思考增量）正在检索评价模型讲义…" })}\n\n`,
  ...answerText.match(/[\s\S]{1,40}/g).map((chunk) => `data: ${JSON.stringify({ type: "delta", text: chunk })}\n\n`),
  `data: ${JSON.stringify({ type: "truncated" })}\n\n`,
  `data: ${JSON.stringify({ type: "done", messageId: 9903 })}\n\n`,
].join("");

await page.route("**/api/agent/chat", (route) =>
  route.fulfill({
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" },
    body: sse,
  }),
);

await page.goto("http://127.0.0.1:4324/", { waitUntil: "domcontentloaded" });
await page.click("#agent-fab");
await page.waitForSelector("#agent-panel:not([hidden])");
await page.waitForFunction(() => !document.getElementById("agent-input").disabled);
await page.waitForTimeout(1200); /* 等面板异步初始化收敛 */

await page.fill("#agent-input", "介绍模糊综合评价法");
const t0 = Date.now();
await page.click("#agent-send");
/* 注入的 SSE 一次性送达，流很快结束；等输入框恢复后稍作停留再取状态 */
await page.waitForFunction(() => !document.getElementById("agent-input").disabled, null, { timeout: 15000 });
await page.waitForTimeout(500);
const recoveryMs = Date.now() - t0;

const state = await page.evaluate(() => {
  const body = document.getElementById("agent-body");
  const statuses = [...body.querySelectorAll(".agent-msg.status")].map((n) => n.textContent?.trim() ?? "");
  const bubbles = [...body.querySelectorAll(".agent-msg.assistant")];
  const last = bubbles.at(-1);
  const tip = statuses.find((s) => s.includes("回答达到模型输出上限"));
  const tipEl = tip
    ? [...body.querySelectorAll(".agent-msg.status")].find((n) => (n.textContent ?? "").includes("回答达到模型输出上限"))
    : null;
  return {
    bodyDump: [...body.children].map((n) => `${n.className}: ${(n.textContent ?? "").slice(0, 60)}`),
    answerRendered: (last?.textContent ?? "").includes("模糊综合评价法的基本步骤"),
    answerCutVisible: (last?.textContent ?? "").includes("(1 - entropy) / (1 -"),
    truncationTip: tip ?? null,
    tipFollowsAnswerBubble: Boolean(tipEl && last && tipEl.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_PRECEDING),
    inputDisabled: document.getElementById("agent-input").disabled,
  };
});

await page.locator("#agent-widget").screenshot({ path: "/root/fix-b/evidence/truncated-tip-panel.png" }).catch(() => {});
const result = { case: "truncated-tip-route-injected", recoveryMs, ...state, jsErrors };
writeFileSync("/root/fix-b/evidence/truncated-tip.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
