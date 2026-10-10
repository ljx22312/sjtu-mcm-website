# 上海交通大学数学建模协会官网

Astro 站点：公开页面静态预渲染。jAccount 登录（`/api/auth/*`）、管理员视角（`/staff`）、
下一版本（`/next`）和管理员名单（`/api/admin/*`）运行在 Node 端，由 `@astrojs/node`（standalone）承载。
网站管理员名单见 `data/site-admins.json` 与 `SITE_ADMIN_ACCOUNTS`（`.env.example`）。

## 开发与构建

```sh
npm install
npm run dev                 # 开发服务器（API 路由同样可用）
npm run build               # 产出 dist/client + dist/server
HOST=127.0.0.1 PORT=4321 node dist/server/entry.mjs   # 生产运行
```

本地预览（SSH 场景）：服务器上跑上面任一服务监听 127.0.0.1:4321，
本地 `ssh -L 4321:127.0.0.1:4321 用户@服务器` 后打开 <http://localhost:4321>。

## jAccount 登录

框架已就绪（OIDC 授权码模式 + 演示登录过渡态），配置方法、部署（含 nginx 反代）
与安全设计见 **[docs/jaccount-auth.md](docs/jaccount-auth.md)**；环境变量样例见
`.env.example`。交我办「jAccount 接口申请」批复后，登记回调地址
`https://<域名>/api/auth/callback` 并填入 client_id / client_secret 即正式启用。

## 目录速览

- `src/pages/` — 公开页面（登录入口在页头，直达 jAccount）；`/next`、`/staff` 仅网站管理员（服务端鉴权）
- `src/data/` — 新闻 / 赛事日历 / 两张集训大表（由规划包脚本生成）
- `src/lib/auth.ts` — jAccount OIDC 客户端与会话签名（仅服务端引用）
- `src/config.ts` — 站点配置（导航、友链、功能开关）
- 素材规划与数据管线：`/root/sjtu-mcm-website-planning/`
