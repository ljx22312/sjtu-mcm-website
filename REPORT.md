# 手机端横向溢出修复报告（fix/mobile-overflow）

修复人 worktree：`/root/fix-a`（分支 `fix/mobile-overflow`，commit `c01e239`）
验证服务：`http://127.0.0.1:4323`（本 worktree 构建，主项目 4321 未触碰）
只改动了白名单内 4 个文件的 `<style>` 块，无标记/脚本改动。

## 一、每页问题根因与改动

四页的共性问题：**卡片是网格项，网格项默认 `min-width:auto`，轨道会被内容的
min-content 撑宽；而全局 `global.css` 里 `h1,h2,h3,h4 { word-break: keep-all }`
让长中文标题整段不可断行，min-content 直接等于整行宽度**，于是单列 `1fr`/隐式
auto 轨道被顶到远超视口，页面出现横向滚动条。

### 1. `/news`（NewsBody.astro）—— 610 → 390

- 根因：`.news-item h3` 受全局 keep-all 影响，「关于“华为杯”第二十三届中国研究生
  数学建模竞赛赛题下载及提交作品的重要提醒」（36 字）min-content 实测 540px，
  把 `.news-list`（display:grid，隐式单列）的轨道撑到 586px。
- 改动：
  - `.news-item` 加 `min-width: 0`（网格项按轨道收缩）；
  - `.news-item h3` 改 `word-break: normal` + `overflow-wrap: anywhere`；
  - `.summary` / `.source` 加 `overflow-wrap: anywhere`（长链接/编号串兜底）。

### 2. `/`（HomeBody.astro）—— 580 → 390

- 根因：近期赛事卡 `.comp-card h3`（如「“华数杯”大学生数学建模竞赛（国内赛/国际赛）」
  min-content 381px）与最新新闻卡 `.news-card h3`（华为杯通知标题 510px）顶宽
  `grid-3` 的 `1fr` 轨道。桌面端同样受害：1280px 下新闻区轨道被顶成 556/280/252
  的畸形三列（无滚动条但布局歪）。
- 改动：`.comp-card/.news-card/.entry-card` 加 `min-width: 0`；两类卡片标题把
  `word-break: keep-all` 改为 `normal` + `overflow-wrap: anywhere`（保留
  `text-wrap: balance`）；`.comp-meta dd` 加 `min-width: 0` +
  `overflow-wrap: anywhere`（报名/比赛窗口长日期串可断行）。
- 桌面端副产修复：新闻/赛事区恢复三等分轨道（362.66 × 3）。

### 3. `/calendar`（CalendarBody.astro）—— 434 → 390

- 根因：赛事详情卡 `.comp-head h3`（keep-all，长赛事全名 min-content 362px）
  顶宽 `grid-2` 的 `1fr` 轨道，卡片溢出 44px；`.badges`、`dl.comp-meta`、
  `span.badge` 均被连带带出。手机端时间轴表格 `.cal-timeline` 本来就
  `display:none`，与表格无关；桌面端表格也本就包在 `.table-wrap`
  （overflow-x:auto）内滚动，未改动。
- 改动：`.comp-card` 加 `min-width: 0`；`.comp-head h3` 改 `word-break: normal`
  + `overflow-wrap: anywhere`；`.name-en`、`.comp-meta dd` 加
  `overflow-wrap: anywhere`（校内赛超长窗口说明可断行，dd 加 `min-width: 0`）。
- 验证：390px 下 16 张详情卡 0 张越界（右缘全部 ≤390）。

### 4. `/knowledge`（KnowledgeBody.astro）—— 490 → 390

