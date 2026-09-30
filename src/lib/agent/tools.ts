/**
 * agent 可用的工具：只读检索本站数据，不给文件系统/网络能力。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import cumcmData from "../../data/cumcm-curriculum.json";
import mcmData from "../../data/mcm-curriculum.json";

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
    "在协会集训队课程库（国赛集训 38 讲、美赛集训 68 讲）中按关键词检索课程主题、课程介绍、授课材料与回放链接。回答任何与集训课程内容相关的问题前都应先调用本工具，链接必须原样引用工具结果中的 URL，不得自行编造。",
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

export const agentTools = [searchCurriculumTool];
