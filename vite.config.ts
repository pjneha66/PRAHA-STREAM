import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Dev/preview relay for the key-free metadata APIs PRAHA reads in the browser,
 * including AniCore, Anikura, IMDx, and Sanka.
 * Production builds call the public origins directly; this keeps `npm run dev`
 * and `vite preview` working on hosts where the remote CORS headers are absent.
 * Point the *_PROXY_TARGET variables at a mirror or a local fixture server when
 * you need to develop without egress.
 */
const upstream = (envKey: string, fallback: string) => process.env[envKey]?.trim() || fallback;

const apiProxy = {
  '/anicore': {
    target: upstream('ANICORE_PROXY_TARGET', 'https://anicore.dpdns.org'),
    changeOrigin: true,
    secure: true,
    rewrite: (requestPath: string) => requestPath.replace(/^\/anicore/, ''),
  },
  '/anikura': {
    target: upstream('ANIKURA_PROXY_TARGET', 'https://anikura.club'),
    changeOrigin: true,
    secure: true,
    rewrite: (requestPath: string) => requestPath.replace(/^\/anikura/, ''),
  },
  '/imdx': {
    target: upstream('IMDX_PROXY_TARGET', 'https://api.tiffara.com'),
    changeOrigin: true,
    secure: true,
    rewrite: (requestPath: string) => requestPath.replace(/^\/imdx/, ''),
  },
  '/sanka': {
    target: upstream('SANKA_PROXY_TARGET', 'https://www.sankavollerei.web.id'),
    changeOrigin: true,
    secure: true,
    rewrite: (requestPath: string) => requestPath.replace(/^\/sanka/, ''),
  },
  // Flow tab (YouTube): the InnerTube endpoints and RSS feeds send no CORS
  // headers, so the dev relay mirrors the exact hosts the tab talks to.
  '/__youtube/www.youtube.com': {
    target: upstream('YOUTUBE_PROXY_TARGET', 'https://www.youtube.com'),
    changeOrigin: true,
    secure: true,
    rewrite: (requestPath: string) => requestPath.replace(/^\/__youtube\/www\.youtube\.com/, ''),
  },
  '/__youtube/i.ytimg.com': {
    target: 'https://i.ytimg.com',
    changeOrigin: true,
    secure: true,
    rewrite: (requestPath: string) => requestPath.replace(/^\/__youtube\/i\.ytimg\.com/, ''),
  },
  '/__youtube/yt3.googleusercontent.com': {
    target: 'https://yt3.googleusercontent.com',
    changeOrigin: true,
    secure: true,
    rewrite: (requestPath: string) => requestPath.replace(/^\/__youtube\/yt3\.googleusercontent\.com/, ''),
  },
};

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: apiProxy,
  },
  preview: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: apiProxy,
  },
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*', '**/.git/**'],
  },
});
