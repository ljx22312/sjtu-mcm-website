/**
 * 公众号文章永久链接采集：
 * 搜狗微信搜索（多组关键词）→ 无头浏览器点开每条「SJTU数学建模」结果
 * → 在 mp.weixin.qq.com 页面里提取 msg_link（永久链接）/ 标题 / 发布时间
 * 输出 JSON 到 /tmp/wx-articles.json
 */
const { chromium } = require("playwright");
const fs = require("fs");

const QUERIES = [
  "SJTU数学建模",
  "数学建模协会 校内赛",
  "美赛集训队 数学建模",
  "集训队 SJTU",
  "春日雅集 数学建模",
  "荣昶杯 数学建模",
  "百团大战 数学建模 交大",
  "数学建模协会 招新 交大",
  "数学建模协会 换届",
  "华为杯 研究生数学建模",
];

(async () => {
  const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"] });
  const ctx = await b.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "zh-CN",
  });
  const page = await ctx.newPage();
  const found = new Map(); // title -> {url, date, account}

  for (const q of QUERIES) {
    try {
      await page.goto("https://weixin.sogou.com/weixin?type=2&query=" + encodeURIComponent(q), {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await page.waitForTimeout(1800);
      if (await page.locator("#seccodeImage, .btn-validate").count() > 0) {
        console.log(`[验证码] "${q}" 跳过`);
        continue;
      }
      const blocks = await page.locator("li[id^=sogou_vr]").all();
      const candidates = [];
      for (const blk of blocks) {
        const acct = (await blk.locator(".s-p span").first().textContent().catch(() => "")) || "";
        const title = (await blk.locator('a[uigs^="article_title_"]').first().textContent().catch(() => "")) || "";
        if (acct.trim() === "SJTU数学建模" && title.trim()) {
          candidates.push({ title: title.trim(), handle: blk.locator('a[uigs^="article_title_"]').first() });
        }
      }
      console.log(`"${q}": 本号结果 ${candidates.length} 条`);
      for (const c of candidates) {
        if (found.has(c.title)) continue;
        try {
          const popupP = ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null);
          await c.handle.click({ timeout: 5000 });
          await page.waitForTimeout(1200);
          const popup = await popupP;
          const target = popup || page;
          await target.waitForTimeout(1800);
          const info = await target.evaluate(() => {
            const pick = (re) => {
              const m = document.documentElement.innerHTML.match(re);
              return m ? m[1] : "";
            };
            const url =
              pick(/var msg_link = '(.*?)'/) ||
              pick(/"msg_link":"(.*?)"/) ||
              location.href;
            const title =
              pick(/var msg_title = '(.*?)'/) ||
              pick(/property="og:title" content="([^"]*)"/) ||
              document.title;
            const date = pick(/var createTime = '(.*?)'/) || pick(/"createTime":"([^"]*)"/) || "";
            const account = pick(/var nickname = htmlDecode\("(.*?)"\)/) || pick(/"nickname":"([^"]*)"/) || "";
            return { url, title, date, account };
          }).catch(() => null);
          if (info && info.url.includes("mp.weixin.qq.com/s")) {
            found.set(c.title, { title: info.title || c.title, url: info.url.replace(/&amp;/g, "&"), date: info.date, account: info.account || "SJTU数学建模" });
            console.log(`  ✓ ${c.title.slice(0, 32)} -> 已取永久链接`);
          }
          if (popup) await popup.close().catch(() => {});
          await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForTimeout(1200);
        } catch (e) {
          console.log(`  ✗ ${c.title.slice(0, 28)}: ${e.message.split("\n")[0].slice(0, 40)}`);
        }
      }
    } catch (e) {
      console.log(`[查询失败] "${q}": ${e.message.split("\n")[0].slice(0, 50)}`);
    }
    await page.waitForTimeout(1500 + Math.random() * 1500);
  }

  await b.close();
  const out = [...found.values()];
  fs.writeFileSync("/tmp/wx-articles.json", JSON.stringify(out, null, 1));
  console.log(`\n共采集 ${out.length} 篇本号文章的永久链接 → /tmp/wx-articles.json`);
})();
