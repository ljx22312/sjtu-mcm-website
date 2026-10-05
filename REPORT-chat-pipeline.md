# fix/chat-pipeline 修复报告

分支：`fix/chat-pipeline`（worktree `/root/fix-b`）。三项任务：截断可感知、回合总超时、诊断脚本。

## 一、改动清单（均在白名单内）

| 文件 | 改动 |
|---|---|
| `src/lib/agent/runner.ts` | ① 回合总超时：`agentTurnTimeoutMs()` 读 `AGENT_TURN_TIMEOUT_MS`（默认 180000ms），在 `runAgentTurn` 用独立 AbortController 计时，到点 abort 并汇入既有 signal 链（与用户手动停止同一条通路），结果带 `timedOut` 标记；② 截断检测：回合结束后检查最终 assistant 消息 `stopReason === "length"` 或 `rawStopReason === "max_tokens"`（不做任何启发式），结果带 `truncated` 标记 |
| `src/pages/api/agent/chat.ts` | ① SSE 新增 `{"type":"truncated"}` 事件（在 done 之前发）；`done` 事件可选 `timeout:true` 字段（超时停止时）；② 兜底护栏：`runAgentTurn` 包在 Promise.race 里，超时值 +15s 宽限后仍未返回则强制按 `done{stopped,timeout}` 收尾并 `controller.close()`，且 close 放进 `finally`——任何路径都保证 SSE 关闭 |
| `src/components/AgentWidget.astro` | ① 处理 `truncated` 事件：在该条回答下追加 status 提示「回答达到模型输出上限，可能在句中被截断。可以让我换个角度继续，或缩小问题范围。」（挂在 turn 上，随撤回一起删除）；② `done` 带 `timeout:true` 时追加「本轮用时较长，已自动停止；已生成的内容保留，可以继续提问。」；③ 收到 `done`/`error` 立即退出读流并 `reader.cancel()`，输入框恢复不再依赖服务器关闭连接（缺陷2 的前端兜底） |
| `scripts/capture-glm-payload.mjs`（新建） | 诊断脚本，详见第四节 |
| `evidence/*` | 验收脚本与证据（JSON 结果 + 截图 + 捕获的请求体副本） |

SSE 协议向后兼容：新事件 `truncated` 与新字段 `timeout` 对旧前端是未知类型/多余字段，会被忽略。

## 二、pi-ai / pi-agent-core 暴露的终止信息（源码依据）

- `pi-ai/dist/api/anthropic-messages.js:568-570`：收到 `message_delta.stop_reason` 时记录 `rawStopReason` 并经 `mapStopReason` 映射；
- 同文件 `:1187-1205`：`mapStopReason` 把 Anthropic 的 `"max_tokens"` 映射为 `stopReason:"length"`，`"end_turn"`/`"pause_turn"` 映射为 `"stop"`；
- `pi-agent-core/dist/agent-loop.js:141-154`：`streamAssistantResponse` 的返回值（含 stopReason）原样进入 `context.messages`，即 `agent.state.messages` 的最终 assistant 消息保留真实终止原因——runner 可直接读取。
- **结论：stop_reason 拿得到**（走第一分支实现，无需 onResponse/onPayload 兜底；onPayload 另用于诊断脚本）。
- 请求参数依据（截断根因相关）：`pi-ai/dist/api/simple-options.js:54-63` `adjustMaxTokensForThinking`：`maxTokens = min(baseMaxTokens + thinkingBudget, model.maxTokens)`。本站 model.maxTokens=16384（models.ts，未动）、medium 档 budget=8192 → **实际请求 max_tokens=16384 且 thinking budget 8192 含在其中**，正文配额仅约 8k token。

## 三、验收数据（全部有 JSON+截图在 evidence/）

