// HTTP transport for the Live TV port.
//
// Every request in this feature goes through `nativeFetchText` from the
// Android bridge (GPL-3.0-or-later project). No bare `fetch` or axios.
// Mirrors the small `_httpGet` helper in VyseTV's `iptv_network.dart`.

import { nativeFetchBytes, nativeFetchText } from '../androidBridge';

export interface TextResponse {
  ok: boolean;
  status: number;
  data: string;
  headers?: Record<string, string>;
}

export interface BytesResponse {
  ok: boolean;
  status: number;
  bytes: Uint8Array | null;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** Fetch text with a timeout. Network failures become a non-ok response. */
export async function fetchText(url: string, options: HttpOptions = {}): Promise<TextResponse> {
  try {
    const res = await nativeFetchText(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      timeoutMs: options.timeoutMs ?? 8000,
    });
    return {
      ok: Boolean(res.ok),
      status: res.status ?? 0,
      data: res.data || '',
      headers: res.headers,
    };
  } catch {
    return { ok: false, status: 0, data: '' };
  }
}

/** Return the response body only on a 2xx status. */
export async function getText(url: string, timeoutMs = 8000, headers: Record<string, string> = {}): Promise<string | null> {
  const res = await fetchText(url, { headers, timeoutMs });
  return res.ok && res.status >= 200 && res.status < 300 && res.data ? res.data : null;
}

/**
 * Fetch a raw byte body with a timeout. Used for the gzipped Cloud Vault
 * catalog, whose bytes must not pass through a text decoder. Mirrors
 * VyseTV's `res.bodyBytes` handling in `iptv_network.dart`.
 */
export async function fetchBytes(url: string, headers: Record<string, string> = {}, timeoutMs = 15000): Promise<BytesResponse> {
  try {
    const res = await nativeFetchBytes(url, { headers, timeoutMs });
    return { ok: Boolean(res.ok), status: res.status ?? 0, bytes: res.bytes };
  } catch {
    return { ok: false, status: 0, bytes: null };
  }
}

/** Parse a JSON response; malformed bodies become `null`. */
export async function getJson<T = any>(url: string, timeoutMs = 8000, headers: Record<string, string> = {}): Promise<T | null> {
  const text = await getText(url, timeoutMs, { Accept: 'application/json', ...headers });
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 2xx / 3xx means the stream started answering — used by health checks. */
export async function probeUrl(url: string, timeoutMs = 8000, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; latencyMs: number }> {
  const started = Date.now();
  const res = await fetchText(url, {
    headers: { Range: 'bytes=0-1024', ...headers },
    timeoutMs,
  });
  return {
    ok: res.ok && res.status >= 200 && res.status < 400,
    status: res.status,
    latencyMs: Date.now() - started,
  };
}
