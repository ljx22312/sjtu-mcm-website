/**
 * 只读的公开网页搜索。使用必应国内版，返回标题、链接和摘要。
 * 不下载文件，不执行页面里的代码。
 */

function strip(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0*(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&ensp;|&nbsp;|&middot;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseResults(html: string): { title: string; href: string; snippet: string }[] {
  const results: { title: string; href: string; snippet: string }[] = [];
  for (const part of html.split('class="b_algo"').slice(1)) {
    const link = part.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const href = link[1].replace(/&amp;/g, "&");
    if (!/^https?:\/\//i.test(href) || /bing\.com|microsoft\.com/i.test(href)) continue;
    const title = strip(link[2]);
    if (!title) continue;
    const caption = part.match(/class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = caption ? strip(caption[1]).slice(0, 180) : "";
    results.push({ title, href, snippet });
    if (results.length >= 5) break;
  }
  return results;
}

/** 必应国内版。国际版在这台机器上会返回无关网页。 */
export async function webSearch(query: string): Promise<string> {
  const q = query.trim().slice(0, 200);
  if (!q) return "请给出搜索词。";
  const url =
    "https://cn.bing.com/search?q=" +
    encodeURIComponent(q) +
    "&setmkt=zh-CN&setlang=zh-Hans&ensearch=0&count=5";
  let html = "";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return `搜索没有完成（HTTP ${res.status}）。请改用本地知识库。`;
    html = await res.text();
  } catch {
    return "搜索请求失败。请改用本地知识库，不要编造网上的内容。";
  }
  const results = parseResults(html);
  if (results.length === 0) return `没有搜到与「${q}」相关的公开结果。`;
  const lines = results.map((item, i) => `${i + 1}. ${item.title}\n${item.href}\n${item.snippet}`);
  return `以下是必应国内版的公开网页结果，不是协会讲义。引用时要说明来自网上，并给出链接。\n\n${lines.join("\n\n")}`;
}
