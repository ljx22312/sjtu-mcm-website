# 事件循环阻塞诊断报告（diag/eventloop）

- 日期：2026-10-05（本机时区显示 10-06 凌晨）
- 环境：/root/fix-c worktree（分支 diag/eventloop），Node v24.21.0，better-sqlite3 WAL，PIL 10.2.0
- 现象（生产 4321 前期实测）：AI 助手回答长问题期间，并发访问首页出现 10~30 秒超时窗口（curl 000），随后恢复；无聊天活动时 3 分钟 180 次采样零慢请求。

## 一句话结论

**阻塞点是 `src/lib/agent/corpus.ts` 的 `readLecture()`（第 458 行）：在学生勾选了讲次（请求带 `lectures`）时，它对全库约 13,740 个 chunk 逐个调用 `inScope()`，而 `inScope → allowedDocIds()`（第 298~305 行）每次都重新执行 `loadChunks()`，`loadChunks()` 的缓存校验又依赖 `readableStamp()`（第 142~150 行）——一次 `readdirSync` + 360 次 `existsSync`。单次 `readLecture` 调用因此执行 13,740 × 361 = 4,960,140 次 `existsSync` + 13,740 次 `readdirSync`，全部同步，实测连续阻塞事件循环 29.3~32.0 秒，且每次调用都重复（无缓存）。** 这与生产的"10~30 秒间歇性超时窗口"在量级、触发条件（回答期间、`read_lecture` 工具被调用）、恢复行为上完全吻合。

置信度：高（95%+）。已在独立服务器实例上端到端复现（SSE 聊天 + 并发首页探测 + 心跳漂移三方时间戳对齐），并用脱离服务器的独立驱动按 syscall 计数交叉验证，数学上严丝合缝（13,740 × 361 = 4,960,140，分毫不差）。

---

## 1. 复现方法与原始数据

### 1.1 插桩方式（未改任何 src/正式代码）

- `node --require ./scripts/diag-preload.cjs`（新文件，本分支）：
  - `[BLOCK]`：200ms 心跳，漂移 >500ms 打印（事件循环连续阻塞的直接证据）；
  - `[SPAWNSYNC]`：记录每一次 `child_process.spawnSync`（命令、耗时、调用栈）；
  - `[SLOW-IO]`：`fs.readFileSync/readdirSync/writeFileSync/statSync` 单次 >50ms；
  - `[SLOW-SQL]`：better-sqlite3 语句 >20ms；
  - SIGTERM/SIGINT → `process.exit(0)`：让 `--cpu-prof` 能在退出时落盘。
  - 原理：Node 24 上用 CJS preload 补丁 `require("node:fs")` 会影响打包产物（ESM）里的 `import { readFileSync } from "node:fs"`（已实验验证），better-sqlite3 走 require.cache 同样生效。
- `scripts/diag-probe.mjs`：每秒 GET 首页，记录耗时/状态码，>1s 标 `>>> SLOW`，30s 超时记 http=0。
- `scripts/diag-chat.mjs`：POST `/api/agent/chat` 消费 SSE，按相对时间戳记录 tool/citations/done 事件。
- `scripts/diag-bench.ts`：esbuild 打包后脱离服务器直接调用 `ensureLectureCatalog/warmRetrieval/searchLectures/readLecture/readKnowledgeImage`，并对 `fs` 同步调用计数计时。

### 1.2 端到端复现（端口 4325，本 worktree 实例）

服务器启动（无流量）→ 探测全绿（2~3ms）→ 三轮聊天（GLM 实际调用共 3 次）：

**Turn 1（无讲次勾选）**`"请详细介绍熵权法的完整计算步骤，包括公式"`
```text
+1.33s session/user → +12.92s search_lectures → +21.58s read_lecture → +29.21s read_lecture
→ +40.48s search_lectures → +70.56s done（deltas 988/1670ch）
```
服务器日志：首个动态请求触发中间件懒加载预热（见 §3 次要发现）：
```text
[SPAWNSYNC] python3 ×13（zipMembers，各 48~69ms，17:35:57.8~58.4）
[BLOCK] 6518ms @ 17:36:03.593Z            ← 一次性预热块
探测：2026-10-05T17:36:03.597Z  5454ms http=0 TypeError  >>> SLOW
```
此后整个 70s 回答期间无任何 ≥500ms 心跳漂移，探测全绿——**不带 lectures 参数时，warm 状态下检索/阅读工具不构成阻塞**。

