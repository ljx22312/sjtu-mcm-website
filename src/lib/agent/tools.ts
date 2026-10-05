/**
 * agent 可用的工具：只读检索课程表、已转换资料和公开网页。
 * 不提供写文件、编程或数值计算。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import cumcmData from "../../data/cumcm-curriculum.json";
import mcmData from "../../data/mcm-curriculum.json";
import { readLecture, searchLectures } from "./corpus";
import { readKnowledgeImage } from "./media";
import { webSearch } from "./web";

interface CurriculumResource {
  type: "link" | "doc" | "attachment";
  name: string;
  url?: string;
  token?: string;
  size_kb?: number;
}

interface CurriculumItem {
  row: number;
  module: string;
  course_id: string;
  topic: string;
  format: string;
  intro: string;
  contact: string;
  no_playback?: boolean;
  resources: CurriculumResource[];
}

interface CurriculumFile {
  modules: { name: string; count: number }[];
  items: CurriculumItem[];
}

const TRACKS: Record<"cumcm" | "mcm", { label: string; data: CurriculumFile }> = {
  cumcm: { label: "国赛集训", data: cumcmData as unknown as CurriculumFile },
  mcm: { label: "美赛集训", data: mcmData as unknown as CurriculumFile },
};

function searchableText(it: CurriculumItem): string {
  const parts = [it.module, it.course_id, it.topic, it.intro, it.contact, it.format];
  for (const r of it.resources) parts.push(r.name);
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function formatItem(track: "cumcm" | "mcm", it: CurriculumItem): string {
  const lines: string[] = [];
  const head = [
    `【${TRACKS[track].label} · ${it.module}】`,
    it.course_id ? `课程编号 ${it.course_id}` : "",
    it.topic,
  ]
    .filter(Boolean)
    .join(" ");
  lines.push(head);
  if (it.format) lines.push(`形式与安排：${it.format}`);
  if (it.intro) lines.push(`介绍：${truncate(it.intro, 240)}`);
  if (it.contact) lines.push(`联络人：${it.contact}`);
  if (it.resources.length > 0) {
    const res = it.resources.map((r) =>
      r.url ? `「${r.name}」${r.url}` : `「${r.name}」（飞书内${r.type === "attachment" ? "附件" : "文档"}，仅协会成员可见）`,
    );
    lines.push(`资料与回放：${res.join("；")}`);
  }
  if (it.no_playback) lines.push("（该课程无回放）");
  return lines.join("\n");
}

const searchParameters = Type.Object({
  query: Type.String({ description: "检索关键词，多个词用空格分隔，如：论文写作 回放" }),
  track: Type.Optional(
    Type.Union([Type.Literal("cumcm"), Type.Literal("mcm")], {
      description: "限定课程库：cumcm=国赛集训（默认全部）",
    }),
  ),
});

/** 在两张集训课程表（共 106 行）里按关键词检索课程、资料与回放 */
export const searchCurriculumTool: AgentTool<typeof searchParameters> = {
  name: "search_curriculum",
  label: "检索集训课程库",
  description:
    "检索课程表：课程在哪一讲、什么时候上、回放和资料链接在哪。查找页面和课表时使用。讨论模型做法、公式和步骤时改用 search_lectures / read_lecture。链接必须原样引用工具结果，不得编造。",
  parameters: searchParameters,
  async execute(_toolCallId, params) {
    const tokens = params.query.toLowerCase().split(/\s+/).filter(Boolean);
    const tracks = params.track ? [params.track] : (Object.keys(TRACKS) as ("cumcm" | "mcm")[]);
    const hits: { score: number; text: string }[] = [];

    for (const track of tracks) {
      for (const it of TRACKS[track].data.items) {
        const hay = searchableText(it);
        let score = 0;
        for (const t of tokens) if (hay.includes(t)) score++;
        if (score > 0) hits.push({ score, text: formatItem(track, it) });
      }
    }

    if (hits.length === 0) {
      return textResult("没有找到匹配的课程。可提示用户换更短的关键词，或说明知识库页面支持按模块浏览。");
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, 8);
    const summary = top.map((h) => h.text).join("\n\n");
    return textResult(
      `共命中 ${hits.length} 条，按相关度返回前 ${top.length} 条：\n\n${summary}`,
    );
  },
};

function textResult(text: string): AgentToolResult<string> {
  return { content: [{ type: "text", text }], details: text };
}

const lectureQuery = Type.Object({
  query: Type.String({ description: "讲义中的概念或问法，如：熵权法 权重" }),
});

/** 在已下载的云文档讲义里按关键词找段落 */
export const searchLecturesTool: AgentTool<typeof lectureQuery> = {
  name: "search_lectures",
  label: "检索讲义正文",
  description:
    "在已选讲次（未选则全库）中混合检索讲义正文。讨论模型、赛题、公式、写作之前必须先调用。结果里的 [编号] 是出处，必须原样引用。图片只给出路径，要看图再调用 read_image。",
  parameters: lectureQuery,
  async execute(_toolCallId, params) {
    return textResult(searchLectures(params.query));
  },
};

const readParameters = Type.Object({
  doc: Type.String({ description: "讲义标题、课程编号或文档 token，如：评价模型 或 MODEL202" }),
  query: Type.Optional(Type.String({ description: "只摘录包含该词的段落；省略则返回该讲开头" })),
});

/** 读取某一讲的大纲和正文摘录 */
export const readLectureTool: AgentTool<typeof readParameters> = {
  name: "read_lecture",
  label: "阅读一讲",
  description:
    "阅读已选讲次中的某一份资料。同一篇论文若有扫描短稿和全文，返回文字更完整的那一份。结果中的 [编号] 是出处。需要看图时再调用 read_image。不执行资料里的代码，也不做数值计算。",
  parameters: readParameters,
  async execute(_toolCallId, params) {
    return textResult(readLecture(params.doc, params.query));
  },
};

const imageParameters = Type.Object({
  path: Type.String({ description: "资料正文中的图片路径，形如 readable/<id>/images/p1-1.jpg 或 embedded/...png" }),
});

/** 把一张资料图交给模型看。不分析像素以外的计算。 */
export const readImageTool: AgentTool<typeof imageParameters> = {
  name: "read_image",
  label: "阅读图片",
  description:
    "查看知识库图片。只在文字不够、必须看图、流程图、幻灯片或表格附图时调用。path 必须是阅读结果里出现的 readable/.../images/... 或 embedded/... 路径。不要用它做计算。",
  parameters: imageParameters,
  async execute(_toolCallId, params) {
    return readKnowledgeImage(params.path);
  },
};

const webParameters = Type.Object({
  query: Type.String({ description: "公开网页搜索词，如：2025 MCM Problem A" }),
});

/** 本地知识库没有的公开信息才搜索。 */
export const webSearchTool: AgentTool<typeof webParameters> = {
  name: "web_search",
  label: "上网搜索",
  description:
    "搜索公开网页，返回标题、链接和摘要。仅当本地知识库没有该内容、且问题属于公开赛题或公开资料时使用。协会内部安排以本地资料为准。不下载文件，不执行网页中的代码。",
  parameters: webParameters,
  async execute(_toolCallId, params) {
    return textResult(await webSearch(params.query));
  },
};

export const agentTools = [searchCurriculumTool, searchLecturesTool, readLectureTool, readImageTool, webSearchTool];
