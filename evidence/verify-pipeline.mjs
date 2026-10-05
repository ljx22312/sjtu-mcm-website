/**
 * 验收脚本（浏览器黑盒）：实测助手聊天管线。
 * 用法：node evidence/verify.mjs <case> [base]
 *   case = smoke | long1 | long2 | long3 | stop
 *   base = 可选，默认 http://127.0.0.1:4324/ （mock 调试可用 http://127.0.0.1:4326/）
 * 输出 JSON 到 evidence/<case>.json，截图 evidence/<case>-panel.png。
 */
import { writeFileSync } from "node:fs";

const CASE = process.argv[2];
const BASE = process.argv[3] || "http://127.0.0.1:4324/";

const QUESTIONS = {
  smoke: "你好，请介绍一下你自己",
  long1:
    "请详细介绍模糊综合评价法的完整建模流程，包括因素集与评语集设定、隶属度矩阵构造、算子选择和最终评级，并给出完整的数值例子。请尽量详尽，把每一步的公式和计算过程都写出来。",
  long2:
    "请系统讲解熵权法与层次分析法（AHP）确定权重的完整步骤，包括熵权公式的推导与极值处理、判断矩阵构造、一致性检验、两种方法结合（组合权重）的流程，并各自给出具体数值例子。请尽量详尽完整。",
  long3:
    "请详细介绍灰色预测模型 GM(1,1) 的完整建模过程，包括原始数据级比检验、累加生成、背景值构造、白化微分方程、最小二乘参数估计、时间响应式、后验差检验与残差修正，并给出完整的数值例子。请把公式和步骤写得尽可能完整。",
  stop:
    "请详细介绍模糊综合评价法的完整建模流程，包括隶属度矩阵构造、算子选择和最终评级，并给出数值例子",
};

/* long3 = 超时验收题：服务器需以 AGENT_TURN_TIMEOUT_MS=30000 启动，恢复应在 ≤35s */
QUESTIONS.long3 =
  "请详细介绍灰色预测模型 GM(1,1) 的完整建模过程，包括原始数据级比检验、累加生成、背景值构造、白化微分方程、最小二乘参数估计、时间响应式、后验差检验与残差修正，并给出完整的数值例子。请把公式和步骤写得尽可能完整。";

if (!CASE || !(CASE in QUESTIONS)) {
  console.error("用法：node evidence/verify.mjs smoke|long1|long2|long3|stop [base]");
  process.exit(1);
}

const { chromium } = await import("file:///root/sjtu-mcm-website/node_modules/playwright/index.mjs");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("dialog", (d) => d.accept());

const jsErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") jsErrors.push(`[console.error] ${msg.text()}`);
});
page.on("pageerror", (err) => jsErrors.push(`[pageerror] ${err.message}`));

/* 捕获浏览器实际收到的 SSE 事件与 chat 响应状态码，避免黑盒误判 */
const sseEvents = [];
await page.exposeFunction("__sseEvent", (e) => sseEvents.push(e));
const chatStatus = { code: null };
await page.exposeFunction("__chatStatus", (code) => {
  chatStatus.code = code;
});

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.click("#agent-fab");
await page.waitForSelector("#agent-panel:not([hidden])");
await page.waitForFunction(() => !document.getElementById("agent-input").disabled);
/* 面板打开后的异步恢复（历史拉取）需要收敛后再操作 */
await page.waitForTimeout(1200);

/* 注入 fetch 观测（在 clear/send 之前） */
await page.evaluate(() => {
  const orig = window.fetch;
  window.fetch = async (...args) => {
    const res = await orig(...args);
    if (String(args[0]).includes("/api/agent/chat")) {
      window.__chatStatus(res.status);
      const reader = res.clone().body.getReader();
      const dec = new TextDecoder();
      (async () => {
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const p of parts) {
            const l = p.split("\n").find((x) => x.startsWith("data: "));
            if (l) {
              try {
                window.__sseEvent(JSON.parse(l.slice(6)));
              } catch {
                /* ignore */
              }
            }
          }
        }
      })();
    }
    return res;
  };
});

/* 每个用例独立开场：重新开始（confirm 自动接受），并以“已开始新对话。”出现为同步点 */
await page.click("#agent-clear");
await page.waitForFunction(() => {
    const els = [...document.getElementById("agent-body").querySelectorAll(".agent-msg.status")];
    return els.some((n) => (n.textContent ?? "").includes("已开始新对话"));
  }, null, { timeout: 10000 });

const question = QUESTIONS[CASE];
await page.fill("#agent-input", question);
const t0 = Date.now();
await page.click("#agent-send");
/* 发送后输入框应立即禁用；以此确认回合真正开始（防时序误判） */
await page.waitForFunction(() => document.getElementById("agent-input").disabled === true, null, { timeout: 5000 });
const turnStarted = Date.now();

let stopClickMs = null;
if (CASE === "stop") {
  await page.waitForTimeout(5000); /* 生成约 5 秒后手动停止 */
  stopClickMs = Date.now();
  await page.click("#agent-send");
  await page.waitForFunction(() => !document.getElementById("agent-input").disabled, null, { timeout: 20000 });
} else {
  await page.waitForFunction(() => !document.getElementById("agent-input").disabled, null, { timeout: 230000 });
}
const recoveryMs = Date.now() - t0;

const state = await page.evaluate(() => {
  const body = document.getElementById("agent-body");
  const dump = [...body.children].map((n) => `${n.className}: ${(n.textContent ?? "").slice(0, 60)}`);
  const statuses = [...body.querySelectorAll(".agent-msg.status")].map((n) => n.textContent?.trim() ?? "");
  const bubbles = [...body.querySelectorAll(".agent-msg.assistant")];
  const last = bubbles.at(-1);
  return {
    bodyDump: dump,
    statusTexts: statuses,
    hasTruncationTip: statuses.some((s) => s.includes("回答达到模型输出上限")),
    hasTimeoutTip: statuses.some((s) => s.includes("已自动停止")),
    lastAnswerChars: last ? (last.textContent ?? "").length : 0,
    lastAnswerTail: last ? (last.textContent ?? "").slice(-50) : "",
    inputDisabled: document.getElementById("agent-input").disabled,
  };
});

await page.locator("#agent-widget").screenshot({ path: `/root/fix-b/evidence/${CASE}-panel.png` }).catch(() => {});

const result = {
  case: CASE,
  base: BASE,
  questionChars: question.length,
  chatStatus: chatStatus.code,
  recoveryMs,
  turnConfirmedMs: turnStarted - t0,
  ...(stopClickMs ? { stopClickToRecoverMs: Date.now() - stopClickMs } : {}),
  sseEventTypes: sseEvents.map((e) => e.type + (e.stopped ? ":stopped" : "") + (e.timeout ? ":timeout" : "")),
  ...state,
  jsErrors,
};
writeFileSync(`/root/fix-b/evidence/${CASE}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
