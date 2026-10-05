/**
 * 讲义正文索引。只读 data/knowledge 里已经下载的云文档 Markdown，
 * 在进程内做子串检索。不解析 PDF/压缩包，也不执行其中的代码。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { docsForLectures, lookupLectures, unreadableForLectures } from "./lectures";
import { hybridRank } from "./retrieve";
import { addCitation, scopedLectures } from "./scope";

export interface LectureChunk {
  token: string;
  docTitle: string;
  heading: string;
  body: string;
  url: string;
  courses: string;
  /** 图片相对 data/knowledge 的目录，如 readable/<id> */
  imageBase?: string;
}

interface ManifestCourse {
  track?: string;
  course_id?: string;
  topic?: string;
  module?: string;
}

interface ManifestDoc {
  ok?: boolean;
  path?: string;
  token?: string;
  url?: string;
  title?: string;
  names?: string[];
  courses?: ManifestCourse[];
}

const MAX_CHUNK = 1600;
const SNIPPET = 480;

let cache: LectureChunk[] | null = null;
let cacheStamp = "";
/** 验戳上次实跑时刻。readableStamp() 是 1 次 readdir + 360 次 exists，
 *  调用方可能在循环里反复触发 loadChunks()，TTL 内直接用缓存，不再验戳。 */
let stampCheckedAt = 0;
const STAMP_TTL_MS = 30_000;

function knowledgeRoot(): string {
  return join(process.cwd(), "data", "knowledge");
}

let imageByToken: Map<string, string> | null = null;

function embeddedImagePaths(): Map<string, string> {
  if (imageByToken) return imageByToken;
  imageByToken = new Map();
  const manifestPath = join(knowledgeRoot(), "embedded-manifest.json");
  if (!existsSync(manifestPath)) return imageByToken;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    items?: { kind?: string; token?: string; path?: string }[];
  };
  for (const item of manifest.items ?? []) {
    if (item.kind !== "image" || !item.token || !item.path) continue;
    imageByToken.set(item.token, item.path.replace(/^data\/knowledge\//, ""));
  }
  return imageByToken;
}

function replaceEmbeddedImages(md: string): string {
  const images = embeddedImagePaths();
  return md.replace(/<img\b[^>]*?\bsrc="([^"]+)"[^>]*?\/?>/gi, (tag, token: string, offset: number) => {
    const path = images.get(token);
    if (!path) return "";
    const before = md.slice(Math.max(0, offset - 2500), offset);
    const problem = [...before.matchAll(/>(20\d\d[A-Za-z])</g)].pop()?.[1];
    const caption = problem ? `${problem} 附图` : "附图";
    return `\n![${caption}](${path})\n`;
  });
}

function whiteboardImage(token: string): string {
  for (const ext of ["jpg", "png"]) {
    const rel = `embedded/whiteboards/${token}.${ext}`;
    if (existsSync(join(knowledgeRoot(), rel))) return `\n![画板](${rel})\n`;
  }
  return "";
}

function sheetText(token: string, sheetId: string): string {
  const abs = join(knowledgeRoot(), "embedded", "sheets", `${token}-${sheetId}.md`);
  if (!existsSync(abs)) return "";
  return `\n${readFileSync(abs, "utf8").trim()}\n`;
}

function htmlToText(md: string): string {
  return replaceEmbeddedImages(md)
    .replace(/<whiteboard\b[^>]*\btoken="([^"]+)"[^>]*>\s*(?:<\/whiteboard>)?/gi, (_, token: string) => whiteboardImage(token))
    .replace(/<sheet\b[^>]*\bsheet-id="([^"]+)"[^>]*\btoken="([^"]+)"[^>]*>\s*(?:<\/sheet>)?/gi, (_, sheetId: string, token: string) => sheetText(token, sheetId))
    .replace(/<sheet\b[^>]*\btoken="([^"]+)"[^>]*\bsheet-id="([^"]+)"[^>]*>\s*(?:<\/sheet>)?/gi, (_, token: string, sheetId: string) => sheetText(token, sheetId))
    .replace(/<source\b[^>]*name="([^"]*)"[^>]*\/?>/gi, "【附件：$1】")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitBody(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const parts: string[] = [];
  let buf = "";
  for (const para of text.split(/\n{2,}/)) {
    const next = buf ? `${buf}\n\n${para}` : para;
    if (next.length > MAX_CHUNK && buf) {
      parts.push(buf);
      buf = para;
    } else {
      buf = next;
    }
  }
  if (buf) parts.push(buf);
  const out: string[] = [];
  for (const part of parts) {
    if (part.length <= MAX_CHUNK * 1.4) {
      out.push(part);
      continue;
    }
    for (let i = 0; i < part.length; i += MAX_CHUNK) out.push(part.slice(i, i + MAX_CHUNK));
  }
  return out.filter((s) => s.trim().length > 40);
}

