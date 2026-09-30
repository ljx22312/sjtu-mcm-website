/* agent 悬浮球 UI 验证：桌面 + 移动端，登录前后 */
import { chromium } from "playwright";

const exe = "/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const BASE = "http://127.0.0.1:4322";
const browser = await chromium.launch({ executablePath: exe });

async function shot(page, name) {
  await page.screenshot({ path: `/tmp/shot/${name}.png` });
  console.log("saved", name);
}

// 1) 未登录：打开面板应显示登录引导
const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const p1 = await ctx1.newPage();
await p1.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await p1.click("#agent-fab");
await p1.waitForTimeout(600);
await shot(p1, "agent-desktop-logged-out");

// 2) 演示登录后：面板应显示输入框，发消息应收到流式回复
await p1.goto(BASE + "/api/auth/login?mock=1&redirect=/", { waitUntil: "domcontentloaded" });
await p1.click("#agent-fab");
await p1.waitForTimeout(800);
await p1.fill("#agent-input", "国赛集训的写作课在哪看回放？");
await p1.click("#agent-send");
// 等流式回复完成（发送按钮重新可用）
await p1.waitForFunction(() => !document.getElementById("agent-send").disabled, { timeout: 90_000 });
await p1.waitForTimeout(300);
await shot(p1, "agent-desktop-chat");

const bubbles = await p1.$$eval("#agent-body .agent-msg", (els) =>
  els.map((e) => ({ cls: e.className.replace("agent-msg ", ""), text: e.textContent.slice(0, 80) })),
);
console.log(JSON.stringify(bubbles, null, 1));

// 3) 清除记录按钮（confirm 对话框自动接受）
p1.once("dialog", (d) => d.accept());
await p1.click("#agent-clear");
await p1.waitForTimeout(600);
await shot(p1, "agent-desktop-cleared");

// 4) 移动端视口
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p2 = await ctx2.newPage();
await p2.goto(BASE + "/api/auth/login?mock=1&redirect=/", { waitUntil: "domcontentloaded" });
await p2.click("#agent-fab");
await p2.waitForTimeout(800);
await p2.fill("#agent-input", "美赛集训什么时候开始？");
await p2.click("#agent-send");
await p2.waitForFunction(() => !document.getElementById("agent-send").disabled, { timeout: 90_000 });
await shot(p2, "agent-mobile-chat");

// 横向溢出检查
const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log("mobile horizontal overflow:", overflow);

await browser.close();
console.log("UI verify done");