- 根因（实测与任务描述的推测不同）：把页面撑宽的不是顶部芯片行，而是**移动端
  课程卡片**——`.kb-card summary`（flex 行）里两个不可收缩的内容：
  1. `.kb-card-topic` 的长英文串「数据可视化进阶（基于
     Python-Plotly+Pyecharts+Seaborn）」——`+` 号处 CSS 无断行点，min-content
     实测 268px；
  2. `.kb-card-fmt { white-space: nowrap }`（如「线下 2026年1月3日
     18:00-20:30」min-content 200px）。
  两者相加把 `.kb-cards` 网格隐式轨道顶到 466px。
  顶部模块芯片行 `.kb-chips` 本身有 `overflow-x: auto`（≤860px 断点内单行横滑、
  芯片被容器裁剪），实测芯片从未把页面撑宽（页宽 490 = 卡片 466 + 内边距 24），
  因此**芯片行无需改动**，已满足「在自己容器内横向滚动」的要求（实测 scrollLeft
  可滚到 200）。
- 改动（均在 860px 断点内的移动端卡片块）：
  - `.kb-card` 加 `min-width: 0`；
  - `.kb-card-topic` 加 `overflow-wrap: anywhere`；
  - `.kb-card-fmt` 去 `nowrap`，允许在窄卡内换行；
  - `.kb-card-body` 加 `overflow-wrap: anywhere`（「形式与安排」里的长英文串）；
  - `.kb-source` 加 `overflow-wrap: anywhere`（数据源飞书长路径）。
- 桌面端 `.kb-table` / `.kb-scroll`（sticky 表头的滚动容器）一行未动。

## 二、before / after scrollWidth 对照（390×844，documentElement.scrollWidth）

| 页面 | before | after | 结论 |
|---|---|---|---|
| `/` | 580 | 390 | PASS |
| `/news` | 610 | 390 | PASS |
| `/calendar` | 434 | 390 | PASS |
| `/knowledge` | 490 | 390 | PASS |
| `/ai-tools` | 390 | 390 | PASS（本就正常） |
| `/about` | 390 | 390 | PASS |
| `/join` | 390 | 390 | PASS |
| `/team-up` | 390 | 390 | PASS |
| `/login` | 390 | 390 | PASS |

数据文件：`evidence/verify-before.json`、`evidence/verify-after.json`
（由 `evidence/verify.mjs` 生成，含 390 与 1280 两档逐页数据）。
逐元素越界清单：`evidence/overflow-diagnose-before.json` /
`overflow-diagnose-after.json`（`evidence/find-overflow.mjs` 生成）。

## 三、1280×800 桌面回归结论

九个公开页 scrollWidth 均为 1280（无横向滚动），结构逐项检查：

- `/news`：仍是卡片列表（4 张 `.news-item`，卡宽 1128px 贴满容器），长标题一行放下。
- `/`：赛事区与新闻区均为正常三列，且轨道恢复三等分（362.66×3，修复前新闻区被
  顶成 556/280/252 的歪列）；Hero 完整。
- `/calendar`：全年时间轴表格可见（4 列 ×22 行，`width:max-content` +
  `.table-wrap` 容器内横滑，与修复前一致）；16 张详情卡双列正常；手机端月份速览
  仍只在 ≤640px 显示。
- `/knowledge`：桌面仍是 `min-width:800px` 的数据表（151 行，sticky 表头），
  移动端卡片容器 `display:none`，未"表格变卡片"。
- 另外自动检查了 4 个修复页 390px 下「overflow hidden/clip 且内容更宽」的元素：
  无横向裁剪，文字全部可见（换行而非截断）。

## 四、截图清单（evidence/）

| 文件 | 内容 |
|---|---|
| `before___390.png` / `after___390.png` | 首页 390px 修复前后 |
| `before__news_390.png` / `after__news_390.png` | 新闻页 390px 修复前后 |
| `before__calendar_390.png` / `after__calendar_390.png` | 日历页 390px 修复前后 |
| `before__knowledge_390.png` / `after__knowledge_390.png` | 知识库 390px 修复前后 |
| `before___1280.png` 等 4 张 | 对应页面 1280px 桌面（修复前） |
| `after___1280.png` 等 4 张 | 对应页面 1280px 桌面（修复后） |

## 五、结论

验收标准全部达标：390px 下 9 个公开页 scrollWidth 均 =390（0px 误差），无页面级
横向滚动；knowledge 芯片行在自身容器内横滑；calendar 详情卡 0 溢出、文字无裁剪；
1280px 桌面 9 页布局无回退（部分区域比修复前更规整）。