function courseLabel(c: ManifestCourse): string {
  const track = c.track === "mcm" ? "美赛" : c.track === "cumcm" ? "国赛" : "";
  return [track, c.module, c.course_id, c.topic].filter(Boolean).join(" ");
}

function readableStamp(): string {
  const dir = join(knowledgeRoot(), "readable");
  if (!existsSync(dir)) return "0";
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (existsSync(join(dir, name, "doc.md"))) count += 1;
  }
  return String(count);
}

function pushSections(
  chunks: LectureChunk[],
  text: string,
  docTitle: string,
  token: string,
  courses: string,
  url: string,
  imageBase?: string,
) {
  const sections = text.split(/(?=^#{1,3} )/m);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const heading = (trimmed.match(/^#{1,3} +(.+)$/m)?.[1] || docTitle).replace(/\*+/g, "").trim();
    for (const body of splitBody(trimmed)) {
      chunks.push({ token, docTitle, heading, body, url, courses, imageBase });
    }
  }
}

const PAGE_SHOT = /^!\[[^\]]*\]\(images\/page-\d+\.(?:jpe?g|png)\)\s*$/i;

/**
 * 整页截图没有可检索的文字。去掉这些行之后，正文不足 100 字、
 * 又没有幻灯片图的资料不进入索引。只剩整页截图的扫描副本也不进入。
 */
function indexableBody(raw: string, fallbackTitle: string): { title: string; parent: string; context: string; body: string } | null {
  let title = fallbackTitle;
  let parent = "";
  let context = "";
  let body = raw;
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---\n");
    if (end > 0) {
      const fm = raw.slice(4, end);
      title = fm.match(/^title:\s*(.*)$/m)?.[1]?.trim() || title;
      parent = fm.match(/^parent:\s*(.*)$/m)?.[1]?.trim() || "";
      context = fm.match(/^context:\s*(.*)$/m)?.[1]?.trim() || "";
      body = raw.slice(end + 5);
    }
  }
  const hadPageShots = body.split("\n").some((line) => PAGE_SHOT.test(line.trim()));
  body = body
    .split("\n")
    .filter((line) => !PAGE_SHOT.test(line.trim()))
    .join("\n");
  const imageLinks = body.match(/!\[[^\]]*\]\((?!https?:)[^)]+\)/g) ?? [];
  const compact = body
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/^#{1,3} .*$/gm, "")
    .replace(/\s+/g, "");
  // 幻灯片课件字很少，但图路径要能被检索到。整页截图副本不要因此留下。
  if (hadPageShots && compact.length < 100) return null;
  if (compact.length < 100 && imageLinks.length === 0) return null;
  return { title, parent, context, body };
}

function loadReadable(chunks: LectureChunk[]) {
  const dir = join(knowledgeRoot(), "readable");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const mdPath = join(dir, name, "doc.md");
    if (!existsSync(mdPath)) continue;
    const ready = indexableBody(readFileSync(mdPath, "utf8"), name);
    if (!ready) continue;
    pushSections(
      chunks,
      ready.body,
      ready.title,
      name,
      [ready.parent, ready.context].filter(Boolean).join(" "),
      "",
      `readable/${name}`,
    );
  }
}

