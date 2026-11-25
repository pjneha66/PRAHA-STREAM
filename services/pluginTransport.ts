// The transport behind a plugin's `http()` — the main-thread half of the plugin
// sandbox. Ported from VyseTV's `_request` in
// `lib/data/sources/plugins/js_plugins.dart` (GPL-3.0-or-later), which fetches
// with `followRedirects = false` and calls `_checkHost` before *every* hop.
//
// The point of that shape is the redirect. A plugin is told "fetch this public
// URL"; the public URL answers `302 Location: http://192.168.1.1/`, and a client
// that follows redirects internally has already read the router's admin page by
// the time anyone could object. So this file follows redirects itself, one hop at
// a time, and runs `assertPublicHttpUrl` on each new address before opening it.
//
// Two transports, one contract:
//
//   * Android, where `pluginHttp` on the native bridge makes a single request and
//     hands back the 30x with its `Location` (it never follows it).
//   * The browser, where `fetch` is given `redirect: 'manual'` and the hop is
//     read from the response headers.
//
// Whichever runs, the guard sees every address that is actually opened.

import { assertPublicHttpUrl, BlockedAddressError } from './pluginNetwork';
import { nativeFetchText, prahaRpc, bridgeRpcAvailable } from './androidBridge';

/** VyseTV's `_maxHops`-style limit: 6 redirects, then give up. */
const MAX_REDIRECTS = 6;

/** VyseTV's `_maxBody`: a plugin's page is text, and 8 MB is already generous. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** What a plugin's `http()` answers — VyseTV's documented shape. */
export interface PluginHttpResult {
  status: number;
  url: string;
  /** Header names are lower-case, as upstream documents. */
  headers: Record<string, string>;
  text: string;
  error?: string;
}

export interface PluginHttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

/** A redirect, as one hop of the chain reports it. */
interface HopResult {
  status: number;
  location?: string;
  text: string;
  headers: Record<string, string>;
  error?: string;
}

const lowerHeaders = (raw: Record<string, string> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw || {})) out[key.toLowerCase()] = String(value);
  return out;
};

const isRedirect = (status: number) => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/**
 * One request, no redirect following.
 *
 * On Android the native `pluginHttp` does exactly that. Everywhere else `fetch`
 * is asked not to follow, and the `Location` header is read back.
 */
async function fetchHop(url: string, options: PluginHttpOptions, timeoutMs: number): Promise<HopResult> {
  const method = (options.method || 'GET').toUpperCase();
  const headers = options.headers || {};

  // An older WebView may predate the `pluginHttp` method. A transport-level miss
  // there must fall through to the browser path, not fail the plugin.
  if (bridgeRpcAvailable()) {
    let raw: string | null = null;
    try {
      raw = await prahaRpc<string>(
        'pluginHttp',
        [url, method, JSON.stringify(headers), options.body || '', timeoutMs],
        timeoutMs + 5000,
      );
    } catch {
      raw = null;
    }
    if (raw !== null && raw !== undefined) {
      let parsed: { ok?: boolean; status?: number; body?: string; location?: string; error?: string } | null = null;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as typeof parsed);
      } catch {
        parsed = null;
      }
      if (parsed) {
        if (parsed.error && !parsed.status) {
          // The native side refused it (its own host gate, or a transport error).
          return { status: 0, text: '', headers: {}, error: parsed.error };
        }
        return {
          status: Number(parsed.status) || 0,
          location: parsed.location,
          text: typeof parsed.body === 'string' ? parsed.body : '',
          headers: {},
        };
      }
      // Unreadable native reply: fall through to the browser path below.
    }
  }

  // Browser: `manual` keeps the redirect visible instead of silently following it.
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    // An opaque redirect has no status or headers to read; treat it as unfollowable.
    if (response.type === 'opaqueredirect') {
      return { status: 0, text: '', headers: {}, error: 'The browser hid the redirect, so it cannot be checked.' };
    }
    const location = responseHeaders.location;
    if (isRedirect(response.status) && location) {
      return { status: response.status, location, text: '', headers: responseHeaders };
    }
    const text = await response.text();
    return { status: response.status, text: text.slice(0, MAX_BODY_BYTES), headers: responseHeaders };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 0, text: '', headers: {}, error: message };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * A plugin's `http()`, with the host checked before every hop.
 *
 * Never throws — a plugin is third-party code and a rejected address is an
 * ordinary answer to it (`status: 0` plus the reason), which is what upstream's
 * contract promises.
 */
export async function pluginFetch(url: string, options: PluginHttpOptions = {}): Promise<PluginHttpResult> {
  const timeoutMs = Math.min(Math.max(Number(options.timeout) || 12000, 1000), 20000);
  const started = Date.now();
  let current = String(url || '').trim();
  let method = (options.method || 'GET').toUpperCase();
  let body = options.body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // The guard runs on the address that is about to be opened — this is the
    // whole reason the loop exists rather than one `fetch`.
    let checked: URL;
    try {
      checked = assertPublicHttpUrl(current);
    } catch (error) {
      return {
        status: 0,
        url: current,
        headers: {},
        text: '',
        error: error instanceof BlockedAddressError ? error.message : 'That address cannot be fetched.',
      };
    }
    current = checked.toString();

    const remaining = timeoutMs - (Date.now() - started);
    if (remaining < 400) {
      return { status: 0, url: current, headers: {}, text: '', error: 'timed out' };
    }

    const result = await fetchHop(current, { method, headers: options.headers, body, timeout: remaining }, remaining);
    if (result.error) {
      return { status: 0, url: current, headers: result.headers, text: '', error: result.error };
    }
    if (!isRedirect(result.status) || !result.location) {
      return { status: result.status, url: current, headers: lowerHeaders(result.headers), text: result.text };
    }

    // Follow the hop ourselves, so the next pass re-checks its host.
    let next: string;
    try {
      next = new URL(result.location, current).toString();
    } catch {
      return { status: 0, url: current, headers: {}, text: '', error: 'That redirect does not lead anywhere valid.' };
    }
    // 303 means "GET the other thing"; 307/308 keep the verb and body.
    if (result.status === 303) {
      method = 'GET';
      body = undefined;
    }
    current = next;
  }

  return { status: 0, url: current, headers: {}, text: '', error: 'Too many redirects' };
}

/** Whether a plugin's request would be allowed, without making it. */
export function pluginCanFetch(url: string): boolean {
  try {
    assertPublicHttpUrl(url);
    return true;
  } catch {
    return false;
  }
}

/** `nativeFetchText` is re-exported for the repo loader, which fetches the manifest itself. */
export { nativeFetchText };
