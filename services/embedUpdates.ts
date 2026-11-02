import { EMBED_PRESETS, validateEmbedTemplate } from './embedProviders';

export type TemplateOverrides = Record<string, { movie: string; series: string }>;
// Published when this repository's main branch contains public/embed-providers.json.
export const DEFAULT_EMBED_UPDATE_URL = 'https://raw.githubusercontent.com/pjneha66/PRAHA-STREAM/main/public/embed-providers.json';
export const EMBED_UPDATE_INTERVAL = 24 * 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;

export function validateUpdateUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error('Use an HTTPS feed URL without credentials, query or fragment.');
  }
  return url.href;
}

/** Strict, atomic validation: one bad entry rejects the entire update. */
export function parseEmbedUpdate(value: unknown): TemplateOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid update feed.');
  const payload = value as { version?: unknown; providers?: unknown };
  if (payload.version !== 1 || !Array.isArray(payload.providers) || payload.providers.length > 100) throw new Error('Unsupported update feed format.');
  const known = new Set(EMBED_PRESETS.map((item) => item.id));
  const result: TemplateOverrides = Object.create(null);
  for (const entry of payload.providers) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') throw new Error('Update feed contains an invalid provider.');
    // New providers can be added to the feed without breaking older app versions.
    if (!known.has(entry.id)) continue;
    if (Object.hasOwn(result, entry.id) || typeof entry.movie !== 'string' || typeof entry.series !== 'string') throw new Error('Update feed contains a duplicate or invalid provider.');
    validateEmbedTemplate(entry.movie, 'movie');
    validateEmbedTemplate(entry.series, 'series');
    result[entry.id] = { movie: entry.movie, series: entry.series };
  }
  return result;
}

/** No redirects, credentials or viewing data; JSON only, bounded to 64 KiB. */
export async function fetchEmbedUpdate(url: string, signal?: AbortSignal): Promise<TemplateOverrides> {
  const safeUrl = validateUpdateUrl(url);
  const response = await fetch(safeUrl, { method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store', signal, headers: { Accept: 'application/json' }, referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`Update feed returned HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) throw new Error('Update feed is too large.');
  if (!response.body) throw new Error('Update feed returned no data.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Update feed is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('Update feed is not valid JSON.'); }
  return parseEmbedUpdate(data);
}
