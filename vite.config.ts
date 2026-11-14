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

/** Dev/preview relay for the Comick aggregator API (it sends no CORS headers). */
function comickRelayPlugin(): Plugin {
  const COMICK_ORIGIN = 'https://comick-source-api.notaspider.dev';
  const allowedPaths = new Set(['/api/search', '/api/chapters', '/api/frontpage', '/api/sources', '/api/health']);
  const attach = (middlewares: { use: (route: string, fn: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void) => void }) => {
    middlewares.use('/comick-api', async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', 'http://localhost');
        const apiPath = reqUrl.pathname.replace(/^\/comick-api/, '');
        if (!allowedPaths.has(apiPath)) {
          res.statusCode = 400;
          res.end('Endpoint not allowed');
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString('utf8');
        const upstreamRes = await fetch(COMICK_ORIGIN + apiPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body || undefined,
        });
        // The upstream streams NDJSON per source and keeps the connection open
        // for a while after the last batch — respond as soon as the stream goes
        // quiet (5s without new bytes) instead of waiting for the close.
        const reader = upstreamRes.body?.getReader();
        if (!reader) {
          res.end(await upstreamRes.text());
          return;
        }
        const parts: Uint8Array[] = [];
        let finished = false;
        const quiet = new Promise<undefined>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => resolve(undefined), 5000);
          };
          const pump = async (): Promise<void> => {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) { finished = true; resolve(undefined); return; }
              parts.push(value);
              arm();
            }
          };
          arm();
          void pump().catch(() => resolve(undefined));
        });
        await quiet;
        try { await reader.cancel(); } catch { /* already closed */ }
        const text = Buffer.concat(parts.map((part) => Buffer.from(part))).toString('utf8');
        if (!finished && !parts.length) {
          res.statusCode = 502;
          res.end('Comick API relay failed');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = upstreamRes.status;
        res.end(text);
      } catch {
        res.statusCode = 502;
        res.end('Comick API relay failed');
      }
    });
    middlewares.use('/comick-page', async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', 'http://localhost');
        const raw = reqUrl.searchParams.get('url') || '';
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:' || isPrivateHost(parsed.hostname)) {
          res.statusCode = 400;
          res.end('Invalid page URL');
          return;
        }
        const upstreamRes = await fetch(parsed.toString(), {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            Accept: 'text/html',
          },
          signal: AbortSignal.timeout(25000),
        });
        const text = await upstreamRes.text();
        if (!upstreamRes.ok) {
          res.statusCode = upstreamRes.status;
          res.end('Page unavailable');
          return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.statusCode = 200;
        res.end(text);
      } catch {
        res.statusCode = 502;
        res.end('Page relay failed');
      }
    });
  };
  return {
    name: 'praha-comick-relay',
    configureServer(server) { attach(server.middlewares); },
    configurePreviewServer(server) { attach(server.middlewares); },
  };
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
  plugins: [react(), sankaImageRelayPlugin(), comickRelayPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // webtorrent's browser graph still imports the node-only DHT client by
      // name; stub it so the build passes (DHT is impossible over WebRTC).
      'bittorrent-dht': path.resolve(__dirname, 'src/stubs/bittorrent-dht-stub.ts'),
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*', '**/.git/**'],
    // Vitest 5 defaults maxWorkers to hw.ncpu (10 here) and isolates every
    // file in its own fork. Each jsdom fork cold-starts in ~22s, so ten
    // concurrent forks exceed the pool's 60s startup timeout: files silently
    // never run and `npm test` exits 1 with unhandled worker errors. Cap
    // concurrency. `isolate` must stay true: several suites vi.mock() whole
    // modules and shared workers leak those mocks across files (verified).
    maxWorkers: 2,
    // Several suites boot jsdom + the full component graph; the 5s default
    // flakes under a cold transform cache (observed 4976ms on flow.test.tsx).
    testTimeout: 15000,
    hookTimeout: 20000,
  },
});