function loadChunks(): LectureChunk[] {
  const now = Date.now();
  if (cache && now - stampCheckedAt < STAMP_TTL_MS) return cache;
  const stamp = readableStamp();
  stampCheckedAt = now;
  if (cache && cacheStamp === stamp) return cache;
  const manifestPath = join(knowledgeRoot(), "manifest.json");
  const chunks: LectureChunk[] = [];
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { docs?: ManifestDoc[] };
    for (const doc of manifest.docs ?? []) {
      if (!doc.ok || !doc.path || !doc.token) continue;
      const abs = join(process.cwd(), doc.path);
      if (!existsSync(abs)) continue;
      const text = htmlToText(readFileSync(abs, "utf8"));
      const docTitle = (doc.names?.[0] || doc.title || doc.token).replace(/\*+/g, "").trim();
      const courses = [...new Set((doc.courses ?? []).map(courseLabel).filter(Boolean))].join("；");
      pushSections(chunks, text, docTitle, doc.token, courses, doc.url || "");
    }
  }
  loadReadable(chunks);
  const { kept, alias } = preferFullText(chunks);
  cache = kept;
  aliasTo = alias;
  cacheStamp = stamp;
  return cache;
}

/** 同一篇论文的扫描短稿并到文字更完整的那一份，避免按文件名读到扫描件。 */
function preferFullText(chunks: LectureChunk[]): { kept: LectureChunk[]; alias: Map<string, string> } {
  const sizes = new Map<string, { token: string; title: string; chars: number }[]>();
  const chars = new Map<string, number>();
  const titles = new Map<string, string>();
  for (const chunk of chunks) {
    chars.set(chunk.token, (chars.get(chunk.token) ?? 0) + chunk.body.length);
    titles.set(chunk.token, chunk.docTitle);
  }
  for (const [token, title] of titles) {
    for (const id of title.match(/2\d{6}/g) ?? []) {
      const list = sizes.get(id) ?? [];
      if (!list.some((item) => item.token === token)) list.push({ token, title, chars: chars.get(token) ?? 0 });
      sizes.set(id, list);
    }
  }
  const alias = new Map<string, string>();
  const drop = new Set<string>();
  for (const group of sizes.values()) {
    if (group.length < 2) continue;
    const best = group.reduce((a, b) => (b.chars > a.chars ? b : a));
    for (const item of group) {
      if (item.token === best.token) continue;
      if (item.chars < 800 || item.chars < best.chars * 0.15) {
        alias.set(item.token, best.token);
        drop.add(item.token);
      }
    }
  }
  return { kept: chunks.filter((chunk) => !drop.has(chunk.token)), alias };
}

let aliasTo = new Map<string, string>();

function canonical(id: string): string {
  const seen = new Set<string>();
  let cur = id;
  while (aliasTo.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = aliasTo.get(cur)!;
  }
  return cur;
}

function allowedDocIds(): Set<string> | null {
  const keys = scopedLectures();
  if (!keys || keys.length === 0) return null;
  loadChunks();
  const ids = new Set<string>();
  for (const id of docsForLectures(keys)) ids.add(canonical(id));
  return ids;
}

function scopeNote(): string {
  const keys = scopedLectures();
  if (!keys || keys.length === 0) return "";
  const labels = lookupLectures(keys).map((item) => item.label);
  return labels.length ? `限定讲次：${labels.join("、")}` : "";
}

function unreadSentences(): string[] {
  const keys = scopedLectures();
  if (!keys || keys.length === 0) return [];
  return [...new Set(unreadableForLectures(keys).map((item) => item.sentence))];
}

