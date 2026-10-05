# 监控与告警系统

上线前的自动化监控：用户遇到 bug → 结构化日志 → 飞书群机器人推送（1 分钟内）。不依赖任何第三方服务。

## 组成

| 层 | 文件 | 说明 |
|---|---|---|
| 前端采集 | `src/layouts/BaseLayout.astro`（内联脚本） | JS 异常 / Promise 拒绝 → `sendBeacon /api/log/client`；同一错误每页只报一次 |
| UI 错误上报 | `src/components/AgentWidget.astro`（addMsg） | 用户看到"出错了"类提示时同步上报（kind=ui） |
| 上报端点 | `src/pages/api/log/client.ts` | 按 IP 限流 30 条/5 分钟，字段固定并截断；账号从会话 cookie 服务端判定；不接收对话内容/密钥 |
| 服务端日志 | `src/lib/logger.ts` | JSON 行写入 `logs/app-YYYYMMDD.log`；接入点：agent 回复失败、限流(warn)、OAuth 回调失败、`src/middleware.ts` 兜底捕获所有 API 未处理异常 |
| 巡检告警 | `scripts/healthcheck.mjs` | systemd timer 每分钟：拨测 10 个路径 + 增量扫描 `logs/*.log` 的 error → 飞书 webhook；同类问题 5 分钟静默，恢复时发恢复通知；清理 14 天前日志 |
| 进程托管 | `/etc/systemd/system/sjtu-mcm-website.service` | 替代 nohup：崩溃 3 秒自动重启、开机自启、journald 留痕 |

## 启用飞书通知（一次性）

1. 飞书群 → 设置 → 群机器人 → 添加「自定义机器人」→ 复制 webhook 地址
2. `.env` 追加一行（无需重启，1 分钟内生效）：
   ```
   FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
   ```

## 常用命令

```bash
systemctl status sjtu-mcm-website            # 站点进程
journalctl -u sjtu-mcm-website -f            # 运行日志（stdout/stderr）
tail -f logs/client-$(date +%F).log          # 用户端错误上报
tail -f logs/app-$(date +%F).log             # 服务端事件
node scripts/healthcheck.mjs                 # 手动巡检一次
systemctl list-timers sjtu-mcm-healthcheck*  # 巡检调度
```

## 部署变更后

```bash
npm run build && systemctl restart sjtu-mcm-website
```

## 域名/登录就绪后

- 拨测公网入口：`.env` 加 `SITE_BASE_URL=https://<域名>`
- jAccount 上线后前端上报自动带 `account` 字段（无需改动）
- 若加 nginx 反代：确认 `X-Forwarded-For` 传入，client 日志里 IP 才是真实来源

## 设计约束

- **隐私**：上报只含错误堆栈 + 页面 + 账号/IP，绝不含对话内容、API key（BYOK key 只在内存）
- 日志目录 `logs/` 已加入 `.gitignore`，不入库
