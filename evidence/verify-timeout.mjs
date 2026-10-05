/**
 * 验收脚本（回合总超时）：服务器须以 AGENT_TURN_TIMEOUT_MS=30000 启动。
 * 发一个长问题，什么都不动，验证输入框在 ≤35 秒内恢复，且出现超时提示。
 * 用法：node evidence/verify-timeout.mjs
 */
import { writeFileSync } from "node:fs";

const { chromium } = await import("file:///root/sjtu-mcm-website/node_modules/playwright/index.mjs");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("dialog", (d) => d.accept());
const jsErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") jsErrors.push(`[console.error] ${msg.text()}`);
});
page.on("pageerror", (err) => jsErrors.push(`[pageerror] ${err.message}`));

await page.goto("http://127.0.0.1:4324/", { waitUntil: "domcontentloaded" });
await page.click("#agent-fab");
await page.waitForSelector("#agent-panel:not([hidden])");
await page.waitForFunction(() => !document.getElementById("agent-input").disabled);
await page.click("#agent-clear");
await page.waitForTimeout(800);

const question =
  "请详细介绍模糊综合评价法的完整建模流程，包括隶属度矩阵构造、算子选择和最终评级，并给出数值例子";
await page.fill("#agent-input", question);
const t0 = Date.now();
await page.click("#agent-send");
/* 不做任何操作，等待 30s 超时自动停止；验收线：≤35s 恢复 */
await page.waitForFunction(() => !document.getElementById("agent-input").disabled, null, { timeout: 40000 });
const recoveryMs = Date.now() - t0;

const state = await page.evaluate(() => {
  const body = document.getElementById("agent-body");
  const statuses = [...body.querySelectorAll(".agent-msg.status")].map((n) => n.textContent?.trim() ?? "");
  const bubbles = [...body.querySelectorAll(".agent-msg.assistant")];
  const last = bubbles.at(-1);
  return {
    statusTexts: statuses,
    hasTimeoutTip: statuses.some((s) => s.includes("已自动停止")),
    hasTruncationTip: statuses.some((s) => s.includes("回答达到模型输出上限")),
    lastAnswerChars: last ? (last.textContent ?? "").length : 0,
    lastAnswerTail: last ? (last.textContent ?? "").slice(-40) : "",
    inputDisabled: document.getElementById("agent-input").disabled,
  };
});

await page.locator("#agent-widget").screenshot({ path: "/root/fix-b/evidence/timeout-panel.png" }).catch(() => {});
await page.screenshot({ path: "/root/fix-b/evidence/timeout.png" }).catch(() => {});
const result = { case: "timeout-30s", recoveryMs, within35s: recoveryMs <= 35000, ...state, jsErrors };
writeFileSync("/root/fix-b/evidence/timeout.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
