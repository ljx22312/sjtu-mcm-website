# jAccount 登录接入说明

本站已内置上海交通大学统一身份认证（jAccount）登录框架，采用 **OIDC 授权码模式**
（`scope=openid`）。在正式凭据下来之前，网站以纯静态 + Node API
端点的混合形态运行，并可用**演示身份**联调整个流程。

## 现在已经搭好的部分

| 组件 | 位置 | 说明 |
|------|------|------|
| jAccount OIDC 客户端 | `src/lib/auth.ts` | 授权 URL 构造、授权码换 token（Basic 认证）、`id_token` HS256 验签（校验 aud/iss/exp）、随机 state 防 CSRF |
| 会话 | 同上 | HMAC-SHA256 签名的 httpOnly cookie（`sjtumcm_session`），7 天有效期，无第三方依赖 |
| 登录入口 | `GET /api/auth/login?redirect=/join` | 未配置凭据时引导到 `/login` 说明页；`?mock=1` 发演示会话 |
| 回调 | `GET /api/auth/callback` | 校验 state cookie → 换 token → 验签 → 发会话 → 回跳原页面 |
| 登出 | `GET /api/auth/logout`（`?slo=1` 连带 jAccount 单点登出） | 清会话 |
| 登录态查询 | `GET /api/auth/me` | 返回 `{authenticated, configured, mock_allowed, user}`，静态页面统一用它刷新页头 |
| 登录页 | `/login` | 状态感知：审批中显示说明+演示登录；已登录显示用户卡片 |
| 页头入口 | `Header.astro` | 「登录」按钮 → 登录后变成「姓名 · 退出」 |
| 服务端形态 | `astro.config.mjs` + `@astrojs/node`（standalone） | 所有页面仍静态预渲染，只有 `/api/auth/*` 4 个端点跑在 Node 端 |

## 权限批下来之后要做的三件事

1. **在 jAccount 应用登记回调地址**：`https://<你的域名>/api/auth/callback`
   （必须与申请单一致，域名/协议/路径全匹配）。
2. **配置环境变量**（`.env` 或 systemd/nginx 环境注入）：
   ```
   JACCOUNT_CLIENT_ID=xxx
   JACCOUNT_CLIENT_SECRET=xxx
   AUTH_SESSION_SECRET=<openssl rand -hex 32>
   ```
   配置完成后 `/login` 自动切换为真实 jAccount 登录，演示登录自动关闭
   （除非显式 `AUTH_ALLOW_MOCK=1`）。**无需改代码、无需重新构建判断逻辑**——
   `src/lib/auth.ts` 在运行时读取这些变量。
3. **部署方式确认**：站点从"纯静态托管"变为"Node 常驻服务"，参考下节。

## 部署

```bash
npm run build          # 产出 dist/client（静态资源）+ dist/server（Node 服务）
HOST=127.0.0.1 PORT=4321 node dist/server/entry.mjs
```

nginx 参考配置（静态页面由 Node 服务一并吐出，也可自行拆分）：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.example;

    location / {
        proxy_pass http://127.0.0.1:4321;
        proxy_set_header Host $host;              # 必须：回调 URL 按它拼
        proxy_set_header X-Forwarded-Proto https; # 必须：cookie Secure 标志按它判
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

> 反代必须传 `Host` 和 `X-Forwarded-Proto`：前者决定授权回调地址，后者决定
> 会话 cookie 是否带 `Secure` 标志。两者缺失会导致回调地址不匹配或登录态丢失。

## 协议备忘（来源：developer.sjtu.edu.cn/auth/oidc.html）

- 授权端点 `https://jaccount.sjtu.edu.cn/oauth2/authorize`
  （`response_type=code&scope=openid&client_id&redirect_uri&state`）
- 换票端点 `https://jaccount.sjtu.edu.cn/oauth2/token`（POST，Basic 认证）
- `id_token`：HS256 JWT，**签名密钥即 client_secret**；claims 含
  `sub`（jAccount 账号）、`name`（姓名）、`code`（学工号）、`type`（身份类型）、
  `aud`（= client_id）、`iss`（= `https://jaccount.sjtu.edu.cn/oauth2/`）
- 单点登出 `https://jaccount.sjtu.edu.cn/oauth2/logout`
  （`client_id&post_logout_redirect_uri&state`）

## 安全要点（已实现）

- state 随机数存 httpOnly cookie，回调时比对，防 CSRF / 授权码注入
- `redirect` 参数只接受站内相对路径，防开放重定向
- 会话 cookie：httpOnly + SameSite=Lax + Secure（https 下）；HMAC 防篡改
- `id_token` 验签 + aud/iss/exp 校验，不盲信前端传来的任何身份信息
- 演示身份在会话与页头均显著标记，且配置正式凭据后默认关闭

## 本地联调

```bash
npm run dev            # astro dev，API 路由同样可用
# 或产物形态：
npm run build && HOST=127.0.0.1 PORT=4321 node dist/server/entry.mjs
```

未配置凭据时：访问 `/login` → 「演示登录」→ 页头出现「演示身份 · 退出」；
`curl` 验证：`curl -c jar -L localhost:4321/api/auth/login?mock=1` 后
`curl -b jar localhost:4321/api/auth/me`。
