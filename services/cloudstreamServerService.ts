import type { CloudStreamProvider, MediaItem, StreamResult } from '../types';
import type { CloudStreamEpisode } from './cloudstreamService';

/**
 * Client for a CloudStream plugin server — the runtime that executes native
 * .cs3 providers outside the Android app.
 *
 * CloudStream's working logic (MainAPI.getMainPage/search/load/loadLinks)
 * runs Kotlin/Dalvik plugin code, which a browser cannot execute. The
 * community web client (SusyBegula/cloudstream-web-unofficial, built on the
 * official recloudstream/cloudstream library) runs those plugins on the JVM
 * (dex2jar + Android stubs) and exposes them over HTTP/WebSocket:
 *
 *   GET  /api/providers                         -> { providers: [{ name, mainUrl, lang, supportedTypes }] }
 *   GET  /api/providers/{name}/main-page        -> { rows: [{ name, items: [SearchResultDto] }] }
 *   GET  /api/search?q=&provider=               -> { results: [{ provider, results: [SearchResultDto] }] }
 *   POST /api/load { provider, url }            -> LoadResponseDto { kind, dataUrl, episodes: [{ data, name, season, episode }] }
 *   WS   /api/links?provider=&data=             -> { kind: "link" | "subtitle" | "done" | "error", link }
 *
 * PRAHA talks to a user-supplied server URL (Settings → CloudStream Server).
 * Response mapping is deliberately tolerant of field-name variations.
 */

export function normalizeCloudStreamServerUrl(raw: string): string {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value.replace(/\/+$/, '');
}

async function fetchJson(url: string, init?: RequestInit, timeout = 30000): Promise<any> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`CloudStream server returned HTTP ${response.status} for ${new URL(url).pathname}.`);
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The CloudStream server did not respond in time. Is it running?');
    }
    if (error instanceof TypeError) {
      throw new Error('Could not reach the CloudStream server. Check the URL in Settings and that the server is running.');
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export interface ServerProviderInfo {
  name: string;
  mainUrl?: string;
  lang?: string;
  supportedTypes?: string[];
}

const normalizeName = (name: string) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const providersCache = new Map<string, Promise<ServerProviderInfo[]>>();

export function listServerProviders(serverUrl: string): Promise<ServerProviderInfo[]> {
  const base = normalizeCloudStreamServerUrl(serverUrl);
  if (!base) return Promise.reject(new Error('Add your CloudStream server URL in Settings first.'));
  if (!providersCache.has(base)) {
    providersCache.set(base, (async () => {
      const data = await fetchJson(`${base}/api/providers`);
      const list = Array.isArray(data) ? data : data?.providers || [];
      return list
        .filter((entry: any) => entry?.name)
        .map((entry: any) => ({
          name: String(entry.name),
          mainUrl: entry.mainUrl,
          lang: entry.lang,
          supportedTypes: Array.isArray(entry.supportedTypes) ? entry.supportedTypes.map(String) : [],
        }));
    })());
  }
  return providersCache.get(base)!;
}

/** Test the Settings connection and return how many providers the server runs. */
export async function testCloudStreamServer(serverUrl: string): Promise<ServerProviderInfo[]> {
  providersCache.delete(normalizeCloudStreamServerUrl(serverUrl));
  return listServerProviders(serverUrl);
}

/**
 * Manifest names often carry decorations the plugin's real name does not
 * ("[Indian] AllMovieLandProvider" vs "AllMovieLand"). Match on the
 * alphanumeric core, exact first, then containment.
 */
export async function resolveServerProviderName(serverUrl: string, manifestName: string): Promise<string> {
  const providers = await listServerProviders(serverUrl);
  const target = normalizeName(manifestName);
  const exact = providers.find((entry) => normalizeName(entry.name) === target);
  if (exact) return exact.name;
  const fuzzy = providers.find((entry) => {
    const candidate = normalizeName(entry.name);
    return candidate && (target.includes(candidate) || candidate.includes(target.replace(/provider$/, '')) || target.replace(/provider$/, '').includes(candidate));
  });
  if (fuzzy) return fuzzy.name;
  throw new Error(`"${manifestName}" is not running on your CloudStream server. Install its repository on the server first.`);
}

const typeOf = (raw: any): 'movie' | 'series' => {
  const type = String(raw?.type || '').toLowerCase();
  return /series|anime|tv|show/.test(type) ? 'series' : 'movie';
};

function mapSearchItems(list: any[], provider: CloudStreamProvider): MediaItem[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && (item.url || item.name))
    .map((item) => ({
      id: `cs-server:${provider.id}:${String(item.url)}`,
      type: typeOf(item),
      title: String(item.name || 'Untitled'),
      overview: '',
      poster: item.posterUrl || item.poster_url || '',
      backdrop: item.posterUrl || item.poster_url || '',
      year: item.year ? String(item.year).slice(0, 4) : undefined,
      rating: undefined,
      genres: [],
      source: 'cloudstream' as const,
      providerId: provider.id,
      providerMediaId: String(item.url),
      addonUrl: provider.repositoryId,
    }));
}