**Turn 2（无讲次勾选，诱导看图）**`"请打开「国赛模型汇总」…逐张查看里面的插图…"`
```text
…+193.80s 连续 8 个 read_image → +248.44s done
```
服务器日志：**无 [SPAWNSYNC]、无 [BLOCK]**——模型读的 8 张图全部 <900KB，走 `readFileSync` 快路径。>900KB 触发 `spawnSync` 缩图的路径本轮未被模型选中（潜伏项，见 §3）。

**Turn 3（勾选讲次 cumcm:12，即复现生产场景）**同一问题 + `lectures:["cumcm:12"]`：
```text
+0.08s session/user → +3.37s search_lectures → +12.41s search_lectures ×2
→ +50.78s read_lecture（citations 同刻到达：阻塞期间事件被憋在 socket 缓冲，解冻后集中送达）
→ +77.05s search_curriculum → +116.80s done
```
服务器日志与首页探测（关键窗口原文）：
```text
[BLOCK] 31957ms @ 2026-10-05T17:55:22.971Z (beat#5759)     ← 单次连续阻塞 32.0 秒

探测原始序列：
2026-10-05T17:54:50.072Z      2ms http=200
2026-10-05T17:54:51.075Z      3ms http=200     ← 块约于 17:54:51.0 开始（read_lecture 开始执行）
2026-10-05T17:55:22.079Z  30004ms http=0 TimeoutError  >>> SLOW   ← 探测请求 17:54:52.08 发出，30s 预算耗尽（=生产 curl 000）
2026-10-05T17:55:23.096Z     11ms http=200     ← 块于 17:55:22.97 结束，即刻恢复
2026-10-05T17:55:24.100Z      3ms http=200
```
时间轴三方对齐：turn3 于 17:54:31.4 开始，`read_lecture` 的 start 事件与 citations 事件同在 +50.78s（17:55:22.2）到达客户端——即工具在 17:54:51 开始执行、同步阻塞 31.96s、解冻后事件集中 flush。**与生产"10~30 秒超时窗口、随后恢复"一致**（生产机型更慢时落在这个区间内；本机更快，实测 32s）。

### 1.3 独立驱动交叉验证（scripts/diag-bench.ts，无 GLM、无 HTTP）

```text
ensureLectureCatalog（冷启动，含 13 次 spawnSync zip 列表）: 696ms
warmRetrieval（冷启动 loadChunks+buildIndex）: 4611ms
searchLectures 首次: 69ms；×20 warm 平均 46ms
readLecture("国赛模型汇总") ×10（未勾选讲次）: 平均 21ms
searchLectures（scoped cumcm:12）×10: 平均 52ms      ← allow 只对候选执行，安全
readLecture（scoped cumcm:12）#1: 29,336ms  #2: 29,209ms   ← 每次~29s，无缓存效应，重复发生
```
带 fs 计数的同轮数据（单次 scoped readLecture 内部）：
```text
scoped readLecture #1: 29336ms
  readdirSync = 13,740 次（累计 5,219ms）
  existsSync  = 4,960,140 次（累计 16,358ms）
  readFileSync = 0
scoped readLecture #2: 29209ms   ← 数字与 #1 几乎一致
readableStamp 等价操作单次 = 1.93ms（1 次 readdirSync + 360 次 existsSync）
```
验算：**13,740 × 361 = 4,960,140**，与 existsSync 计数完全相等；13,740 即全库 chunk 数（≈每 chunk 一次 `loadChunks()`→`readableStamp()`），13,740 × ~2.1ms ≈ 29s。铁证。

## 2. 指名道姓的结论（附行号，基于 src/lib/agent/）

