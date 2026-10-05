// 定位 390px 视口下把页面撑宽的元素：输出每页 scrollWidth + 超宽元素清单
import { chromium } from "/root/sjtu-mcm-website/node_modules/playwright/index.mjs";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:4323";
const PAGES = ["/", "/news", "/calendar", "/knowledge", "/ai-tools", "/about", "/join", "/team-up", "/login"];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

const report = {};
for (const path of PAGES) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  const data = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) continue;
      // 元素右缘超出视口右缘 1px 以上，或自身宽度超过视口
      if (r.right > vw + 1 || r.width > vw + 1) {
        offenders.push({
          sel: describe(el),
          w: Math.round(r.width),
          right: Math.round(r.right),
        });
      }
    }
    function describe(el) {
      const s = el.tagName.toLowerCase();
      const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 4).join(".");
      const id = el.id ? `#${el.id}` : "";
      return s + (cls ? "." + cls : "") + id;
    }
    return {
      viewport: vw,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders: offenders.slice(0, 40),
    };
  });
  report[path] = data;
  console.log(`\n=== ${path} === scrollWidth=${data.scrollWidth} (viewport ${data.viewport})`);
  for (const o of data.offenders) console.log(`  ${o.sel}  w=${o.w} right=${o.right}`);
}

fs.writeFileSync(new URL("./overflow-diagnose.json", import.meta.url), JSON.stringify(report, null, 2));
await browser.close();
