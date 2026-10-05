// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// https://astro.build/config
//
// 公开页面保持静态预渲染。标注 prerender = false 的路由运行在 Node 端：
// /api/auth/*（jAccount）、/api/admin/*、/next、/staff（仅网站管理员）。
export default defineConfig({
  adapter: node({ mode: 'standalone' }),
});
