// 逐叶子测 min-content：把每个叶子单独放进 width:min-content 容器里量宽
import { chromium } from "/root/sjtu-mcm-website/node_modules/playwright/index.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto("http://127.0.0.1:4323/knowledge", { waitUntil: "networkidle" });

const out = await page.evaluate(() => {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;left:-9999px";
  document.body.appendChild(probe);
  const results = [];
  for (const card of document.querySelectorAll(".kb-cards > details")) {
    // 打开 details 让 body 可见，逐叶子测
    card.open = true;
    for (const el of card.querySelectorAll("summary *, .kb-card-body *")) {
      if (el.children.length > 0 && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      probe.replaceChildren();
      probe.style.width = "min-content";
      const clone = el.cloneNode(true);
      probe.appendChild(clone);
      const w = clone.getBoundingClientRect().width;
      if (w > 200) results.push({ w: Math.round(w), cls: el.className || el.tagName, text: (el.textContent || "").slice(0, 70) });
    }
    card.open = false;
  }
  probe.remove();
  return results;
});
out.sort((a, b) => b.w - a.w);
for (const r of out.slice(0, 10)) console.log(JSON.stringify(r));
await browser.close();
