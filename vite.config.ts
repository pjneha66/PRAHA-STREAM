import path from 'path';
import type { Plugin } from 'vite';
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

const sankaPrimary = upstream('SANKA_PROXY_TARGET', 'https://www.sankavollerei.web.id');
const sankaMirror = upstream('SANKA_MIRROR_PROXY_TARGET', 'https://www.sankavollerei.com');

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
  '/sanka-mirror': {
    target: sankaMirror,
    changeOrigin: true,
    secure: true,
    headers: {
      Origin: sankaMirror,
      Referer: `${sankaMirror}/`,
    },
    rewrite: (requestPath: string) => requestPath.replace(/^\/sanka-mirror/, ''),
  },
  '^/sanka(?=/|$)': {
    target: sankaPrimary,
    changeOrigin: true,
    secure: true,
    headers: {
      Origin: sankaPrimary,
      Referer: `${sankaPrimary}/`,
    },
    rewrite: (requestPath: string) => requestPath.replace(/^\/sanka/, ''),
  },
};

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  );
}

/** Dev/preview hotlink-free comic image relay (`/sanka-img?url=...`). */
function sankaImageRelayPlugin(): Plugin {
  const attach = (middlewares: { use: (route: string, fn: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void) => void }) => {
    middlewares.use('/sanka-img', async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', 'http://localhost');
        const raw = reqUrl.searchParams.get('url') || '';
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:' || isPrivateHost(parsed.hostname)) {
          res.statusCode = 400;
          res.end('Invalid image URL');
          return;
        }
        const upstreamRes = await fetch(parsed.toString(), {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(12000),
        });
        const contentType = upstreamRes.headers.get('content-type') || 'image/jpeg';
        if (!upstreamRes.ok || !contentType.startsWith('image/')) {
          res.statusCode = upstreamRes.status || 502;
          res.end('Image unavailable');
          return;
        }
        const buf = Buffer.from(await upstreamRes.arrayBuffer());
        if (buf.byteLength > 10 * 1024 * 1024) {
          res.statusCode = 413;
          res.end('Image too large');
          return;
        }
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.statusCode = 200;
        res.end(buf);
      } catch {
        res.statusCode = 502;
        res.end('Upstream fetch failed');
      }
    });
  };
  return {
    name: 'praha-sanka-image-relay',
    configureServer(server) { attach(server.middlewares); },
    configurePreviewServer(server) { attach(server.middlewares); },
  };
}

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
  plugins: [react(), sankaImageRelayPlugin()],
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
