/// <reference lib="webworker" />

import * as cheerio from 'cheerio';
import CryptoJS from 'crypto-js';
import axios from 'axios';
import {
  parseHtml,
  parseTitle,
  titleList,
  titleScore,
  rankMatches,
  bestMatch,
  searchQueries,
  searchBest,
  searchByImdb,
  imdbMatches,
  unescapeHtml,
} from './pluginHelpers';
import { createScraperAdapter } from './scraperAdapter';
import { createVegaRuntime } from './vegaRuntime';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const originalFetch = worker.fetch.bind(worker);

/**
 * A post the app cannot clone must never kill the run silently: wrap the
 * scope's own postMessage so a structured-clone failure surfaces as an
 * ordinary run error naming the message type, the way upstream's
 * serialisation boundary reports unserialisable answers.
 */
const rawPostMessage = worker.postMessage.bind(worker);
worker.postMessage = function postChecked(message: unknown) {
  try {
    return rawPostMessage(message);
  } catch (error) {
    const type = message && typeof message === 'object' ? String((message as { type?: unknown }).type) : typeof message;
    return rawPostMessage({
      type: 'plugin-done',
      ok: false,
      error: `post ${type} failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
} as typeof worker.postMessage;

/**
 * The real TMDB API key must never enter the worker realm (audit H-open):
 * every scraper we execute is third-party code. Scrapers that read the
 * `TMDB_API_KEY` global instead receive this placeholder, and any request
 * carrying it is routed to the main thread, which substitutes the real key
 * before the request leaves the app.
 */
const TMDB_KEY_PLACEHOLDER = '__PRAHA_TMDB__';

const isProxyTimeoutError = (error: unknown) =>
  error instanceof Error && /timed out/i.test(error.message);

interface PendingProxyRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

const pendingProxy = new Map<string, PendingProxyRequest>();

/**
 * The sandbox's one evaluator.
 *
 * Every kind of third-party script this app runs — a Nuvio scraper, a plugin
 * from a repository, a scraper-list entry, a Vega provider — goes through this
 * single `new Function`. There is deliberately no second copy: one call site is
 * one place to review, and it is the only dynamic compilation in the codebase.
 *
 * The script's own `module`/`exports`/`require` are its arguments, so nothing it
 * declares leaks into this scope, and the returned handle reads back the entry
 * points the contracts name (`getStreams`, `onSettings`) whether the script
 * exported them or left them as function declarations.
 */
function runScript(
  code: string,
  module: { exports: Record<string, unknown> },
  requireFn: (name: string) => unknown,
) {
  const evaluate = new Function(
    'module', 'exports', 'require',
    `${code}\n;return { exported: module.exports, localGetStreams: typeof getStreams === 'function' ? getStreams : undefined, localOnSettings: typeof onSettings === 'function' ? onSettings : undefined, local: function (name) { var fn = globalThis[name]; return typeof fn === 'function' ? fn : undefined; } };`,
  ) as (module: unknown, exports: unknown, require: unknown) => {
    exported: Record<string, unknown>;
    localGetStreams?: (...args: unknown[]) => unknown;
    localOnSettings?: (...args: unknown[]) => unknown;
    local: (name: string) => ((...args: unknown[]) => unknown) | undefined;
  };
  return evaluate(module, module.exports, requireFn);
}

async function proxyFetchViaMainThread(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET') || 'GET';
  const headers: Record<string, string> = {};
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
  }
  // The main-thread bridge only forwards string bodies. Serialize the common
  // RequestInit body types here so proxied POST/PUT requests keep their payload.
  let body: string | undefined;
  const rawBody = init?.body;
  if (typeof rawBody === 'string') {
    body = rawBody;
  } else if (rawBody instanceof URLSearchParams) {
    body = rawBody.toString();
    if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  } else if (rawBody instanceof FormData) {
    const params = new URLSearchParams();
    rawBody.forEach((value, key) => {
      if (typeof value === 'string') params.append(key, value);
    });
    body = params.toString();
    if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  } else if (rawBody instanceof Blob) {
    body = await rawBody.text();
  } else if (rawBody instanceof ArrayBuffer) {
    body = new TextDecoder().decode(rawBody);
  } else if (rawBody != null) {
    body = String(rawBody);
  }
  const reqId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise<Response>((resolve, reject) => {
    pendingProxy.set(reqId, { resolve, reject });
    worker.postMessage({ type: 'fetch-proxy', reqId, url, method, headers, body });
    // If the main thread never answers (crash, busy, dropped message), the
    // promise must reject so the scraper's 30s budget isn't the only guard.
    setTimeout(() => {
      if (pendingProxy.delete(reqId)) {
        reject(new Error('Proxy fetch timed out after 20000ms.'));
      }
    }, 20000);
  });
}

/**
 * Intercepts worker `fetch`: attempts standard worker fetch first, and if CORS
 * or forbidden headers (`Referer`, `User-Agent`, `Origin`) block it, delegates
 * to the main thread where Android's native HTTP bridge resolves it cleanly.
 * Requests carrying the TMDB key placeholder always go through the main
 * thread, which is the only realm holding the real key.
 */
const smartFetch: typeof fetch = async (input, init) => {
  const requestUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  if (requestUrl.includes(TMDB_KEY_PLACEHOLDER)) {
    return proxyFetchViaMainThread(input, init);
  }
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
    } catch (error) {
      if (isProxyTimeoutError(error)) throw error;
      return proxyFetchViaMainThread(input, init);
    }
  }
  return proxyFetchViaMainThread(input, init);
};

Object.defineProperty(worker, 'fetch', { value: smartFetch, writable: true, configurable: true });

// ───────────────────────── the plugin bridge ─────────────────────────
//
// A plugin's whole outside world is `http(url, opts)`. It is answered by the main
// thread, which owns the per-hop host check (`pluginNetwork.ts`) and the native
// transport; the worker only relays. The reply shape is the one VyseTV documents
// — `{status, url, headers, text}`, header names lower-case, `status: 0` with an
// `error` when the request failed — so a plugin written for upstream reads it the
// same way here.
//
// `fetch` and `XMLHttpRequest` are removed from the plugin's reach rather than
// merely unused: a plugin that reached the network directly would skip the host
// check entirely, which is the one guarantee this whole layer exists to give.

interface PendingHttpRequest {
  resolve: (response: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingHttp = new Map<string, PendingHttpRequest>();

/** Pending extension-preference round trips (SkyStream/AnymeX storage). */
const pendingPrefs = new Map<string, { resolve: (value: string | null) => void; timer: ReturnType<typeof setTimeout>; set: boolean }>();

let httpCounter = 0;

/**
 * One extension preference, read or written on the main thread (a worker has
 * no localStorage). The app stores them per extension, which is where the
 * SkyStream shim's getPreference/setPreference and the AnymeX
 * SharedPreferences land.
 */
function ecoPref(op: 'get' | 'set', storeKey: string, key: string, value?: string): Promise<string | null> {
  const reqId = `pref-${op}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingPrefs.delete(reqId)) resolve(op === 'get' ? null : null);
    }, 5000);
    pendingPrefs.set(reqId, { resolve, timer, set: op === 'set' });
    worker.postMessage({ type: 'eco-prefs', op, reqId, storeKey, key, value });
  });
}

