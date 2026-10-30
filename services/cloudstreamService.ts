import type {
  CloudStreamPluginEntry, CloudStreamProvider, CloudStreamRepository,
  MediaItem, StreamResult,
} from '../types';

async function fetchText(url: string, timeout = 20000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${new URL(url).hostname}.`);
    return await response.text();
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * CloudStream repositories are described by a `repo.json` manifest (a
 * repository-of-repositories) that lists one or more `plugins.json` files,
 * each of which is a flat array of extension entries. A direct
 * `plugins.json` URL is also accepted, and the legacy v2 `{ addons: [...] }`
 * shape is supported for older repositories.
 *
 * Extensions are compiled Kotlin `.cs3` packages by default and can only run
 * inside the native CloudStream app. Repositories that publish JavaScript
 * extensions (CloudStream JS) expose `search()`, `getEpisodes()` and
 * `getStreams()`, which PRAHA runs in a web worker.
 */
export function normalizeCloudStreamRepositoryUrl(rawUrl: string) {
  let value = rawUrl.trim();
  if (!value) throw new Error('Paste a CloudStream repository URL to continue.');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  url.hash = '';
  if (/\/plugins\.json$/i.test(url.pathname)) return url.toString();
  if (!/\.json$/i.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, '')}/repo.json`;
  return url.toString();
}

