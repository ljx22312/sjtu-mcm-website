/**
 * 免 GLM 验证：手动停止按钮（缺陷2 最坏场景——服务端挂起不响应时）。
 * 路由拦截 /api/agent/chat 且永不响应（模拟 SSE 悬挂/网络黑洞）：
 *   发送 → 输入框禁用 → 点停止 → AbortError 路径 → 输入框恢复 + “（已停止）”占位。
 */
import { writeFileSync } from "node:fs";
const { chromium } = await import("file:///root/sjtu-mcm-website/node_modules/playwright/index.mjs");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("dialog", (d) => d.accept());
const jsErrors = [];
page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
page.on("pageerror", (e) => jsErrors.push(e.message));
await page.route("**/api/agent/chat", () => { /* 永不响应：模拟服务端悬挂 */ });
await page.goto("http://127.0.0.1:4324/", { waitUntil: "domcontentloaded" });
await page.click("#agent-fab");
await page.waitForSelector("#agent-panel:not([hidden])");
await page.waitForFunction(() => !document.getElementById("agent-input").disabled);
await page.waitForTimeout(1200);
await page.fill("#agent-input", "介绍模糊综合评价法");
await page.click("#agent-send");
await page.waitForFunction(() => document.getElementById("agent-input").disabled === true, null, { timeout: 5000 });
const t0 = Date.now();
await page.click("#agent-send"); /* 停止按钮 */
await page.waitForFunction(() => !document.getElementById("agent-input").disabled, null, { timeout: 15000 });
const recoveryMs = Date.now() - t0;
const state = await page.evaluate(() => {
  const body = document.getElementById("agent-body");
  const bubbles = [...body.querySelectorAll(".agent-msg.assistant")];
  return {
    stoppedBubble: (bubbles.at(-1)?.textContent ?? "").trim(),
    inputDisabled: document.getElementById("agent-input").disabled,
  };
});
await page.locator("#agent-widget").screenshot({ path: "/root/fix-b/evidence/stop-panel.png" }).catch(() => {});
const result = { case: "stop-button-hung-server", recoveryMs, ...state, jsErrors };
writeFileSync("/root/fix-b/evidence/stop.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