| 用例 | 输入框恢复时长 | 截断提示 | 超时提示 | JS 报错 | 备注 |
|---|---|---|---|---|---|
| long1 模糊综合评价法（默认 180s） | **118228ms**（自然 done） | 无 | 无 | 0 | 回答 4521 字符止于 OCR 乱码句中——缺陷1现场复现，但 GLM 未报 max_tokens（见第五节） |
| long2 熵权法+AHP（默认 180s） | **180088ms** | 无 | **有** | 0 | 默认 180s 超时触发：SSE `done:stopped:timeout` 收尾、提示渲染、输入框恢复 |
| long3 GM(1,1)（`AGENT_TURN_TIMEOUT_MS=30000`） | **30481ms ≤ 35s ✓** | 无 | **有** | 0 | 30s 超时验收通过；跑完已把 4324 重启回默认 180000（进程 env 已核实无覆盖） |
| 手动停止按钮（注入"服务端永不响应"的悬挂流） | **41ms** | - | - | 0 | 停止→AbortError→输入框立即恢复；服务端 stop 语义另有 DB 证据：curl 中断的回合落库为「（已停止）」（messages 表 id 254/255） |
| 截断提示渲染（路由注入 `truncated`+`done` 的 SSE，免 GLM） | 577ms | **有，文案逐字匹配** | - | 0 | 提示出现在该条回答气泡之后（`truncated-tip.json` + 截图） |

服务器 4324 运行日志：`/tmp/fix-b-server.log`（重启即截断覆盖）。

## 四、诊断脚本（任务3）

- 用法：`node scripts/capture-glm-payload.mjs "问题"`（自动读 `.env`，不修改环境）。与 runner 相同的组装：pi-agent-core `Agent` + `streamFn = models.streamSimple(...)` + `anthropicMessagesApi`，模型目录项、思考深度（读 `data/agent-admin.json`）、system prompt、五个工具的名称/描述/TypeBox schema 均逐字复刻自 `models.ts`/`prompt.ts`/`tools.ts`（脚本必须纯 node 运行，不能 import TS 源码；工具 execute 为占位，不影响发出的请求体）。通过 pi-ai 的 `onPayload` 钩子（anthropic-messages.js:384，发请求前回调，返回 undefined 不改请求）把每轮真实请求体落盘。
- 已跑通一次（3 轮：2 轮工具调用 + 1 轮正文），产物：
  - `/tmp/glm-payload-1791222974255-r1.json`、`-r2.json`、`-r3.json`、`-summary.json`（副本在 `evidence/`）
- **关键发现（与直连请求对比即得缺陷1根因）**：
  1. 每轮请求 `max_tokens=16384`、`thinking={"type":"enabled","budget_tokens":8192,"display":"summarized"}`。直连正常的是 `max_tokens=24584`（正文配额 16384），本站管线正文配额只有约 8192 token——长回答在此配额内被砍，Anthropic 语义下应返回 `stop_reason:"max_tokens"`；
  2. r2 请求体确认多轮回传了带 `signature` 的 thinking 块（assistant 历史里 `thinking[200字][sig] + tool_use ×2`）——第二个嫌疑（GLM 兼容层对回传 thinking 签名块处理不佳）也有实锤样本，两份 payload 可供与智谱直连对比人肉定位。

## 五、「截断提示是否成功触发」的结论与依据

- **机制本身已实现并验证**：服务端检测 → SSE `truncated` → 前端在该条回答下渲染指定文案。前端渲染路径用注入 SSE 实测通过（第三节最后一行）。
- **真实 GLM 场景 3 个长问题均未触发提示**，原因各不相同且有据：
  - long1：缺陷1现场复现（回答止于 OCR 乱码句中），但该轮 thinking 7544 字符 + 正文 4521 字符，离 16384 上限尚远——GLM 兼容层**提前停且没有报 max_tokens**（映射后为 end_turn→"stop"，runner 不发 truncated）。依据：pi-ai `mapStopReason` 只对 `"max_tokens"` 给 `"length"`（anthropic-messages.js:1191-1192），本轮未命中；DB 中该回合 thinking/content 长度可查。
  - long2 / long3：回答还在正常流式中，先被 180s/30s 总超时截停（`stopped` 语义，按设计不发 truncated）。
  - capture 脚本本轮：该问题答案 3842 输出 token 即正常 end_turn 结束——说明截断是条件性的（超长回答或特定多轮序列），非必现。