### 2.1 主因：readLecture 的每-chunk 范围过滤（生产 10~30s 窗口的直接来源）

调用链与耗时放大机制：

| 步骤 | 文件:行号 | 作用 | 单次成本 |
|---|---|---|---|
| 1 | `corpus.ts:458` `readLecture()` 内 `loadChunks().filter(chunk => inScope(chunk.token))` | 对**每个** chunk 调 `inScope` | ×13,740 |
| 2 | `corpus.ts:307-311` `inScope()` → `allowedDocIds()` | 每次重新求白名单 | — |
| 3 | `corpus.ts:298-305` `allowedDocIds()`：先 `loadChunks()`（第 302 行）再 `docsForLectures()` | 明明结果不变，却每 chunk 重算 | — |
| 4 | `corpus.ts:229-231` `loadChunks()` 第一行先 `readableStamp()` 才查缓存 | 缓存命中也要付"验戳"成本 | 1.93ms |
| 5 | `corpus.ts:142-150` `readableStamp()` | `readdirSync` + 每个 readable 目录一次 `existsSync`（360 个目录） | 361 次 syscall |

合计：`readLecture`（scoped）= 13,740 × (1 readdir + 360 exists) = 13,740 readdir + 4.96M exists ≈ **21.6s 纯 syscall + ~7.7s Set/循环开销 ≈ 29~32s 连续同步阻塞**。每次工具调用都重复（turn 内模型多次调 `read_lecture` 就是多个独立窗口——turn1 无范围时模型就连调了 2 次）。

触发条件（解释"间歇性"）：
- 请求体带非空 `lectures`（前端知识库页勾选讲次后聊天会带上，如 `["cumcm:12"]`；匿名裸 fetch 不带）——`chat.ts:82-86` 解析；
- 模型决定调 `read_lecture`（"详细讲步骤/公式/某份资料"类问题必调，见 `prompt.ts:41` 的工具使用规则）。

两个条件同时满足才爆炸，所以前期测试"时有时无"；不带 `lectures` 的链路（我方 turn1/turn2）完全不阻塞，与"无聊天活动时零慢请求"及部分正常聊天也正常的观察自洽。`searchLectures` 同样传 `inScope` 给 `hybridRank`（`corpus.ts:409`），但 `retrieve.ts:181` 的 filter 只对通过覆盖率门槛的少量候选调用 `allow`，实测 scoped 平均 52ms——同样的 bug 模式在那条路上量级无害，说明修法应当统一（把白名单提出循环外），而不是只修 `readLecture`。

另外 `corpus.ts:467` 未命中时的 `loadChunks().some(...)` 也各多付一次验戳（毫秒级，次要）。

### 2.2 次因：首个动态请求触发的懒加载预热（每进程一次 6.2~6.5s 块）

`src/middleware.ts:7-15` 在中间件模块**首次被加载时**（= 进程启动后第一个非预渲染请求，往往是第一个 `/api/agent/chat`）`setImmediate` 执行：
- `ensureLectureCatalog()` → `lectures.ts:130 build()`：其中 `lectures.ts:72-78 zipMembers()` 对 13 个 ZIP 逐个 `spawnSync("python3", ...)`（同步子进程，各 ~50ms，合计 0.62s）；
- `warmRetrieval()` → `corpus.ts:429` → `loadChunks()`（读全部 360+ 份文档，0.65s）+ `retrieve.ts:75 buildIndex()`（对 13,740 chunk 分词 + TF/IDF + 哈希向量，4.0s）。

三次冷启动实测 `[BLOCK] 6518 / 6189 / 6216ms`。CPU profile（--cpu-prof，500µs 采样）归因：
```text
warmRetrieval 4.70s（buildIndex 4.02s：termsOf/embed/hashTerm；loadChunks 0.65s：indexableBody/readFileSync）
ensureLectureCatalog 0.72s（zipMembers 0.62s = spawnSync）
```
本机快机型 6.5s；生产慢机型（冷页缓存、1.8GB knowledge/、慢盘）完全可能落在 10~30s——**如果生产测试是在进程重启后不久做的，首轮聊天的超时窗口就由它贡献**。之后进程内缓存（`corpus.ts:42-43 cache/cacheStamp`、`retrieve.ts:25 preparedCache`、`lectures.ts:49-53 cache`）稳定，不再发生。