export interface ServerMainPageRow {
  name: string;
  items: MediaItem[];
}

export async function fetchServerMainPage(serverUrl: string, serverName: string, provider: CloudStreamProvider): Promise<ServerMainPageRow[]> {
  const base = normalizeCloudStreamServerUrl(serverUrl);
  const data = await fetchJson(`${base}/api/providers/${encodeURIComponent(serverName)}/main-page?page=1`, undefined, 60000);
  const rows = Array.isArray(data) ? data : data?.rows || data?.items || [];
  return (Array.isArray(rows) ? rows : [])
    .map((row: any) => ({
      name: String(row?.name || row?.title || provider.name),
      items: mapSearchItems(row?.items || row?.results || [], provider),
    }))
    .filter((row: ServerMainPageRow) => row.items.length > 0);
}

export async function searchServerProvider(serverUrl: string, serverName: string, query: string, provider: CloudStreamProvider): Promise<MediaItem[]> {
  const base = normalizeCloudStreamServerUrl(serverUrl);
  const data = await fetchJson(`${base}/api/search?q=${encodeURIComponent(query)}&provider=${encodeURIComponent(serverName)}`, undefined, 60000);
  const groups = Array.isArray(data) ? data : data?.results || [];
  const items: MediaItem[] = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    items.push(...mapSearchItems(group?.results || group?.items || [], provider));
  }
  return items;
}

export interface ServerLoadResult {
  kind: 'movie' | 'series' | 'live';
  dataUrl?: string;
  episodes: CloudStreamEpisode[];
}

export async function loadServerTitle(serverUrl: string, serverName: string, url: string): Promise<ServerLoadResult> {
  const base = normalizeCloudStreamServerUrl(serverUrl);
  const data = await fetchJson(`${base}/api/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: serverName, url }),
  }, 60000);
  const episodes: CloudStreamEpisode[] = (Array.isArray(data?.episodes) ? data.episodes : []).map((episode: any, index: number) => ({
    id: String(episode?.data ?? episode?.url ?? index + 1),
    title: episode?.name || episode?.title || `Episode ${episode?.episode || index + 1}`,
    season: Number(episode?.season) || 1,
    episode: Number(episode?.episode) || index + 1,
    thumbnail: episode?.posterUrl || '',
  }));
  return {
    kind: data?.kind === 'series' ? 'series' : data?.kind === 'live' ? 'live' : 'movie',
    dataUrl: data?.dataUrl || undefined,
    episodes,
  };
}

/** Collect ExtractorLinks streamed over the server's /api/links WebSocket. */
export function fetchServerLinks(
  serverUrl: string,
  serverName: string,
  data: string,
  provider: CloudStreamProvider,
): Promise<StreamResult[]> {
  const base = normalizeCloudStreamServerUrl(serverUrl);
  const wsBase = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  const url = `${wsBase}/api/links?provider=${encodeURIComponent(serverName)}&data=${encodeURIComponent(data)}`;

  return new Promise((resolve, reject) => {
    const links: StreamResult[] = [];
    let settled = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      reject(new Error('Could not open the CloudStream server link stream.'));
      return;
    }
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(links);
    };
    const timer = window.setTimeout(finish, 45000);
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.kind === 'link' && message.link) {
          const link = message.link;
          const linkUrl = typeof link.url === 'string' ? link.url : link.url?.url;
          if (linkUrl) {
            links.push({
              id: `${provider.id}-server-${links.length}-${linkUrl}`,
              title: link.name || link.quality || `${provider.name} source`,
              url: linkUrl,
              sourceName: provider.name,
              sourceType: 'cloudstream',
              quality: link.quality !== undefined && link.quality !== null ? String(link.quality) : undefined,
              provider: link.source || provider.name,
              headers: link.headers,
              referer: link.referer,
            } as StreamResult);
          }
        } else if (message.kind === 'error') {
          if (!links.length) {
            if (!settled) {
              settled = true;
              window.clearTimeout(timer);
              try { socket.close(); } catch { /* ignore */ }
              reject(new Error(message.message || 'The CloudStream server could not resolve links.'));
            }
          }
        } else if (message.kind === 'done') {
          finish();
        }
      } catch { /* ignore malformed events */ }
    };
    socket.onerror = () => {
      if (!links.length && !settled) {
        settled = true;
        window.clearTimeout(timer);
        reject(new Error('The CloudStream server link stream failed. Is the server running?'));
      } else {
        finish();
      }
    };
    socket.onclose = () => finish();
  });
}
