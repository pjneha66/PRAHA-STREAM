import { nativeFetchText } from './androidBridge';

/**
 * Stream health checker (port of PlayTorrio's StreamHealthChecker / IPTV
 * alive-checker): a tiny ranged GET that detects dead streams before the
 * player wastes 12s on them. A stream is "alive" when it answers 2xx (206
 * partial counts) and its head bytes don't look like an HTML error page.
 */

const DEAD_CONTENT_TYPES = ['text/html', 'application/json', 'text/plain', 'application/xml'];

export interface StreamHealthResult {
  ok: boolean;
  status: number;
  /** Milliseconds the probe took — useful for picking the fastest mirror. */
  latencyMs: number;
  detail: string;
}

const HEALTH_TIMEOUT_MS = 5000;

export async function probeStreamHealth(url: string, headers: Record<string, string> = {}): Promise<StreamHealthResult> {
  const started = Date.now();
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, status: 0, latencyMs: 0, detail: 'Not a probeable URL' };
  }
  try {
    const response = await nativeFetchText(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-65535', ...headers },
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - started;
    const contentType = '';
    const head = (response.data || '').slice(0, 256).trim().toLowerCase();
    // m3u8 playlists and mp4/mkv binary heads are both fine; HTML/JSON error bodies are not.
    const looksHtml = head.startsWith('<!doctype') || head.startsWith('<html');
    const ok = response.status >= 200 && response.status < 300 && !looksHtml;
    return {
      ok,
      status: response.status,
      latencyMs,
      detail: ok ? 'Alive' : `Unusable response (${response.status})`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message : 'Probe failed',
    };
  }
}

/** First-alive picker: probes candidates with bounded concurrency, keeps order. */
export async function pickFirstHealthyStream<T extends { url: string }>(
  candidates: T[],
  options: { maxProbes?: number; headers?: (item: T) => Record<string, string> } = {},
): Promise<T | null> {
  const maxProbes = options.maxProbes ?? 4;
  const slice = candidates.slice(0, maxProbes);
  const results = await Promise.all(slice.map((item) => probeStreamHealth(item.url, options.headers?.(item) || {})));
  const winnerIndex = results.findIndex((result) => result.ok);
  if (winnerIndex < 0) return null;
  // Prefer the lowest-latency healthy probe among the first few, but never
  // skip an earlier healthy one by more than 40% latency — order still matters.
  let best = winnerIndex;
  for (let i = winnerIndex + 1; i < results.length; i += 1) {
    if (results[i].ok && results[i].latencyMs < results[best].latencyMs * 0.6) best = i;
  }
  return slice[best];
}
