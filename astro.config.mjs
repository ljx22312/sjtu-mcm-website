// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// https://astro.build/config
//
// 页面保持静态预渲染；仅 src/pages/api/** 标注 prerender = false 的路由
// 运行在 Node 服务端（jAccount OAuth2 需要 server 端持有 client_secret）。
export default defineConfig({
  adapter: node({ mode: 'standalone' }),
});