- **即：当 GLM 报告 max_tokens 时提示必然出现；本次 GLM 兼容层的提前停返回的是 end_turn，stop_reason 层无法区分，按任务要求不做"未闭合状态"类启发式猜测。**

### pi-ai 层最小补丁建议（只建议，未改 node_modules）

1. 首选修模型参数侧：`adjustMaxTokensForThinking`（simple-options.js:58）把 `model.maxTokens` 当硬顶，使 thinking budget 挤占正文配额。若希望正文拿满 16384，可在 `models.ts` 把目录项 `maxTokens` 提到 24576（=16384+8192）——本次任务要求不动 models.ts，故仅建议。
2. 若要在 pi-ai 里做：在 `anthropic-messages.js` 的 `stream()` 增加"终止原因审计"选项，把每轮 `message_delta.stop_reason` 原样经 `onProviderStreamEvent`/日志落盘（钩子已存在，:402），便于区分"模型真说完了"与"兼容层提前停"。
3. 根治在智谱兼容层：提前终止时应返回 `max_tokens`（或在 `stop_details` 给出原因），并正确处理回传的 thinking 签名块；可拿 `evidence/glm-payload-*-r2.json` 与直连请求逐字段对比提工单。

## 六、遗留问题

1. **缺陷1根因未根治**（按任务要求）：GLM 兼容层在多轮工具 + thinking 场景下提前停且报 end_turn，stop_reason 检测不到。超时兜底（180s）与"truncated（max_tokens 时）"已让用户可感知大部分场景，但 end_turn 型句中停仍无提示。建议下一步用 evidence 里的 payload 与智谱直连对比，向 BigModel 提工单。
2. capture 脚本的 system prompt / 工具 schema 是源码复刻，若日后改 `prompt.ts`/`tools.ts` 需同步脚本（脚本头部有注释说明）。
3. 缺陷2的原始根因（回答显示完后连接悬挂 38~90s）未单独定位——本轮实测 long1 自然 done 后 0ms 内即恢复（前端不再等连接关闭），long2 由 180s 兜底收尾；若上游再次悬挂，护栏保证 ≤195s（超时+15s 宽限）必关。

## 七、GLM 调用预算披露（共 5 次助手提问 + 1 次诊断脚本）

| # | 通道 | 说明 |
|---|---|---|
| 1 | 助手（4325） | 冒烟测试误耗：4325 端口有一台环境遗留的旧服务（真实 Key），我的 mock 实例因端口占用未起来，冒烟问题打到了它 |
| 2 | curl（4324） | 排查时的一次 5 秒中断探测（"hi"），意外产出服务端停止语义的 DB 证据 |
| 3-5 | 助手（4324） | long1 / long2 / long3(30s 超时) |
| 6 | 诊断脚本 | `capture-glm-payload.mjs` 直连一次（任务3 要求跑通一次，属助手提问之外的诊断调用） |

## 八、复现/复核方式

```bash
cd /root/fix-b && npm run build
(set -a; . ./.env; set +a; HOST=127.0.0.1 PORT=4324 node dist/server/entry.mjs)   # 默认 180s
AGENT_TURN_TIMEOUT_MS=30000 …                                                      # 30s 自测
node scripts/capture-glm-payload.mjs "长问题"                                       # 请求体落盘 /tmp
node evidence/verify.mjs long1                                                     # 浏览器验收（长问题）
node evidence/verify-stop.mjs / verify-truncated-tip.mjs                           # 免 GLM 用例
```