### 2.3 潜伏项（本机未构成 >1s 块，慢机型上会叠加）

- `media.ts:24-52 shrinkJpeg()`：图片 >900KB（`media.ts:75`）时 `spawnSync("python3", PIL)` 同步缩图。库内有 10 张 2.3~3.1MB 的 PNG（`embedded/Sq03dhKG.../`，属「国赛模型汇总」）。本机单次 ~320ms（含 python 启动+PIL 导入+最多 12 次重编码尝试）；生产慢机型估计 1~4s/张，而模型一次工具轮就批量发了 8 个 `read_image`（turn2 实测）——慢机型上这就是又一个"数秒~数十秒"的间歇块。系统提示（`prompt.ts:41,63`）明确鼓励看图，公式类问题命中率高。
- `lectures.ts:72 zipMembers` 的 `spawnSync`：除预热外，`catalog()` 若在预热中抛错则缓存永远为 null，之后**每个动态请求**都会整跑 `build()`（13×spawnSync+全目录扫描）——生产若出现"每次聊天都卡"可查 `logs/app-*.log` 有无 `knowledge_warm_failed`。本次未观察到该路径。
- better-sqlite3（`history.ts`）：实测所有语句 <20ms 阈值（`[SLOW-SQL]` 零输出），排除。
- `retrieve.ts` 检索本体（BM25+余弦+覆盖率）：warm 单次 46~69ms，排除（前期"TF-IDF 毫秒级"判断正确，前提是不带每-chunk 重算白名单）。

## 3. 为什么足以解释 10~30 秒窗口（计数 × 单耗）

| 来源 | 调用次数 × 单次耗时 | 连续阻塞 | 触发时机 |
|---|---|---|---|
| `readLecture`(scoped) | 13,740 chunk × 361 syscall × ~5.5µs/syscall | **29.3~32.0s / 每次调用** | 勾选讲次 + 模型调 read_lecture（长问题高频） |
| 懒加载预热 | 1 × (~0.7s spawnSync 串 + ~4.7s 建索引) | 6.2~6.5s（慢机型 10~30s） | 进程首个动态请求 |
| `shrinkJpeg` | 每张 >900KB 图 1 × 0.3s（本机；慢机型 1~4s），一轮可连发 8 张 | 本机 ~2.6s 累计 | 模型看大图 |

生产观察 = 主因（勾讲次的 read_lecture 轮次）为主、次因（重启后首聊）为辅的叠加；两者都是纯同步代码，阻塞期间 TCP 只能进 backlog，首页 curl 以 000/超时收场，解冻后立刻恢复（探测 11ms→3ms）。

## 4. 修复建议草案（按优先级；均未实施）

1. **P0｜把讲次白名单提出循环外**（一行级改动，直接消灭主因）
   `readLecture`（corpus.ts:458）改为先 `const allowed = allowedDocIds();`（一次），filter 里 `!allowed || allowed.has(canonical(chunk.token))`；`searchLectures`→`hybridRank` 的 `allow` 回调同样改为预计算 Set（顺手统一模式，防御未来 chunk 数再涨）。`allowedDocIds()` 自身可再按 `(scope 键)` 做请求级 memo。
   风险：低。纯等价重构；注意保持 `canonical()` 别名语义不变。
2. **P0｜给 `readableStamp()` 降频**（治本：任何"验戳"路径都不该做 361 次 syscall）
   `loadChunks()` 的缓存校验改为 TTL（如 30~60s 记一次戳）或只 `readdirSync` 计数（不逐个 `existsSync`）。知识库只在同步脚本运行后变化，进程重启即刷新，TTL 无副作用。
   风险：低。新入库文档最多延迟 TTL 秒可见。
