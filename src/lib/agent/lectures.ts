/**
 * 课程表一行（一讲）到助手可读稿的对应。
 * 键是课程表里的飞书 token、妙记链接和附件 token，不是重构后的文件名。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import cumcmData from "../../data/cumcm-curriculum.json";
import mcmData from "../../data/mcm-curriculum.json";

export const VIDEO_UNREADABLE = "我无法读取这个视频回放";
export const BOOK_UNREADABLE = "我无法读取这本书";

export interface LectureInfo {
  key: string;
  label: string;
}

export interface UnreadableItem {
  kind: "video" | "book";
  name: string;
  sentence: string;
}

interface Resource {
  type?: string;
  name?: string;
  url?: string;
  token?: string;
}

interface CourseItem {
  row: number;
  module?: string;
  course_id?: string;
  topic?: string;
  resources?: Resource[];
}

interface DocRec {
  id: string;
  title: string;
  source: string;
}

const ROOT = join(process.cwd(), "data", "knowledge");
const DATA_EXT = new Set([".csv", ".xlsx", ".xls", ".txt"]);

let cache: {
  docsOf: Map<string, string[]>;
  unreadableOf: Map<string, UnreadableItem[]>;
  labels: Map<string, string>;
} | null = null;

function front(text: string): { title: string; source: string; kind: string } {
  const title = text.match(/^title:\s*(.*)$/m)?.[1]?.trim() ?? "";
  const source = text.match(/^source:\s*(.*)$/m)?.[1]?.trim() ?? "";
  const kind = text.match(/^kind:\s*(.*)$/m)?.[1]?.trim() ?? "";
  return { title, source, kind };
}

function isBook(name: string): boolean {
  return name.includes("数理统计") && name.includes("韦来生");
}

function isData(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && DATA_EXT.has(lower.slice(dot));
}

function zipMembers(path: string): string[] {
  const proc = spawnSync("python3", ["-c", "import sys,zipfile\nfrom pathlib import Path\nz=zipfile.ZipFile(sys.argv[1])\nprint('\\n'.join(Path(i.filename).name for i in z.infolist() if not i.is_dir()))", path], {
    encoding: "utf8",
  });
  if (proc.status !== 0) return [];
  return proc.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

function affinity(hint: string, source: string): number {
  if (!hint) return 0;
  if (source.includes(hint)) return 100 + hint.length;
  let n = 0;
  for (const ch of hint) if (source.includes(ch)) n += 1;
  return n;
}

function loadDocs(): DocRec[] {
  const docs: DocRec[] = [];
  const manifestPath = join(ROOT, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      docs?: { ok?: boolean; token?: string; path?: string; names?: string[]; title?: string }[];
    };
    for (const doc of manifest.docs ?? []) {
      if (!doc.ok || !doc.token) continue;
      docs.push({
        id: doc.token,
        title: doc.names?.[0] || doc.title || doc.token,
        source: doc.path || `data/knowledge/docs/${doc.token}.md`,
      });
    }
  }
  const readable = join(ROOT, "readable");
  if (existsSync(readable)) {
    for (const name of readdirSync(readable)) {
      const md = join(readable, name, "doc.md");
      if (!existsSync(md)) continue;
      const head = readFileSync(md, "utf8").slice(0, 1200);
      const fm = front(head);
      docs.push({ id: name, title: fm.title || name, source: fm.source });
    }
  }
  return docs;
}

function tokenOfFile(name: string): string {
  return name.match(/^([A-Za-z0-9]{20,})_/)?.[1] ?? "";
}

function urlToken(url: string): { kind: "minutes" | "doc" | "tencent" | ""; token: string } {
  if (url.includes("meeting.tencent.com")) return { kind: "tencent", token: "" };
  const minutes = url.match(/\/minutes\/([A-Za-z0-9]+)/);
  if (minutes) return { kind: "minutes", token: minutes[1] };
  const doc = url.match(/\/(?:docx|wiki)\/([A-Za-z0-9]+)/);
  if (doc) return { kind: "doc", token: doc[1] };
  return { kind: "", token: "" };
}

function build() {
  const docs = loadDocs();
  const byToken = new Map<string, Set<string>>();
  const unpackedByBase = new Map<string, DocRec[]>();
  const addToken = (token: string, id: string) => {
    if (!token) return;
    const set = byToken.get(token) ?? new Set<string>();
    set.add(id);
    byToken.set(token, set);
  };
  for (const doc of docs) {
    for (const match of doc.source.matchAll(/[A-Za-z0-9]{20,}/g)) addToken(match[0], doc.id);
    for (const match of doc.source.matchAll(/\/minutes\/([A-Za-z0-9]+)/g)) addToken(match[1], doc.id);
    if (doc.source.includes("/unpacked/")) {
      const base = basename(doc.source);
      const list = unpackedByBase.get(base) ?? [];
      list.push(doc);
      unpackedByBase.set(base, list);
    }
  }

  const zips: { token: string; hint: string; path: string }[] = [];
  const collectZips = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) collectZips(abs);
      else if (ent.name.toLowerCase().endsWith(".zip")) {
        zips.push({ token: tokenOfFile(ent.name), hint: ent.name.replace(/^[A-Za-z0-9]{20,}_/, "").replace(/\.zip$/i, ""), path: abs });
      }
    }
  };
  collectZips(join(ROOT, "files"));
  collectZips(join(ROOT, "embedded"));

  const zipDocs = new Map<string, Set<string>>();
  const zipVideos = new Map<string, string[]>();
  const zipBooks = new Set<string>();
  for (const zip of zips) {
    if (!zip.token) continue;
    const members = zipMembers(zip.path);
    const ids = zipDocs.get(zip.token) ?? new Set<string>();
    for (const member of members) {
      const lower = member.toLowerCase();
      if (lower.endsWith(".mov") || lower.endsWith(".mp4")) {
        const videos = zipVideos.get(zip.token) ?? [];
        videos.push(member);
        zipVideos.set(zip.token, videos);
      }
      if (isBook(member)) zipBooks.add(zip.token);
      if (isData(member) || isBook(member)) continue;
      const cands = unpackedByBase.get(member) ?? [];
      if (cands.length === 0) continue;
      const best = Math.max(...cands.map((d) => affinity(zip.hint, d.source)));
      for (const cand of cands) {
        if (affinity(zip.hint, cand.source) === best) ids.add(cand.id);
      }
    }
    zipDocs.set(zip.token, ids);
  }

  const docsOf = new Map<string, string[]>();
  const unreadableOf = new Map<string, UnreadableItem[]>();
  const labels = new Map<string, string>();

  const take = (token: string, into: Set<string>) => {
    for (const id of byToken.get(token) ?? []) into.add(id);
    for (const id of zipDocs.get(token) ?? []) into.add(id);
  };

  const noteVideo = (into: UnreadableItem[], name: string) => {
    if (into.some((item) => item.kind === "video" && item.name === name)) return;
    into.push({ kind: "video", name, sentence: VIDEO_UNREADABLE });
  };
  const noteBook = (into: UnreadableItem[]) => {
    if (into.some((item) => item.kind === "book")) return;
    into.push({ kind: "book", name: "数理统计（韦来生）", sentence: BOOK_UNREADABLE });
  };

  const absorbFile = (fileName: string, token: string, docs: Set<string>, unread: UnreadableItem[]) => {
    if (isBook(fileName)) {
      noteBook(unread);
      return;
    }
    if (isData(fileName)) return;
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".mov") || lower.endsWith(".mp4")) {
      noteVideo(unread, fileName);
      return;
    }
    take(token, docs);
    if (lower.endsWith(".zip")) {
      for (const name of zipVideos.get(token) ?? []) noteVideo(unread, name);
      if (zipBooks.has(token)) noteBook(unread);
    }
  };

  const walkDirFiles = (token: string, docs: Set<string>, unread: UnreadableItem[]) => {
    const dir = join(ROOT, "embedded", token);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    for (const name of readdirSync(dir)) {
      const childToken = tokenOfFile(name);
      absorbFile(name, childToken || token, docs, unread);
    }
  };

  const bindResource = (res: Resource, docs: Set<string>, unread: UnreadableItem[]) => {
    const url = (res.url ?? "").split("?")[0];
    if (url) {
      const parsed = urlToken(url);
      if (parsed.kind === "tencent") {
        noteVideo(unread, res.name || "回放");
        return;
      }
      if (parsed.kind === "minutes") {
        const ids = byToken.get(parsed.token);
        if (!ids || ids.size === 0) noteVideo(unread, res.name || "回放");
        else for (const id of ids) docs.add(id);
        return;
      }
      if (parsed.kind === "doc") {
        take(parsed.token, docs);
        walkDirFiles(parsed.token, docs, unread);
        return;
      }
    }
    if (res.token) {
      const file = readdirSync(join(ROOT, "files")).find((name) => name.startsWith(`${res.token}_`));
      if (file) absorbFile(file, res.token, docs, unread);
      else {
        take(res.token, docs);
        walkDirFiles(res.token, docs, unread);
      }
    }
  };

  const addLecture = (track: "cumcm" | "mcm", item: CourseItem) => {
    const key = `${track}:${item.row}`;
    const label = [item.course_id, item.topic].filter(Boolean).join(" ") || `第 ${item.row} 行`;
    labels.set(key, label);
    const docs = new Set<string>();
    const unread: UnreadableItem[] = [];
    for (const res of item.resources ?? []) bindResource(res, docs, unread);
    docsOf.set(key, [...docs]);
    unreadableOf.set(key, unread);
  };

  for (const item of (cumcmData as { items: CourseItem[] }).items) addLecture("cumcm", item);
  for (const item of (mcmData as { items: CourseItem[] }).items) addLecture("mcm", item);
  cache = { docsOf, unreadableOf, labels };
}

function catalog() {
  if (!cache) build();
  return cache!;
}

/** 启动时建好讲次目录。已经建过则直接返回。 */
export function ensureLectureCatalog(): void {
  catalog();
}