function showBody(chunk: LectureChunk, text: string): string {
  if (!chunk.imageBase) return text;
  return text.replace(/\]\(images\//g, `](${chunk.imageBase}/images/`);
}

function hay(chunk: LectureChunk): string {
  return `${chunk.docTitle}\n${chunk.heading}\n${chunk.courses}\n${chunk.body}`.toLowerCase();
}

function tokensOf(query: string): string[] {
  const cleaned = query
    .toLowerCase()
    .replace(/什么|怎么|如何|哪些|哪个|一下|吗|呢|在哪|哪里/g, " ")
    .replace(/的/g, " ");
  const stop = new Set(["on", "of", "the", "and", "to", "in", "for", "an", "is", "are", "with", "from", "by", "or", "at"]);
  const words = cleaned.split(/[^\u4e00-\u9fffa-z0-9.+-]+/).filter((s) => s.length >= 2 && !stop.has(s));
  if (words.length > 0) return [...new Set(words)];
  const raw = query.trim().toLowerCase();
  return raw ? [raw] : [];
}

function snippet(body: string, query: string): string {
  const lower = body.toLowerCase();
  const needles = tokensOf(query);
  let at = -1;
  for (const n of needles) {
    at = lower.indexOf(n);
    if (at >= 0) break;
  }
  if (at < 0) return body.slice(0, SNIPPET);
  const start = Math.max(0, at - 80);
  const slice = body.slice(start, start + SNIPPET).trim();
  return (start > 0 ? "…" : "") + slice + (start + SNIPPET < body.length ? "…" : "");
}

function locatorOf(chunk: LectureChunk, quote: string): string {
  const page = chunk.heading.match(/第\s*\d+\s*[页张]/);
  if (page) return page[0].replace(/\s+/g, "");
  const stamp = quote.match(/\d{2}:\d{2}(?::\d{2})?/);
  if (stamp) return stamp[0];
  const heading = chunk.heading.replace(/\*+/g, "").trim();
  if (heading && heading !== chunk.docTitle) return heading.slice(0, 24);
  return "";
}

function quoteOf(chunk: LectureChunk, query: string): string {
  const text = snippet(chunk.body.replace(/^.*邻近原文.*$/gm, ""), query)
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 180);
}