/** What a plugin may call. Never throws: a failure is `status: 0` plus a reason. */
function pluginHttp(url: unknown, options: Record<string, any> = {}): Promise<Record<string, unknown>> {
  const target = String(url == null ? '' : url);
  const reqId = `http-${++httpCounter}-${Math.random().toString(36).slice(2)}`;
  const timeout = Math.min(Math.max(Number(options.timeout) || 12000, 1000), 20000);
  // Header values are flattened to strings: extensions (ecosystem ones above
  // all) hand over Headers objects, arrays, or computed values, and a
  // non-string value would make the relay post uncloneable.
  const headers: Record<string, string> = {};
  if (options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) {
    for (const [key, value] of Object.entries(options.headers as Record<string, unknown>)) {
      if (value == null) continue;
      if (typeof value === 'string') {
        headers[key] = value;
        continue;
      }
      try {
        const serialized = JSON.stringify(value);
        headers[key] = serialized === undefined ? String(value) : serialized;
      } catch {
        headers[key] = String(value);
      }
    }
  }
  const payload = {
    url: target,
    method: String(options.method || 'GET').toUpperCase(),
    headers,
    // `body` may be an object; the contract says it is then sent as JSON.
    body:
      options.body == null
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body),
    timeout,
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingHttp.delete(reqId)) resolve({ status: 0, url: target, headers: {}, text: '', error: 'timed out' });
    }, timeout + 1500);
    pendingHttp.set(reqId, { resolve, timer });
    worker.postMessage({ type: 'plugin-http', reqId, ...payload });
  });
}

