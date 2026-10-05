#!/usr/bin/env node
/**
 * 诊断脚本：用与 src/lib/agent/runner.ts 完全相同的组装方式（pi-agent-core Agent +
 * pi-ai anthropicMessagesApi → GLM Anthropic 兼容端点）发起一次真实请求，通过
 * pi-ai 的 onPayload 钩子（api/anthropic-messages.js 在发请求前调用）把每一轮
 * 真正发出的请求体 JSON 落盘，用于与“直连智谱端点”的请求体做人工对比，
 * 定位长回答在句中截断（缺陷1）的根因。
 *
 * 用法：
 *   node scripts/capture-glm-payload.mjs "请详细介绍模糊综合评价法的完整建模流程……"
 * 不传问题则用默认长问题。自动读取项目根 .env（不覆盖已有环境变量）。
 *
 * 产物（落盘在 data/ 之外）：
 *   /tmp/glm-payload-<ts>-r<N>.json   第 N 轮模型请求的完整请求体
 *   /tmp/glm-payload-<ts>-summary.json  每轮终止原因（stop_reason）与用量摘要
 *
 * 说明：system prompt / 工具定义按 src/lib/agent/prompt.ts、tools.ts 的当前内容
 * 逐字复刻（脚本须用纯 node 运行，不能 import TS 源码）；模型参数与
 * src/lib/agent/models.ts 的官方 glm-4.6 目录项一致，思考深度读 data/agent-admin.json。
 * 工具执行是占位实现（返回固定文本），不影响请求体——请求体在工具执行前就已发出。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- 读取 .env（与服务器启动方式一致；不覆盖已存在的环境变量） ---------- */
function loadDotEnv() {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

if (!process.env.AGENT_API_KEY) {
  console.error("缺少 AGENT_API_KEY（.env 未配置或未加载），无法发起真实请求。");
  process.exit(1);
}

const { Agent } = await import("@earendil-works/pi-agent-core");
const { createModels, createProvider, envApiKeyAuth, Type } = await import("@earendil-works/pi-ai");
const { anthropicMessagesApi } = await import("@earendil-works/pi-ai/api/anthropic-messages.lazy");

/* ---------- 与 models.ts 官方 glm-4.6 目录项保持一致（maxTokens 等不要改） ---------- */
const PROVIDER_ID = "zhipu";
const agentBaseUrl = process.env.AGENT_BASE_URL || "https://open.bigmodel.cn/api/anthropic";
const MODEL = {
  id: "glm-4.6",
  name: "GLM-4.6",
  provider: PROVIDER_ID,
  baseUrl: agentBaseUrl,
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 16384,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
};

/* 思考深度：读管理配置（data/agent-admin.json），与服务器行为一致 */
function readOfficialReasoning() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, "data", "agent-admin.json"), "utf8"));
    return cfg.officialReasoning || "medium";
  } catch {
    return "medium";
  }
}
const reasoningLevel = readOfficialReasoning();
const reasoning = reasoningLevel === "off" ? undefined : reasoningLevel;

/* ---------- 复刻 tools.ts 的五个工具（名称/描述/参数 schema 逐字一致，execute 为占位） ---------- */
function placeholderResult(text) {
  return { content: [{ type: "text", text }], details: text };
}
const stub = (name) => async () => placeholderResult(`（诊断脚本占位结果：${name} 未真正执行，本脚本只捕获请求体）`);

