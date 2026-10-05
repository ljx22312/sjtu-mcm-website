// 验收脚本：逐页测 390px 与 1280px 的 scrollWidth，并给 4 个重点页截图
// 用法：node verify.mjs [before|after]
import { chromium } from "/root/sjtu-mcm-website/node_modules/playwright/index.mjs";
import fs from "node:fs";

const tag = process.argv[2] || "run";
const BASE = process.env.BASE_URL || "http://127.0.0.1:4323";
const PAGES = ["/", "/news", "/calendar", "/knowledge", "/ai-tools", "/about", "/join", "/team-up", "/login"];
const SHOT_PAGES = ["/", "/news", "/calendar", "/knowledge"];

const browser = await chromium.launch();
const report = { tag, timestamp: new Date().toISOString(), mobile390: {}, desktop1280: {} };

// 390×844
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mp = await mctx.newPage();
for (const path of PAGES) {
  await mp.goto(BASE + path, { waitUntil: "networkidle" });
  await mp.waitForTimeout(200);
  report.mobile390[path] = await mp.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (SHOT_PAGES.includes(path)) {
    await mp.screenshot({ path: new URL(`./${tag}_${path.replace(/\//g, "_") || "home"}_390.png`, import.meta.url).pathname, fullPage: false });
  }
}
await mctx.close();

// 1280×800
const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const dp = await dctx.newPage();
for (const path of PAGES) {
  await dp.goto(BASE + path, { waitUntil: "networkidle" });
  await dp.waitForTimeout(200);
  report.desktop1280[path] = await dp.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (SHOT_PAGES.includes(path)) {
    await dp.screenshot({ path: new URL(`./${tag}_${path.replace(/\//g, "_") || "home"}_1280.png`, import.meta.url).pathname, fullPage: false });
  }
}
await dctx.close();
await browser.close();

fs.writeFileSync(new URL(`./verify-${tag}.json`, import.meta.url), JSON.stringify(report, null, 2));
console.log(`\n[${tag}] 390px scrollWidth（目标 ≤390）:`);
for (const [p, v] of Object.entries(report.mobile390)) {
  const ok = v.scrollWidth <= v.clientWidth + 1 ? "PASS" : "FAIL";
  console.log(`  ${ok}  ${p.padEnd(12)} ${v.scrollWidth}`);
}
console.log(`[${tag}] 1280px scrollWidth（回归检查，应=1280）:`);
for (const [p, v] of Object.entries(report.desktop1280)) {
  const ok = v.scrollWidth <= v.clientWidth + 1 ? "PASS" : "FAIL";
  console.log(`  ${ok}  ${p.padEnd(12)} ${v.scrollWidth}`);
}
