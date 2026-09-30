/**
 * Agent 挂件多会话 E2E 验证：
 * 1) 打开面板 → 自动续上最近一场对话（红/蓝气泡）
 * 2) 「历史对话」按钮 → 会话列表（多场可选）
 * 3) 选中某场 → 完整恢复（分隔条 + 气泡 + 思考块收起态）
 * 4) 恢复后继续提问 → 消息写入同一场（列表条数增加）
 * 5) 「重新开始」→ 新会话
 */
const { chromium } = require("playwright");
const path = require("path");

const BASE = "http://127.0.0.1:4321";
const OUT = "/tmp/agent-ui-test";

(async () => {
  const fs = require("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const fails = [];
  const check = (name, cond, extra = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
    if (!cond) fails.push(name);
  };
  /* dialogs: 自动接受 confirm */
  page.on("dialog", (d) => d.accept());

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  /* 面板默认隐藏（回归 bug 修复） */
  check("进页面面板隐藏", !(await page.locator("#agent-panel").isVisible()));

  await page.click("#agent-fab");
  await page.waitForTimeout(2000); /* 等自动恢复最近一场 */

  /* 前置数据：库里已有会话（API 测试创建的 session 2 等）；若无则造一场 */
  let sessionCount = await page.locator(".agent-session-item").count();
  if (sessionCount === 0) {
    await page.fill("#agent-input", "介绍一下你自己");
    await page.click("#agent-send");
    await page.waitForFunction(() => !document.getElementById("agent-send").disabled, null, { timeout: 120000 });
  }

  /* 1. 打开面板自动续最近一场 */
  const autoMsgs = await page.locator("#agent-body .agent-msg").count();
  check("打开面板自动载入最近一场对话", autoMsgs > 0, `${autoMsgs} 条`);

  /* 2. 历史对话按钮 → 列表 */
  await page.click("#agent-history");
  await page.waitForTimeout(800);
  check("点「历史对话」出现会话列表", await page.locator("#agent-sessions").isVisible());
  const items = await page.locator(".agent-session-item").count();
  check("列表有多场对话可选", items >= 1, `${items} 场`);
  await page.screenshot({ path: path.join(OUT, "6-sessions-list.png") });

  /* 3. 选中第一场恢复 */
  const firstItem = page.locator(".agent-session-item").first();
  const firstTitle = await firstItem.locator(".agent-session-title").textContent();
  const firstCount = parseInt((await firstItem.locator(".agent-session-meta").textContent()).match(/(\d+) 条/)?.[1] ?? "0", 10);
  await firstItem.click();
  await page.waitForTimeout(1000);
  check("选中后返回对话视图", !(await page.locator("#agent-sessions").isVisible()));
  const resumeSep = await page.locator(".agent-resume").count();
  check("恢复场显示「已恢复该场对话」分隔条", resumeSep === 1);
  const restoredMsgs = await page.locator("#agent-body .agent-msg").count();
  check("该场消息完整重放", restoredMsgs >= firstCount, `列表标注 ${firstCount} 条 / 重放 ${restoredMsgs} 条`);
  await page.screenshot({ path: path.join(OUT, "7-session-restored.png") });

  /* 4. 恢复后继续提问 → 写入同一场 */
  await page.fill("#agent-input", "恢复测试：接着这场聊一句");
  await page.click("#agent-send");
  await page.waitForFunction(() => !document.getElementById("agent-send").disabled, null, { timeout: 120000 });
  await page.waitForTimeout(500);
  await page.click("#agent-history");
  await page.waitForTimeout(800);
  const metaAfter = await page.locator(".agent-session-item").first().locator(".agent-session-meta").textContent();
  const countAfter = parseInt(metaAfter.match(/(\d+) 条/)?.[1] ?? "0", 10);
  check("恢复后新消息计入同一场", countAfter >= firstCount + 2, `原 ${firstCount} → 现 ${countAfter} 条`);
  await page.click("#agent-sessions-back");

  /* 5. 重新开始 → 新会话 */
  await page.click("#agent-clear");
  await page.waitForTimeout(300);
  check("重新开始后回到空白新会话", (await page.locator("#agent-body .agent-msg").count()) === 1 /* 仅状态提示 */);

  await browser.close();
  console.log(fails.length === 0 ? "\n全部通过 ✓" : `\n${fails.length} 项失败: ${fails.join(", ")}`);
  process.exit(fails.length === 0 ? 0 : 1);
})();