function imagePaths(chunk: LectureChunk): string[] {
  const shown = showBody(chunk, chunk.body);
  return [...shown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((p) => !/\/page-\d+\./i.test(p)).slice(0, 4);
}

function formatHit(chunk: LectureChunk, query: string): string {
  const quote = quoteOf(chunk, query);
  const n = addCitation({
    title: chunk.docTitle,
    locator: locatorOf(chunk, quote),
    quote,
    url: chunk.url,
  });
  const loc = locatorOf(chunk, quote);
  const lines = [`[${n || "?"}] ${chunk.docTitle}${loc ? ` · ${loc}` : ""}`];
  if (chunk.courses) lines.push(`课程：${chunk.courses}`);
  if (chunk.url) lines.push(`链接：${chunk.url}`);
  lines.push(`原文：${quote}`);
  const images = imagePaths(chunk);
  if (images.length > 0) lines.push(`图片：${images.join(" ")}`);
  return lines.join("\n");
}

function withScope(body: string): string {
  const note = scopeNote();
  return note ? `${note}\n\n${body}` : body;
}

export function searchLectures(query: string, limit = 6): string {
  const chunks = loadChunks();
  /* 白名单只算一次：allow 回调会在排序循环里对候选反复调用，
     inScope() 每次都重算 allowedDocIds() 的老写法在 chunk 多时是 O(n) 次目录扫描。 */
  const allowed = allowedDocIds();
  const hits = hybridRank(
    chunks,
    cacheStamp,
    query,
    limit,
    allowed ? (chunk) => allowed.has(canonical(chunk.token)) : undefined,
  );
  if (hits.length === 0) {
    const unread = unreadSentences();
    if (unread.length > 0) {
      return withScope(
        `${unread.join("\n")}\n已转换的讲义没有答上。向学生原句说明无法读取，不要改成讲义里没有，也不要说这一讲没有正文。`,
      );
    }
    const missed = scopedLectures()?.length
      ? "这些讲的讲义里没有这一点。"
      : "讲义正文里没有匹配内容。可以换更短的关键词，或改用 search_curriculum 查课程表和回放链接。";
    return withScope(missed);
  }
  const blocks = hits.map(({ chunk }) => formatHit(chunk, query));
  return withScope(
    `命中 ${hits.length} 段。回答时用 [编号] 指向下面的出处，编号、页码和原文必须来自这里，不要编造。图片路径交给 read_image。\n\n${blocks.join("\n\n")}`,
  );
}

/** 进程起来后预建讲义目录和全库索引，避免第一次提问时才做。 */
export function warmRetrieval(): void {
  const chunks = loadChunks();
  hybridRank(chunks, cacheStamp, "预热", 1);
}

function paperIds(text: string): string[] {
  return text.match(/\d{5,}/g) ?? [];
}

function docMatches(chunk: LectureChunk, key: string): boolean {
  const title = chunk.docTitle.toLowerCase();
  const blob = `${chunk.token} ${title} ${chunk.courses}`.toLowerCase();
  if (blob.includes(key) || title.includes(key) || key.includes(title.replace(/\.pdf$/i, ""))) return true;
  return paperIds(key).some((id) => title.includes(id));
}

function scoreDoc(list: LectureChunk[], key: string): number {
  const title = list[0].docTitle.toLowerCase();
  const size = list.reduce((sum, chunk) => sum + chunk.body.length, 0);
  let score = Math.min(size / 80, 120);
  if (title === key) score += 100;
  else if (title.includes(key) || key.includes(title.replace(/\.pdf$/i, ""))) score += 50;
  if (paperIds(key).some((id) => title.includes(id))) score += 20;
  return score;
}

export function readLecture(doc: string, query?: string): string {
  const key = doc.trim().toLowerCase();
  if (!key) return "请提供讲义标题、课程编号或文档 token。";
  /* 白名单只算一次；旧的逐 chunk inScope() 每次都重跑 loadChunks() 验戳，
     全库 1.3 万 chunk 时单次 readLecture 同步阻塞约 30 秒（见 DIAG-REPORT.md）。 */
  const allChunks = loadChunks();
  const allowed = allowedDocIds();
  const chunks = allowed ? allChunks.filter((chunk) => allowed.has(canonical(chunk.token))) : allChunks;
  const docs = new Map<string, LectureChunk[]>();
  for (const chunk of chunks) {
    if (!docMatches(chunk, key)) continue;
    const list = docs.get(chunk.token) ?? [];
    list.push(chunk);
    docs.set(chunk.token, list);
  }
  if (docs.size === 0) {
    const outside = allChunks.some((chunk) => docMatches(chunk, key));
    if (outside && scopedLectures()?.length) {
      return withScope("这份资料不在已选的讲次里。");
    }
    return withScope(`没有名为「${doc}」的讲义。先用 search_lectures 按关键词找标题。`);
  }
  const ranked = [...docs.entries()].sort((a, b) => scoreDoc(b[1], key) - scoreDoc(a[1], key));
  const [token, all] = ranked[0];
  const picked = query?.trim()
    ? all.filter((c) => hay(c).includes(query.trim().toLowerCase()))
    : all;
  const use = picked.length > 0 ? picked : all.slice(0, 2);
  const outline = [...new Set(all.map((c) => c.heading))].slice(0, 24);
  let budget = 4200;
  const bodies: string[] = [];
  const cites: string[] = [];
  for (const chunk of use) {
    if (budget <= 0) break;
    const piece = showBody(chunk, chunk.body.slice(0, budget));
    cites.push(formatHit(chunk, query?.trim() || chunk.heading));
    bodies.push(`## ${chunk.heading}\n${piece}`);
    budget -= piece.length;
  }
  const others = ranked.slice(1, 4).map(([, list]) => list[0].docTitle);
  const lines = [
    `讲义：${all[0].docTitle}`,
    all[0].courses ? `课程：${all[0].courses}` : "",
    all[0].url ? `链接：${all[0].url}` : "",
    `文档：${token}`,
    `大纲：${outline.join(" / ")}`,
    others.length ? `其他相近讲义：${others.join("、")}` : "",
    query?.trim() && picked.length === 0 ? "该讲义中没有这句话，下面是开头两段。" : "",
    "出处：",
    cites.join("\n\n"),
    "",
    bodies.join("\n\n"),
  ];
  return withScope(lines.filter((s) => s !== "").join("\n"));
}
