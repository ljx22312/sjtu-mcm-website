# 网页导览 Agent（右下角智能助手）

基于 [pi](https://github.com/earendil-works/pi) 框架（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`）构建的官网内嵌导览助手：悬浮在页面右下角，登录后可对话，能检索集训课程库并指引站点功能。

## 架构

```
浏览器                                Node 服务（@astrojs/node SSR）
AgentWidget.astro                     /api/agent/chat（prerender=false）
  悬浮球 + 面板（vanilla JS）  ─POST→   ├─ 会话校验（复用 jAccount HMAC cookie）
  fetch + SSE 流式渲染                  ├─ 内存限流（官方 AGENT_RATE_LIMIT 条/时；自带 API 100 条/时）
  模型设置页（localStorage）            ├─ pi Agent（每请求无状态）
  ├─ 自带 API（BYOK，Anthropic 协议）   │    system prompt（站点导览 + 红线）
  └─ 管理员：官方参数控制               │    tools: search_curriculum（只读检索 src/data 课程 JSON）
                                        │    ↓ streamSimple（模型/思考深度见下）
                                        │  智谱 BigModel Anthropic 兼容端点（GLM 系列）
                                        └─ 对话历史 SQLite（better-sqlite3, WAL）

/api/agent/history   GET 最近 50 条 / DELETE 清除本人记录
/api/agent/settings  GET 面板设置页信息 / POST 管理员改官方模型参数
```

要点：

- **登录门槛**：所有 agent 接口校验 `sjtumcm_session`，未登录返回 401，前端展示登录引导（直达 jAccount 并回跳当前页）。
- **无状态 agent**：每次请求从 SQLite 取最近 24 条历史喂给模型，回复落库；不使用 pi 的持久会话设施，清库/保留期就是一句 SQL。
- **只读工具**：agent 只有 `search_curriculum` 一个工具（关键词检索两张课程表），没有文件系统、shell 或网络能力；链接由数据原样返回，模型被要求不得编造 URL。
- **红线**：system prompt 明确“只介绍本协会官网内容，不提及任何外部培训/训练营项目”。
- **演示模式**：未配置 `AGENT_API_KEY` 时自动启用（pi 的 fauxProvider，不发真实请求）；配置后默认关闭，`AGENT_ALLOW_MOCK=1` 可显式保留。

## 模型与思考深度（两类用户）

| | 官方模型用户（默认） | 自带 API 用户（BYOK） |
| --- | --- | --- |
| 配置来源 | 服务器 `data/agent-admin.json` | 用户浏览器 localStorage（`agent-custom-llm`） |
| 模型 | `officialModel`（如 glm-4.6） | 用户自填（Anthropic 协议端点任意模型） |
| 思考深度 | `officialReasoning`（off→high 五档） | 用户自选五档，即时生效 |
| 谁能改 | 仅管理员 | 用户自己（面板「模型设置」） |
| 限流 | 窗口制：`AGENT_WINDOW_MESSAGES`（默认 60）/ `AGENT_WINDOW_MINUTES`（默认 300），首条提问开窗、到期整窗恢复；历史库持久计数，管理页可按账号覆盖 | `AGENT_RATE_LIMIT_CUSTOM`（默认 100/时，内存突发限流） |
| API Key | 进程环境 `AGENT_API_KEY` | 仅存用户浏览器，随聊天请求携带，**服务器不落盘** |

- **思考深度档位**（pi-ai `ThinkingLevel`）：`off` 不请求思考（最快最省）；`minimal/low/medium/high` 对应思考预算 1024/2048/8192/16384 tokens（Anthropic 端点按 `thinking` 参数下发）。
- **管理控制台**：`data/agent-admin.json`（gitignore 内，改完即生效，无需重启）：

```json
{
  "officialModel": "glm-4.6",
  "officialReasoning": "medium",
  "admins": ["alice"]
}
```

管理员（此文件 `admins` ∪ 环境变量 `AGENT_ADMIN_ACCOUNTS`）打开面板「模型设置」还能看到「官方模型参数」区块，保存会写回此文件（走 `POST /api/agent/settings`）。普通用户完全看不到官方模型与深度的任何调节入口。
- **BYOK 安全约束**：自定义端点强制 `https://`（防 SSRF 打内网）；Key 不写日志、不进历史库；官方 Key 未配置（演示模式）时忽略 custom 配置。

## 文件

| 路径 | 职责 |
| --- | --- |
| `src/lib/agent/config.ts` | 环境变量解析（对齐 auth.ts 风格） |
| `src/lib/agent/models.ts` | pi-ai provider 装配：官方运行时（管理配置选模型/深度）与 BYOK 运行时（请求级 Key） |
| `src/lib/agent/admin.ts` | 管理控制台：data/agent-admin.json 读写（mtime 缓存热更新）+ 管理员判定 |
| `src/lib/agent/history.ts` | SQLite 历史层（追加/最近 N 条/清除/过期清理/用量统计） |
| `src/lib/agent/usage.ts` | 按账号限额：data/agent-limits.json 读写（mtime 热更新）、覆盖值与全局默认合并 |
| `src/pages/staff/agent.astro` | 管理页「AI 助手管理」：用量一览、按账号限额、查看/撤回任意会话 |
| `src/pages/api/admin/agent/*` | 管理端点：overview / limits / sessions / messages / retract（site-gate 守卫） |
| `src/lib/agent/tools.ts` | search_curriculum 工具 |
| `src/lib/agent/prompt.ts` | system prompt |
| `src/lib/agent/runner.ts` | 单轮执行：装配 Agent、事件桥接 SSE、落库 |
| `src/pages/api/agent/chat.ts` | POST SSE 聊天端点（401/429/400 处理、BYOK 配置校验与双档限流） |
| `src/pages/api/agent/history.ts` | GET/DELETE 个人历史 |
| `src/pages/api/agent/settings.ts` | GET 设置页信息 / POST 管理员改官方参数（403 拒绝非管理员） |
| `src/components/AgentWidget.astro` | 悬浮球 + 聊天面板 + 模型设置页（scoped CSS + 原生 JS） |

## 环境变量

见 `.env.example` 的 agent 段。生产部署（`node dist/server/entry.mjs`）不会自动读 `.env`，需在进程环境中导出：

```bash
export AGENT_API_KEY=...
export AUTH_SESSION_SECRET=...
node dist/server/entry.mjs
```

## 隐私

- 历史表只存 `account（jAccount 账号）+ 角色 + 内容 + 时间戳`，不落姓名/学号。
- 面板内置告知（“对话记录仅保存在协会服务器…”）与“清除我的对话记录”按钮。
- 保留期默认 180 天（`AGENT_HISTORY_RETENTION_DAYS`），写入时低概率惰性清理。
- 管理员默认不应查看用户原始对话；做运营统计请基于匿名关键词聚合。

## 本地联调

```bash
# 1. 浏览器登录 jAccount 拿会话 cookie（导出 sjtumcm_session 后供 curl 使用）

# 2. 发起对话（SSE 流式）；custom 为可选的自带 API 配置
curl -N -b /tmp/jar -H 'Content-Type: application/json' \
  -d '{"message":"国赛集训论文写作课有回放吗"}' \
  http://127.0.0.1:4321/api/agent/chat

curl -N -b /tmp/jar -H 'Content-Type: application/json' \
  -d '{"message":"你好","custom":{"baseUrl":"https://open.bigmodel.cn/api/anthropic","apiKey":"sk-…","model":"glm-4.5-air","reasoning":"low"}}' \
  http://127.0.0.1:4321/api/agent/chat

# 3. 查看自己的历史 / 清除
curl -b /tmp/jar http://127.0.0.1:4321/api/agent/history
curl -b /tmp/jar -X DELETE http://127.0.0.1:4321/api/agent/history

# 4. 管理员读取/修改官方模型参数（admins 含 demo 时）
curl -b /tmp/jar http://127.0.0.1:4321/api/agent/settings
curl -b /tmp/jar -X POST -H 'Content-Type: application/json' \
  -d '{"officialModel":"glm-4.5-air","officialReasoning":"low"}' \
  http://127.0.0.1:4321/api/agent/settings
```

nginx 反代注意事项与登录一致：透传 `Host` 与 `X-Forwarded-Proto`；SSE 已设置 `X-Accel-Buffering: no`，无需额外配置。