3. **P1｜预热挪到 listen 之前**：中间件 `setImmediate`（middleware.ts:7）改为服务启动入口处 await 完成后再 `listen`；`buildIndex`（4s）可进一步放 worker_threads（一次性）。
   风险：启动时间增加 ~5s（本机）；worker 方案需序列化 13,740 chunk（一次 ~几十 MB，可接受但复杂度高，非必需）。
4. **P1｜`spawnSync` 全部异步化**：`zipMembers`（lectures.ts:72）改 `execFile` promisified（`build()` 随之 async，仅启动期调用）；`shrinkJpeg`（media.ts:24）改异步 spawn——`readKnowledgeImage` 的调用方（tools.ts:166 `execute`）本就是 async，等待即可；或直接换 `sharp`（原生异步）。
   风险：中。`build()` 变 async 影响 `ensureLectureCatalog` 的三处调用点签名；缩图结果字节级可能不同（PIL→sharp），但只影响送模视觉质量，不影响业务语义。
5. 观察项：better-sqlite3、retrieve.ts 检索本体无需改动。

## 5. 复现命令清单（他人可照跑）

```bash
cd /root/fix-c && npm run build
# 起 4325（带插桩）
cd /root/fix-c && (set -a; . ./.env; set +a; HOST=127.0.0.1 PORT=4325 \
  node --require ./scripts/diag-preload.cjs dist/server/entry.mjs > /tmp/server.log 2>&1 & echo $! > /tmp/server.pid)
# 首页探测（另一终端）
node /root/fix-c/scripts/diag-probe.mjs | tee /tmp/probe.log
# 关键一步：带 lectures 聊天（GLM 一次）
node /root/fix-c/scripts/diag-chat.mjs "请详细介绍熵权法的完整计算步骤，包括公式" repro "cumcm:12"
# 观察：/tmp/server.log 出现 [BLOCK] ~32000ms；/tmp/probe.log 出现 30004ms http=0 TimeoutError

# 无 GLM 的确定性复现（秒级、可反复）：
/root/fix-c/node_modules/.bin/esbuild /root/fix-c/scripts/diag-bench.ts \
  --bundle --platform=node --format=cjs --outfile=/tmp/bench.cjs --external:better-sqlite3
cd /root/fix-c && node /tmp/bench.cjs     # 输出 scoped readLecture ≈ 29s + syscall 计数

# 预热块复现（每进程首个动态请求）：
curl -s -o /dev/null http://127.0.0.1:4325/api/agent/settings   # 触发中间件懒加载 → [BLOCK] ~6.2s
```
注意：4326 端口已被其他诊断 worktree 占用，请勿复用；本诊断用 4325/4327。

## 6. 插桩改动清单（合并时请排除/仅参考）

全部为**新增文件**，未改动任何 src/、.env、data/：
- `scripts/diag-preload.cjs`（心跳漂移 + fs/spawnSync/sqlite 补丁 + 信号处理便于 cpu-prof 落盘）
- `scripts/diag-probe.mjs`（首页秒级探测）
- `scripts/diag-chat.mjs`（SSE 聊天驱动，支持 lectures 参数）
- `scripts/diag-bench.ts`（独立基准：工具函数直调 + fs 计数）
- 本报告 `DIAG-REPORT.md`

过程产物（未入库）：/tmp/fix-c-server.log、/tmp/fix-c-probe.log、/tmp/fix-c-chat{1,2,3}.log、/tmp/cpuprof4/*.cpuprofile、/tmp/diag-bench/*。

## 7. 遗留说明

- GLM 实际调用共 3 次（≤5 约束内）：turn1 无范围基线、turn2 看图诱导、turn3 带讲次复现。
- 主因在"本机快机型"上即 29~32s；生产慢机型只会更长（更贴近观察上限 30s），不存在"复现不了量级"问题。
- 若生产仍观测到"每次聊天都卡"，优先查 `logs/app-*.log` 的 `knowledge_warm_failed`（§2.3 第二条的自愈失败路径）与前端是否默认携带 `lectures`。