const normalizeUrl = (raw: string) => {
  let value = String(raw).trim();
  if (!value) return value;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  // GitHub "blob" pages need to become raw file links before they are fetchable.
  value = value.replace(/\/blob\//, '/raw/');
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
};

const shortName = (url: string) => {
  try {
    const { hostname, pathname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1].replace(/\.json$/i, '') || hostname : hostname;
  } catch {
    return url;
  }
};

const normalizeTypes = (tvTypes?: string[]) => {
  const types = new Set<string>();
  (tvTypes || []).forEach((type) => {
    const value = String(type || '').toLowerCase();
    if (['movie', 'film'].includes(value)) types.add('movie');
    else if (['tvseries', 'tv', 'series', 'show', 'anime', 'live', 'other'].includes(value)) types.add('series');
  });
  return [...types];
};

/** Read the `// @plugin-info { ... }` header that CloudStream JS plugins carry. */
const parsePluginInfo = (code: string): Partial<CloudStreamPluginEntry> => {
  const match = code.match(/@plugin-info\s*(\{[\s\S]*?\})/);
  if (!match) return {};
  try {
    const info = JSON.parse(match[1]);
    return {
      name: info.name,
      version: info.version,
      description: info.description,
      iconUrl: info.icon_url || info.iconUrl,
      language: info.language,
      tvTypes: info.supported_types || info.tvTypes,
      authors: info.author ? [info.author] : info.authors,
    };
  } catch {
    return {};
  }
};

const providerId = (manifestUrl: string, index: number, name: string) =>
  `${manifestUrl.toLowerCase()}:${index}:${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const buildProviders = async (
  manifestUrl: string,
  entries: CloudStreamPluginEntry[],
  previous?: CloudStreamRepository,
): Promise<CloudStreamProvider[]> => {
  // Fetch JavaScript extension sources in parallel (skip native .cs3 packages).
  const jobs = entries
    .map((entry, index) => ({ entry, index }))
    .filter((item) => item.entry?.name)
    .map(async ({ entry, index }) => {
      const id = providerId(manifestUrl, index, entry.name!);
      const isNative = /\.cs3(\?|$)/i.test(entry.url || '');
      let code: string | undefined;
      let info: Partial<CloudStreamPluginEntry> = {};
      if (!isNative && entry.url) {
        try {
          code = await fetchText(normalizeUrl(entry.url));
          info = parsePluginInfo(code);
        } catch (error) {
          console.warn(`Unable to load CloudStream extension ${entry.name}`, error);
        }
      }
      const merged: CloudStreamProvider = {
        ...entry,
        ...Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined && value !== null)),
        id,
        repositoryId: manifestUrl,
        enabled: entry.enabled === false ? false : previous?.providers.find((provider) => provider.id === id)?.enabled ?? true,
        manifestEnabled: entry.enabled !== false,
        supportedTypes: normalizeTypes(entry.tvTypes).length
          ? normalizeTypes(entry.tvTypes)
          : normalizeTypes(info.tvTypes).length
            ? normalizeTypes(info.tvTypes)
            : ['movie', 'series'],
        code,
        nativeOnly: isNative,
        installedAt: Date.now(),
      };
      return merged;
    });

  return Promise.all(jobs);
};

const buildRepository = async (
  manifestUrl: string,
  entries: CloudStreamPluginEntry[],
  previous?: CloudStreamRepository,
  meta: Partial<Pick<CloudStreamRepository, 'name' | 'description' | 'manifestVersion' | 'pluginListUrls'>> = {},
): Promise<CloudStreamRepository> => {
  const providers = await buildProviders(manifestUrl, entries, previous);
  if (!providers.length) throw new Error('The repository loaded, but it did not list any extensions.');
  return {
    manifestUrl,
    name: meta.name || shortName(manifestUrl),
    description: meta.description || '',
    manifestVersion: meta.manifestVersion,
    pluginListUrls: meta.pluginListUrls?.length ? meta.pluginListUrls : [manifestUrl],
    enabled: previous?.enabled ?? true,
    providers,
    installedAt: previous?.installedAt || Date.now(),
    updatedAt: Date.now(),
  };
};

export async function fetchCloudStreamRepository(rawUrl: string, previous?: CloudStreamRepository): Promise<CloudStreamRepository> {
  const manifestUrl = normalizeCloudStreamRepositoryUrl(rawUrl);
  const payload = await fetchText(manifestUrl);
  let parsed: any;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('The CloudStream repository manifest is not valid JSON.');
  }

  if (Array.isArray(parsed)) {
    return buildRepository(manifestUrl, parsed, previous, { name: shortName(manifestUrl), pluginListUrls: [manifestUrl] });
  }

  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.scrapers)) {
      throw new Error('This looks like a Nuvio repository. Use the Nuvio Plugins tab to install it.');
    }
    if (Array.isArray(parsed.pluginLists) && parsed.pluginLists.length) {
      const lists = await Promise.all(parsed.pluginLists.map((listUrl: string) =>
        fetchText(normalizeUrl(listUrl)).then((text) => {
          try {
            const data = JSON.parse(text);
            return Array.isArray(data) ? data : [];
          } catch {
            console.warn(`Unable to parse CloudStream plugin list ${listUrl}`);
            return [];
          }
        }),
      ));
      const entries = lists.flat() as CloudStreamPluginEntry[];
      return buildRepository(manifestUrl, entries, previous, {
        name: parsed.name || shortName(manifestUrl),
        description: parsed.description,
        manifestVersion: parsed.manifestVersion,
        pluginListUrls: parsed.pluginLists.map((url: string) => normalizeUrl(url)),
      });
    }
    if (Array.isArray(parsed.addons)) {
      const entries = parsed.addons.map((addon: CloudStreamPluginEntry) => ({
        name: addon.name,
        version: addon.version,
        url: addon.url,
        iconUrl: addon.iconUrl,
        language: addon.language,
        tvTypes: addon.tvTypes,
        authors: addon.authors,
        fileSize: addon.fileSize,
        status: addon.status,
      }));
      return buildRepository(manifestUrl, entries, previous, {
        name: parsed.name || shortName(manifestUrl),
        description: parsed.description,
        manifestVersion: parsed.manifestVersion,
        pluginListUrls: [manifestUrl],
      });
    }
    throw new Error('This JSON file is not a valid CloudStream repository manifest.');
  }

  throw new Error('This JSON file is not a valid CloudStream repository manifest.');
}

/* --------------------------------- runtime -------------------------------- */

export interface CloudStreamEpisode {
  id: string;
  title: string;
  season: number;
  episode: number;
  thumbnail: string;
}

function runWorker(provider: CloudStreamProvider, args: Record<string, unknown>, mode: 'search' | 'episodes' | 'streams', tmdbApiKey?: string): Promise<any> {
  if (!provider.code) throw new Error('This CloudStream extension is a native .cs3 package and cannot run in a browser.');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./cloudstreamWorker.ts', import.meta.url), { type: 'module' });
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('The extension timed out after 30 seconds.'));
    }, 30000);
    worker.onmessage = (event) => {
      window.clearTimeout(timer);
      worker.terminate();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error || 'The extension failed.'));
    };
    worker.onerror = (event) => {
      window.clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || 'The CloudStream extension worker could not start.'));
    };
    worker.postMessage({ code: provider.code, args, providerId: provider.id, mode, tmdbApiKey });
  });
}

const mediaTypeOf = (raw: any): 'movie' | 'series' => {
  const type = String(raw?.media_type || raw?.type || '').toLowerCase();
  return ['show', 'series', 'tv', 'anime'].includes(type) ? 'series' : 'movie';
};

export function normalizeCloudStreamSearch(raw: any[], provider: CloudStreamProvider): MediaItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && (item.id || item.url || item.title))
    .map((item) => ({
      id: `cs:${provider.id}:${String(item.id ?? item.url ?? item.title)}`,
      type: mediaTypeOf(item),
      title: item.title || item.name || 'Untitled',
      overview: item.description || '',
      poster: item.poster_url || item.poster || '',
      backdrop: item.backdrop_url || item.thumbnail_url || item.poster_url || '',
      year: item.year ? String(item.year).slice(0, 4) : undefined,
      rating: item.rating ? Number(item.rating) : undefined,
      genres: [],
      source: 'cloudstream' as const,
      providerId: provider.id,
      providerMediaId: String(item.id ?? item.url ?? item.title),
      addonUrl: provider.repositoryId,
    }));
}

export function normalizeCloudStreamEpisodes(raw: any[]): CloudStreamEpisode[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => ({
    id: String(item?.id ?? index + 1),
    title: item?.title || item?.name || `Episode ${item?.episode_number || index + 1}`,
    season: Number(item?.season) || 1,
    episode: Number(item?.episode_number) || index + 1,
    thumbnail: item?.thumbnail_url || item?.thumbnail || '',
  }));
}

export function normalizeCloudStreamStreams(raw: any[], provider: CloudStreamProvider): StreamResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.reduce<StreamResult[]>((results, item, index) => {
    const url = typeof item?.url === 'string' ? item.url : item?.url?.url;
    if (!url) return results;
    results.push({
      id: `${provider.id}-${index}-${item.infoHash || url}`,
      title: item.title || item.name || item.quality || `${provider.name} source`,
      url,
      sourceName: provider.name,
      sourceType: 'cloudstream',
      quality: item.quality,
      size: item.size,
      language: item.language,
      provider: item.provider || provider.name,
      headers: item.headers,
      subtitles: item.subtitles,
      externalUrl: item.externalUrl,
      ytId: item.ytId,
      behaviorHints: item.behaviorHints,
    });
    return results;
  }, []);
}

export async function searchCloudStreamProvider(provider: CloudStreamProvider, query: string, tmdbApiKey?: string) {
  const raw = await runWorker(provider, { query }, 'search', tmdbApiKey);
  return normalizeCloudStreamSearch(raw, provider);
}

export async function getCloudStreamEpisodes(provider: CloudStreamProvider, showId: string, tmdbApiKey?: string) {
  const raw = await runWorker(provider, { showId }, 'episodes', tmdbApiKey);
  return normalizeCloudStreamEpisodes(raw);
}

export async function getCloudStreamStreams(
  provider: CloudStreamProvider,
  mediaId: string,
  mediaType: 'movie' | 'series',
  tmdbApiKey?: string,
  tmdbId?: string,
  season?: number,
  episode?: number,
) {
  const raw = await runWorker(provider, { mediaId, mediaType, tmdbId, season, episode }, 'streams', tmdbApiKey);
  return normalizeCloudStreamStreams(raw, provider);
}