/** The globals a plugin script is written against. */
const PLUGIN_GLOBALS: Record<string, unknown> = {
  searchQueries,
  titleList,
  parseTitle,
  titleScore,
  rankMatches,
  bestMatch,
  searchBest,
  searchByImdb,
  imdbMatches,
  parseHtml,
  unescapeHtml,
};

/** Line lengths are capped so one huge log line cannot bloat the reply. */
const LOG_MAX = 300;

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

  if (payload?.type === 'plugin-http-response') {
    const pending = pendingHttp.get(payload.reqId);
    if (!pending) return;
    pendingHttp.delete(payload.reqId);
    clearTimeout(pending.timer);
    pending.resolve({
      status: Number(payload.status) || 0,
      url: payload.url,
      headers: payload.headers && typeof payload.headers === 'object' ? payload.headers : {},
      text: typeof payload.text === 'string' ? payload.text : '',
      error: payload.error || undefined,
    });
    return;
  }

  if (payload?.type === 'eco-prefs-response') {
    const pending = pendingPrefs.get(payload.reqId);
    if (!pending) return;
    pendingPrefs.delete(payload.reqId);
    clearTimeout(pending.timer);
    pending.resolve(payload.value == null ? null : String(payload.value));
    return;
  }

  // A plugin from a repository (a hand-written one, a scraper-list entry, or a
  // Vega provider). Its script arrives already composed by the main thread.
  if (payload?.type === 'plugin-run') {
    await runPluginJob(payload);
    return;
  }

  const { code, args, scraperId, settings, mode } = payload;
  try {
    const module = { exports: {} as Record<string, unknown> };
    const setGlobal = (name: string, value: unknown) => {
      Object.defineProperty(worker, name, { value, writable: true, configurable: true });
    };
    setGlobal('window', worker);
    setGlobal('global', worker);
    setGlobal('SCRAPER_ID', scraperId);
    setGlobal('SCRAPER_SETTINGS', settings || {});
    setGlobal('TMDB_API_KEY', TMDB_KEY_PLACEHOLDER);
    setGlobal('cheerio', cheerio);
    setGlobal('CryptoJS', CryptoJS);
    const require = (name: string) => {
      if (['cheerio', 'cheerio-without-node-native', 'react-native-cheerio'].includes(name)) return cheerio;
      if (name === 'crypto-js') return CryptoJS;
      throw new Error(`Module '${name}' is not available in the PRAHA web runtime.`);
    };
    const context = runScript(code, module, require);
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

/**
 * Runs one plugin script and answers with its streams.
 *
 * The plugin's world is built here, not left to chance:
 *
 *   * `http()` is the only way out, and it goes through the main thread's guard.
 *   * `fetch`, `XMLHttpRequest` and `WebSocket` are undefined, so there is no
 *     second way out that would skip that guard.
 *   * `console.*` is captured instead of printed: a TV's log is unreadable, and
 *     VyseTV shows these lines in Settings for the same reason.
 *   * the title/HTML helpers are copied onto the global, which is how a plugin
 *     written for VyseTV finds them (`Object.assign`, not evaluation).
 *
 * A scraper-list script is wrapped by `composeScraperScript`, so its `getStreams`
 * comes from the adapter rather than from its own exports; a Vega provider's
 * script registers its modules on `__vega` and defines `getStreams` itself.
 */
async function runPluginJob(payload: {
  code: string;
  query: Record<string, unknown>;
  kind: 'plugin' | 'scraper' | 'vega';
  name?: string;
  /** Ask this global instead of `getStreams` (a catalog page, a title's details). */
  entry?: string;
  /**
   * Argument array for the entry call. Ecosystem extensions (Sora, SkyStream,
   * Zangetsu, AnymeX) are invoked positionally — `search("kw", 1, [])` — which
   * is how their reference runtimes call them; absent, the single `query`
   * object is passed as before.
   */
  args?: unknown[];
}): Promise<void> {
  const log: string[] = [];
  const capture = (...parts: unknown[]) => {
    const line = parts.map((p) => (typeof p === 'string' ? p : safeString(p))).join(' ');
    if (log.length < LOG_MAX) log.push(line.slice(0, 2000));
  };

  const scope = worker as unknown as Record<string, any>;
  const define = (name: string, value: unknown) => {
    Object.defineProperty(worker, name, { value, writable: true, configurable: true });
  };

  try {
    define('window', worker);
    define('global', worker);
    define('self', worker);
    // The plugin contract: one door out, and no other.
    define('http', pluginHttp);
    // Extension preference storage (a worker cannot touch localStorage):
    // `__ecoPrefGet(store, key)` / `__ecoPrefSet(store, key, value)` round-trip
    // to the main thread, which keeps the values per extension.
    define('__ecoPrefGet', (storeKey: string, key: string) => ecoPref('get', String(storeKey ?? ''), String(key ?? '')));
    define('__ecoPrefSet', (storeKey: string, key: string, value: string) => ecoPref('set', String(storeKey ?? ''), String(key ?? ''), value == null ? '' : String(value)));
    define('fetch', undefined);
    define('XMLHttpRequest', undefined);
    define('WebSocket', undefined);
    define('console', { log: capture, info: capture, warn: capture, error: capture, debug: capture });
    define('cheerio', cheerio);
    define('CryptoJS', CryptoJS);
    define('__axiosLib', axios);
    define('__cheerioLib', cheerio);
    for (const [name, value] of Object.entries(PLUGIN_GLOBALS)) define(name, value);

    const module = { exports: {} as Record<string, unknown> };
    const require = (name: string) => {
      if (['cheerio', 'cheerio-without-node-native', 'react-native-cheerio'].includes(name)) return cheerio;
      if (name === 'crypto-js') return CryptoJS;
      if (name === 'axios') return axios;
      throw new Error(`Cannot find module '${name}'`);
    };

    // A scraper list's script calls `__scrapers.load(...)` and then exposes the
    // adapter's own getStreams; the adapter is the sandbox's, not the scraper's.
    if (payload.kind === 'scraper') {
      define('__scrapers', createScraperAdapter(scope));
    }
    // A Vega provider's script calls `__vega.source(...)` and `__vega.module(...)`
    // before defining its own getStreams. The runtime is built here so its axios
    // and fetch both ride `http()`.
    if (payload.kind === 'vega') {
      const runtime = createVegaRuntime(pluginHttp as any, axios as any, cheerio);
      define('__vega', {
        source: runtime.source,
        module: runtime.module,
        // Browsing and details: the provider's `posts` and `meta` modules, read
        // through the same runtime so their presence on the site is discovered
        // the same way a stream is.
        catalog: runtime.catalog,
        meta: runtime.meta,
        describe: runtime.describe,
      });
    }

    const context = runScript(payload.code, module, require);
    const exported = context.exported as Record<string, unknown>;
    if (payload.entry) {
      // Another of the plugin's functions: a catalog page, a title's details.
      // It is reached by its global name, which is how a plugin declares them
      // (`__scraperCatalog` on the adapter, `__vegaCatalog` on the runtime).
      const fn = (typeof exported[payload.entry] === 'function' ? exported[payload.entry] : undefined)
        || context.local(payload.entry);
      if (typeof fn !== 'function') throw new Error(`This plugin has no ${payload.entry}().`);
      // Positional args when the caller sent an array (ecosystem extensions),
      // the single query object otherwise — the shape VyseTV's engine used.
      const callArgs = Array.isArray(payload.args) ? payload.args : [payload.query];
      const value = await (fn as (...callArgs: unknown[]) => unknown)(...callArgs);
      // Upstream serialises every answer (QuickJS stringify); structured clone
      // is stricter, so a module result carrying a live Promise or method is
      // flattened to its JSON shape before it crosses back to the app.
      let clonable: unknown = value ?? null;
      try {
        structuredClone(clonable);
      } catch {
        clonable = JSON.parse(JSON.stringify(clonable, (_key, item: unknown) =>
          (item instanceof Promise || typeof item === 'function') ? null : item));
      }
      worker.postMessage({ type: 'plugin-done', ok: true, value: clonable, log });
      return;
    }
    const getStreams = exported.getStreams || context.localGetStreams || scope.getStreams;
    if (typeof getStreams !== 'function') {
      throw new Error('This plugin does not define getStreams().');
    }
    const streams = await getStreams(payload.query);
    worker.postMessage({ type: 'plugin-done', ok: true, streams: streams || [], log });
  } catch (error) {
    worker.postMessage({
      type: 'plugin-done',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      streams: [],
      log,
    });
  }
}

/** A log argument as text, without letting a circular object throw. */
function safeString(value: unknown): string {
  try {
    if (value instanceof Error) return value.message;
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return '[unprintable]';
  }
}

export {};
