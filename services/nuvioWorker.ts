/// <reference lib="webworker" />

import * as cheerio from 'cheerio';
import CryptoJS from 'crypto-js';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const originalFetch = worker.fetch.bind(worker);

interface PendingProxyRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

const pendingProxy = new Map<string, PendingProxyRequest>();

function proxyFetchViaMainThread(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET') || 'GET';
  const headers: Record<string, string> = {};
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
  }
  const body = typeof init?.body === 'string' ? init.body : undefined;
  const reqId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise<Response>((resolve, reject) => {
    pendingProxy.set(reqId, { resolve, reject });
    worker.postMessage({ type: 'fetch-proxy', reqId, url, method, headers, body });
  });
}

/**
 * Intercepts worker `fetch`: attempts standard worker fetch first, and if CORS
 * or forbidden headers (`Referer`, `User-Agent`, `Origin`) block it, delegates
 * to the main thread where Android's native HTTP bridge resolves it cleanly.
 */
const smartFetch: typeof fetch = async (input, init) => {
  let hasForbiddenHeader = false;
  if (init?.headers) {
    try {
      const entries = init.headers instanceof Headers
        ? Array.from(init.headers.keys())
        : Array.isArray(init.headers)
          ? init.headers.map(([k]) => k)
          : Object.keys(init.headers);
      hasForbiddenHeader = entries.some((k) => /^(referer|origin|user-agent|cookie|host)$/i.test(k));
    } catch {
      hasForbiddenHeader = false;
    }
  }
  if (!hasForbiddenHeader) {
    try {
      return await originalFetch(input, init);
    } catch {
      return proxyFetchViaMainThread(input, init);
    }
  }
  return proxyFetchViaMainThread(input, init);
};

Object.defineProperty(worker, 'fetch', { value: smartFetch, writable: true, configurable: true });

worker.onmessage = async (event) => {
  const payload = event.data;
  if (payload?.type === 'fetch-proxy-response') {
    const pending = pendingProxy.get(payload.reqId);
    if (!pending) return;
    pendingProxy.delete(payload.reqId);
    if (payload.error) {
      pending.reject(new Error(payload.error));
    } else {
      pending.resolve(new Response(payload.data ?? '', {
        status: payload.status || 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }));
    }
    return;
  }

  const { code, args, scraperId, settings, tmdbApiKey, mode } = payload;
  try {
    const module = { exports: {} as Record<string, unknown> };
    const setGlobal = (name: string, value: unknown) => {
      Object.defineProperty(worker, name, { value, writable: true, configurable: true });
    };
    setGlobal('window', worker);
    setGlobal('global', worker);
    setGlobal('SCRAPER_ID', scraperId);
    setGlobal('SCRAPER_SETTINGS', settings || {});
    setGlobal('TMDB_API_KEY', tmdbApiKey || '');
    setGlobal('cheerio', cheerio);
    setGlobal('CryptoJS', CryptoJS);
    const require = (name: string) => {
      if (['cheerio', 'cheerio-without-node-native', 'react-native-cheerio'].includes(name)) return cheerio;
      if (name === 'crypto-js') return CryptoJS;
      throw new Error(`Module '${name}' is not available in the PRAHA web runtime.`);
    };
    const evaluate = new Function(
      'module', 'exports', 'require',
      `${code}\n;return { exported: module.exports, localGetStreams: typeof getStreams === 'function' ? getStreams : undefined, localOnSettings: typeof onSettings === 'function' ? onSettings : undefined };`,
    );
    const context = evaluate(module, module.exports, require);
    const exported = context.exported as Record<string, unknown>;

    if (mode === 'settings') {
      const onSettings = exported.onSettings || context.localOnSettings || (worker as any).onSettings;
      const layout = typeof onSettings === 'function' ? await onSettings() : [];
      worker.postMessage({ ok: true, result: Array.isArray(layout) ? layout : [] });
      return;
    }

    const getStreams = exported.getStreams || context.localGetStreams || (worker as any).getStreams;
    if (typeof getStreams !== 'function') throw new Error('The scraper does not export getStreams().');
    const result = await getStreams(args.tmdbId, args.mediaType, args.season ?? undefined, args.episode ?? undefined);
    worker.postMessage({ ok: true, result: result || [] });
  } catch (error) {
    worker.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

export {};