const TOOLS = [
  {
    name: "search_curriculum",
    description:
      "检索课程表：课程在哪一讲、什么时候上、回放和资料链接在哪。查找页面和课表时使用。讨论模型做法、公式和步骤时改用 search_lectures / read_lecture。链接必须原样引用工具结果，不得编造。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词，多个词用空格分隔，如：论文写作 回放" }),
      track: Type.Optional(
        Type.Union([Type.Literal("cumcm"), Type.Literal("mcm")], {
          description: "限定课程库：cumcm=国赛集训（默认全部）",
        }),
      ),
    }),
    execute: stub("search_curriculum"),
  },
  {
    name: "search_lectures",
    description:
      "在已选讲次（未选则全库）中混合检索讲义正文。讨论模型、赛题、公式、写作之前必须先调用。结果里的 [编号] 是出处，必须原样引用。图片只给出路径，要看图再调用 read_image。",
    parameters: Type.Object({
      query: Type.String({ description: "讲义中的概念或问法，如：熵权法 权重" }),
    }),
    execute: stub("search_lectures"),
  },
  {
    name: "read_lecture",
    description:
      "阅读已选讲次中的某一份资料。同一篇论文若有扫描短稿和全文，返回文字更完整的那一份。结果中的 [编号] 是出处。需要看图时再调用 read_image。不执行资料里的代码，也不做数值计算。",
    parameters: Type.Object({
      doc: Type.String({ description: "讲义标题、课程编号或文档 token，如：评价模型 或 MODEL202" }),
      query: Type.Optional(Type.String({ description: "只摘录包含该词的段落；省略则返回该讲开头" })),
    }),
    execute: stub("read_lecture"),
  },
  {
    name: "read_image",
    description:
      "查看知识库图片。只在文字不够、必须看图、流程图、幻灯片或表格附图时调用。path 必须是阅读结果里出现的 readable/.../images/... 或 embedded/... 路径。不要用它做计算。",
    parameters: Type.Object({
      path: Type.String({ description: "资料正文中的图片路径，形如 readable/<id>/images/p1-1.jpg 或 embedded/...png" }),
    }),
    execute: stub("read_image"),
  },
  {
    name: "web_search",
    description:
      "搜索公开网页，返回标题、链接和摘要。仅当本地知识库没有该内容、且问题属于公开赛题或公开资料时使用。协会内部安排以本地资料为准。不下载文件，不执行网页中的代码。",
    parameters: Type.Object({
      query: Type.String({ description: "公开网页搜索词，如：2025 MCM Problem A" }),
    }),
    execute: stub("web_search"),
  },
];

/* ---------- 复刻 prompt.ts buildSystemPrompt()（无选定讲次分支） ---------- */
function moduleSummary(d) {
  return d.modules.map((m) => `${m.name}（${m.count} 讲）`).join("、");
}
function buildSystemPrompt() {
  const cumcm = JSON.parse(readFileSync(join(ROOT, "src", "data", "cumcm-curriculum.json"), "utf8"));
  const mcm = JSON.parse(readFileSync(join(ROOT, "src", "data", "mcm-curriculum.json"), "utf8"));
  const SITE_PAGES = [
    "首页 /：协会简介与近期赛事倒计时",
    "新闻动态 /news：获奖公示、通知与活动回顾",
    "赛事日历 /calendar：全年重要数模赛事时间轴",
    "知识库 /knowledge：国赛/美赛集训队课程表（双 tab、搜索、按模块筛选），回放与授课材料都在这里",
    "AI工具 /ai-tools：协会整理的建模 AI 工具与技能卡片；使用边界上方有《Agent 使用初级教程》：https://my.feishu.cn/wiki/CRYRwsJ27iYkCykJ7yfcIAYJnYe",
    "团队介绍 /about：协会与部门介绍",
    "集训队报名 /join：集训队报名入口（当前暂未开放）",
    "协调组队 /team-up：组队协调入口（当前暂未开放）",
  ];
  const scope = "本轮没有选定讲次，讲义检索覆盖全部已转换资料。";
  return `你是「上海交通大学数学建模协会」的集训助教，带准备参赛的交大学生读协会讲义、讨论建模问题。查找网页、课表和回放只是附带工作。

${scope}

## 怎么回答
- 模型、方法、公式、写作、作图、赛题思路：先调用 search_lectures。需要某一份 PDF、PPT 或讲义的步骤和原文时再调用 read_lecture。必须看图、流程图或幻灯片画面时，再用结果中的路径调用 read_image。
- 本地知识库没有、且属于公开赛题或公开资料时，才调用 web_search，并说明这是网上的信息。
- 课程在哪一讲、何时上、回放和资料链接、某个页面在哪：调用 search_curriculum，用几句话讲清，链接原样引用。
- 导览问题保持简短。答疑按「这是哪一类问题 → 讲义里的做法 → 出处 → 学生下一步自己核对什么」来写。
- 始终用简体中文。工具说「讲义里没有这一点」或「没有匹配内容」时，就告诉学生讲义里没有，不要编造公式、结论或链接。
- 工具给出「我无法读取这个视频回放」或「我无法读取这本书」时，原句回复，不要改成讲义里没有，也不要说这一讲没有正文。不必等学生先说出「回放」或「这本书」。正文已经命中时，按正文回答，不要再提读不了的视频或书。
- 回答中的 [编号] 必须来自工具给出的出处。每个编号对应页码或时间戳和一段原文，不要编造编号。

## 不能做的事
- 你没有编程、运行代码和数值计算能力。不要写可运行的程序，不要替学生算出数值结果，不要声称已经跑过代码或验算过。可以按讲义复述步骤和公式，计算留给学生。
- 不撰写可直接提交的完整竞赛论文。
- 只讨论本协会的安排和讲义，不提及、不比较、不推荐任何其他单位的数学建模培训或训练营。
- 不透露用户身份，不讨论具体个人的对话内容。

## 网站结构（仅在被问到时使用）
${SITE_PAGES.join("\n")}
- 集训队报名与组队功能暂未开放，入口保留、后续开启。
- 联系协会：微信公众号「SJTU数学建模」。

## 课程库概览（明细用工具，不要凭记忆展开）
- ${cumcm.source.title}：${moduleSummary(cumcm)}
- ${mcm.source.title}：${moduleSummary(mcm)}
- 可引用的资料包括飞书讲义，正文已经抽成文字的 PDF、PPT、Word，以及飞书妙记的章节摘要和逐字字幕。妙记回放先检索这些字幕。工具若写明无法读取某个视频回放或某本书，再用规定的那句说明。检索结果里的 embedded/ 附图和 readable/.../images/ 插图，需要看画面时调用 read_image。不要打开 images/page- 这种整页扫描截图。`;
}