export function docsForLectures(keys: string[]): string[] {
  const { docsOf } = catalog();
  const ids = new Set<string>();
  for (const key of keys) for (const id of docsOf.get(key) ?? []) ids.add(id);
  return [...ids];
}

export function unreadableForLectures(keys: string[]): UnreadableItem[] {
  const { unreadableOf } = catalog();
  const seen = new Set<string>();
  const out: UnreadableItem[] = [];
  for (const key of keys) {
    for (const item of unreadableOf.get(key) ?? []) {
      const sig = `${item.kind}:${item.name}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(item);
    }
  }
  return out;
}

export function lookupLectures(keys: string[]): LectureInfo[] {
  const { labels } = catalog();
  return keys.filter((key) => labels.has(key)).map((key) => ({ key, label: labels.get(key)! }));
}

export function lectureCount(): { lectures: number; withDocs: number; videos: number; books: number } {
  const { docsOf, unreadableOf } = catalog();
  let withDocs = 0;
  let videos = 0;
  let books = 0;
  for (const ids of docsOf.values()) if (ids.length > 0) withDocs += 1;
  for (const items of unreadableOf.values()) {
    if (items.some((item) => item.kind === "video")) videos += 1;
    if (items.some((item) => item.kind === "book")) books += 1;
  }
  return { lectures: docsOf.size, withDocs, videos, books };
}
