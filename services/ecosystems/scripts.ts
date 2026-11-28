// Fetching an ecosystem extension's script — the text the sandbox will run.
//
// Hikari's managers download each extension to filesDir and run it from disk;
// this port fetches through the guarded transport (`pluginFetch`, so an
// extension cannot point its script at this device's own network) and keeps a
// small in-memory cache keyed by URL, the same way `pluginScripts.ts` caches
// the plugin engine's composed scripts. Upstream's per-extension byte cap
// (2 MB) is kept: a script that large is not an extension.

import { pluginFetch } from '../pluginTransport';

/** Hikari's MAX_BYTES for Sora / AnymeX / Zangetsu scripts. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const CACHE_LIMIT = 40;
const cache = new Map<string, string>();

/** Test seam: forget the cached scripts. */
export function resetEcosystemScriptCache(): void {
  cache.clear();
}

/**
 * One extension script. Throws with a message fit to show when the download
 * fails, is an HTML error page, or exceeds the cap.
 */
export async function fetchEcosystemScript(url: string, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
  const cached = cache.get(url);
  if (cached !== undefined) return cached;
  const answer = await pluginFetch(url, { timeout: 20000 });
  if (answer.status === 0) throw new Error(answer.error || `Could not download ${url}.`);
  if (answer.status === 404) throw new Error(`That extension's script is missing (404): ${url}`);
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`The extension's server answered ${answer.status}: ${url}`);
  }
  const text = answer.text;
  // A dead URL answering the host's HTML error page is not an extension.
  const head = text.slice(0, 512).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    throw new Error(`That link answers an HTML page, not an extension script: ${url}`);
  }
  if (!text.trim()) throw new Error('The extension script is empty.');
  if (text.length > maxBytes) {
    throw new Error(`That script is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, so it was not run (${url}).`);
  }
  cache.set(url, text);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return text;
}
