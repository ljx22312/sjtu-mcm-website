# 网页导览 Agent（右下角智能助手）

基于 [pi](https://github.com/earendil-works/pi) 框架（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`）构建的官网内嵌导览助手：悬浮在页面右下角，登录后可对话，能检索集训课程库并指引站点功能。

## 架构

```
浏览器                                Node 服务（@astrojs/node SSR）
AgentWidget.astro                     /api/agent/chat（prerender=false）
  悬浮球 + 面板（vanilla JS）  ─POST→   ├─ 会话校验（复用 jAccount HMAC cookie）
  fetch + SSE 流式渲染                  ├─ 内存限流（每用户每小时 AGENT_RATE_LIMIT 条）
                                        ├─ pi Agent（每请求无状态）
                                        │    system prompt（站点导览 + 红线）
                                        │    tools: search_curriculum（只读检索 src/data 课程 JSON）
                                        │    ↓ streamSimple
                                        │  智谱 BigModel Anthropic 兼容端点（GLM-4.6）
                                        └─ 对话历史 SQLite（better-sqlite3, WAL）
/api/agent/history  GET 最近 50 条 / DELETE 清除本人记录
```

要点：

- **登录门槛**：所有 agent 接口校验 `sjtumcm_session`，未登录返回 401，前端展示登录引导。内测期可设 `AGENT_ALLOW_ANONYMOUS=1` 临时免登录（匿名访客共用 `"anonymous"` 身份与同一份历史），正式部署保持关闭。
- **无状态 agent**：每次请求从 SQLite 取最近 24 条历史喂给模型，回复落库；不使用 pi 的持久会话设施，清库/保留期就是一句 SQL。
- **只读工具**：agent 只有 `search_curriculum` 一个工具（关键词检索两张课程表），没有文件系统、shell 或网络能力；链接由数据原样返回，模型被要求不得编造 URL。
- **红线**：system prompt 明确“只介绍本协会官网内容，不提及任何外部培训/训练营项目”。
- **演示模式**：未配置 `AGENT_API_KEY` 时自动启用（pi 的 fauxProvider，不发真实请求）；配置后默认关闭，`AGENT_ALLOW_MOCK=1` 可显式保留。

## 文件

| 路径 | 职责 |
| --- | --- |
| `src/lib/agent/config.ts` | 环境变量解析（对齐 auth.ts 风格） |
| `src/lib/agent/models.ts` | pi-ai provider 装配（智谱 Anthropic 端点 / faux 演示） |
| `src/lib/agent/history.ts` | SQLite 历史层（追加/最近 N 条/清除/过期清理） |
| `src/lib/agent/tools.ts` | search_curriculum 工具 |
| `src/lib/agent/prompt.ts` | system prompt |
| `src/lib/agent/runner.ts` | 单轮执行：装配 Agent、事件桥接 SSE、落库 |
| `src/pages/api/agent/chat.ts` | POST SSE 聊天端点（401/429/400 处理） |
| `src/pages/api/agent/history.ts` | GET/DELETE 个人历史 |
| `src/components/AgentWidget.astro` | 悬浮球 + 聊天面板（scoped CSS + 原生 JS） |

## 环境变量

见 `.env.example` 的 agent 段。生产部署（`node dist/server/entry.mjs`）不会自动读 `.env`，需在进程环境中导出：

```bash
export AGENT_API_KEY=...
export AUTH_SESSION_SECRET=...
node dist/server/entry.mjs   # 内测免登录期另加 AGENT_ALLOW_ANONYMOUS=1
```

## 隐私

- 历史表只存 `account（jAccount 账号）+ 角色 + 内容 + 时间戳`，不落姓名/学号。
- 面板内置告知（“对话记录仅保存在协会服务器…”）与“清除我的对话记录”按钮。
- 保留期默认 180 天（`AGENT_HISTORY_RETENTION_DAYS`），写入时低概率惰性清理。
- 管理员默认不应查看用户原始对话；做运营统计请基于匿名关键词聚合。

## 本地联调

```bash
# 1. 演示登录拿会话 cookie（jAccount 凭据未配置时可用）
curl -c /tmp/jar -b /tmp/jar -L "http://127.0.0.1:4321/api/auth/login?mock=1&redirect=/" -o /dev/null

# 2. 发起对话（SSE 流式）
curl -N -b /tmp/jar -H 'Content-Type: application/json' \
  -d '{"message":"国赛集训论文写作课有回放吗"}' \
  http://127.0.0.1:4321/api/agent/chat

# 3. 查看自己的历史 / 清除
curl -b /tmp/jar http://127.0.0.1:4321/api/agent/history
curl -b /tmp/jar -X DELETE http://127.0.0.1:4321/api/agent/history
```

nginx 反代注意事项与登录一致：透传 `Host` 与 `X-Forwarded-Proto`；SSE 已设置 `X-Accel-Buffering: no`，无需额外配置。