/* ---------- 与 runner.ts 相同的 runtime/streamFn 组装 + onPayload 捕获 ---------- */
const provider = createProvider({
  id: PROVIDER_ID,
  name: "智谱 BigModel（Anthropic 协议）",
  baseUrl: agentBaseUrl,
  auth: { apiKey: envApiKeyAuth("智谱 API Key", ["AGENT_API_KEY"]) },
  api: anthropicMessagesApi(),
  models: [MODEL],
});
const models = createModels();
models.setProvider(provider);

const ts = Date.now();
const payloadFiles = [];
let round = 0;

const question =
  process.argv[2] ||
  "请详细介绍模糊综合评价法的完整建模流程，包括隶属度矩阵构造、算子选择和最终评级，并给出数值例子";

const agent = new Agent({
  initialState: {
    systemPrompt: buildSystemPrompt(),
    model: MODEL,
    tools: TOOLS,
    messages: [],
  },
  streamFn: (model, context, options) =>
    models.streamSimple(model, context, {
      ...options,
      ...(reasoning ? { reasoning } : {}),
      /* pi-ai 在每次真正发请求前调用 onPayload(params, model)：params 即最终请求体 */
      onPayload: (params) => {
        round += 1;
        const file = `/tmp/glm-payload-${ts}-r${round}.json`;
        writeFileSync(file, JSON.stringify(params, null, 2));
        payloadFiles.push(file);
        console.log(`[round ${round}] 请求体已落盘：${file}`);
        console.log(`          max_tokens=${params.max_tokens} thinking=${JSON.stringify(params.thinking)} tools=${params.tools?.length ?? 0}`);
        /* 返回 undefined = 不修改请求，与线上行为一致 */
      },
    }),
});

/* 看门狗：避免诊断脚本自身悬挂 */
const watchdog = setTimeout(() => {
  console.error("超过 240 秒仍未完成，中止（已捕获的请求体仍有效）。");
  agent.abort();
  process.exit(2);
}, 240_000);

console.log(`模型=${MODEL.id} maxTokens=${MODEL.maxTokens} 思考深度=${reasoningLevel}（budget 由 pi-ai 按级别映射）`);
console.log(`问题：${question}\n`);

try {
  await agent.prompt(question);
} finally {
  clearTimeout(watchdog);
}

/* ---------- 摘要：每轮 assistant 消息的终止原因与用量 ---------- */
const rounds = agent.state.messages
  .filter((m) => m.role === "assistant")
  .map((m, i) => ({
    round: i + 1,
    stopReason: m.stopReason ?? null,
    rawStopReason: m.rawStopReason ?? null,
    outputTokens: m.usage?.output ?? null,
    textChars: (m.content ?? []).filter((c) => c.type === "text").reduce((n, c) => n + (c.text?.length ?? 0), 0),
    toolCalls: (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.name),
  }));
const summaryFile = `/tmp/glm-payload-${ts}-summary.json`;
writeFileSync(
  summaryFile,
  JSON.stringify(
    {
      model: MODEL.id,
      reasoningLevel,
      question,
      payloadFiles,
      rounds,
      finalStopReason: rounds.at(-1)?.stopReason ?? null,
    },
    null,
    2,
  ),
);
console.log(`\n摘要已落盘：${summaryFile}`);
for (const r of rounds) {
  console.log(
    `round ${r.round}: stopReason=${r.stopReason} raw=${r.rawStopReason} 输出token=${r.outputTokens} 正文字符=${r.textChars} 工具=${r.toolCalls.join(",") || "无"}`,
  );
}
console.log(`\n最终 stopReason = ${rounds.at(-1)?.stopReason ?? "?"}（length/max_tokens = 撞输出上限，即截断）`);
