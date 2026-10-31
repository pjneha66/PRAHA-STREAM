import type {
  InstalledAddon, MediaItem, SourceError, StremioCatalog, StremioManifest,
  StremioResource, StreamResult, StreamSubtitle,
} from '../types';
import { nativeFetchText } from './androidBridge';

async function fetchJson<T = any>(url: string, timeoutMs = 15000): Promise<T> {
  const response = await nativeFetchText(url, {
    headers: { Accept: 'application/json' },
    timeoutMs,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(response.data) as T;
}

export function normalizeStremioUrl(rawUrl: string) {
  let value = rawUrl.trim();
  if (!value) throw new Error('Paste an addon URL to continue.');
  if (value.startsWith('stremio://')) value = `https://${value.slice('stremio://'.length)}`;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  url.hash = '';
  if (!url.pathname.endsWith('/manifest.json')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/manifest.json`;
  }
  return url.toString();
}

export function getAddonConfigureUrl(addon: InstalledAddon): string | undefined {
  if (!addon.manifest.behaviorHints?.configurable && !addon.manifest.behaviorHints?.configurationRequired) {
    return undefined;
  }
  try {
    const url = new URL(addon.manifestUrl);
    url.pathname = url.pathname.replace(/\/manifest\.json$/i, '/configure');
    return url.toString();
  } catch {
    return undefined;
  }
}

const normalizeResources = (manifest: StremioManifest): StremioResource[] =>
  (manifest.resources || []).map((resource) => {
    if (typeof resource === 'string') {
      return { name: resource, types: manifest.types || [] };
    }
    return { ...resource, types: resource.types || manifest.types || [] };
  });

export async function fetchStremioManifest(rawUrl: string): Promise<InstalledAddon> {
  const manifestUrl = normalizeStremioUrl(rawUrl);
  let manifest: StremioManifest;
  try {
    manifest = await fetchJson<StremioManifest>(manifestUrl, 15000);
  } catch (error) {
    throw new Error(error instanceof Error ? `Addon error: ${error.message}` : 'Unable to reach addon.');
  }
  if (!manifest.id || !manifest.name || !manifest.version) {
    throw new Error('This URL did not return a valid Stremio manifest.');
  }
  manifest.resources = normalizeResources(manifest);
  manifest.catalogs = manifest.catalogs || [];
  manifest.types = manifest.types || [];
  return { manifestUrl, manifest, enabled: true, installedAt: Date.now(), updatedAt: Date.now() };
}

const transportBase = (manifestUrl: string) => {
  const url = new URL(manifestUrl);
  url.pathname = url.pathname.replace(/\/manifest\.json$/, '');
  url.search = '';
  return url;
};

const withManifestQuery = (url: URL, manifestUrl: string) => {
  const query = new URL(manifestUrl).search;
  return `${url.toString()}${query}`;
};

export function supportsResource(addon: InstalledAddon, name: string, type: string, id = '') {
  return addon.manifest.resources.some((resource) => {
    const matchesType = !resource.types?.length || resource.types.includes(type) || (type === 'series' && resource.types.includes('tv'));
    const matchesPrefix = !resource.idPrefixes?.length || !id || resource.idPrefixes.some((prefix) => id.startsWith(prefix));
    return resource.name === name && matchesType && matchesPrefix;
  });
}

const imageUrl = (value?: string) => value?.startsWith('http') ? value : '';

export function mapStremioMeta(meta: Record<string, any>, addon: InstalledAddon, fallbackType?: string): MediaItem {
  const type = meta.type === 'tv' ? 'series' : (meta.type || fallbackType || 'movie');
  const release = String(meta.releaseInfo || meta.year || '');
  const genres = Array.isArray(meta.genres) ? meta.genres : Array.isArray(meta.genre) ? meta.genre : [];
  return {
    id: String(meta.id || meta.imdb_id),
    imdbId: meta.imdb_id || (String(meta.id).startsWith('tt') ? String(meta.id) : undefined),
    type: type === 'series' ? 'series' : 'movie',
    title: meta.name || 'Untitled',
    overview: meta.description || '',
    poster: imageUrl(meta.poster),
    backdrop: imageUrl(meta.background),
    logo: imageUrl(meta.logo),
    year: release.slice(0, 4),
    rating: Number(meta.imdbRating) || undefined,
    runtime: meta.runtime || undefined,
    genres,
    source: 'stremio',
    addonUrl: addon.manifestUrl,
  };
}

export async function fetchStremioCatalog(
  addon: InstalledAddon,
  catalog: StremioCatalog,
  options: { search?: string; genre?: string; skip?: number } = {},
): Promise<MediaItem[]> {
  const base = transportBase(addon.manifestUrl);
  const extras: string[] = [];
  if (options.search) extras.push(`search=${encodeURIComponent(options.search)}`);
  if (options.genre) extras.push(`genre=${encodeURIComponent(options.genre)}`);
  if (options.skip) extras.push(`skip=${options.skip}`);
  const suffix = extras.length ? `/${extras.join('&')}` : '';
  base.pathname = `${base.pathname}/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}${suffix}.json`;
  const data = await fetchJson<Record<string, any>>(withManifestQuery(base, addon.manifestUrl));
  return (data.metas || data.metasDetailed || []).map((meta: Record<string, any>) => mapStremioMeta(meta, addon, catalog.type));
}

export async function fetchStremioMeta(addon: InstalledAddon, media: MediaItem): Promise<MediaItem> {
  if (!supportsResource(addon, 'meta', media.type, media.id)) return media;
  const base = transportBase(addon.manifestUrl);
  base.pathname = `${base.pathname}/meta/${media.type}/${encodeURIComponent(media.id)}.json`;
  const data = await fetchJson<Record<string, any>>(withManifestQuery(base, addon.manifestUrl));
  if (!data.meta) return media;
  const detailed = mapStremioMeta(data.meta, addon, media.type);
  return { ...media, ...detailed, tmdbId: media.tmdbId, imdbId: detailed.imdbId || media.imdbId };
}

export async function searchStremioAddons(addons: InstalledAddon[], query: string) {
  const jobs: Promise<MediaItem[]>[] = [];
  addons.filter((addon) => addon.enabled).forEach((addon) => {
    addon.manifest.catalogs
      .filter((catalog) => catalog.extra?.some((extra) => extra.name === 'search'))
      .slice(0, 4)
      .forEach((catalog) => jobs.push(fetchStremioCatalog(addon, catalog, { search: query }).catch(() => [])));
  });
  return (await Promise.all(jobs)).flat();
}

async function fetchAddonStreams(addon: InstalledAddon, media: MediaItem, resourceId: string): Promise<StreamResult[]> {
  const base = transportBase(addon.manifestUrl);
  base.pathname = `${base.pathname}/stream/${media.type}/${encodeURIComponent(resourceId)}.json`;
  const data = await fetchJson<Record<string, any>>(withManifestQuery(base, addon.manifestUrl), 20000);
  return (data.streams || []).map((stream: Record<string, any>, index: number) => {
    const url = typeof stream.url === 'string'
      ? stream.url
      : stream.url?.url || stream.externalUrl || (stream.infoHash ? `magnet:?xt=urn:btih:${stream.infoHash}` : '');
    return {
      id: `${addon.manifest.id}-${index}-${stream.infoHash || stream.ytId || url}`,
      title: stream.title || stream.name || stream.description || 'Stream',
      url,
      sourceName: addon.manifest.name,
      sourceType: 'stremio' as const,
      quality: stream.quality || stream.behaviorHints?.videoQuality,
      provider: stream.name,
      infoHash: stream.infoHash,
      fileIdx: typeof stream.fileIdx === 'number' ? stream.fileIdx : undefined,
      externalUrl: stream.externalUrl,
      ytId: stream.ytId,
      headers: stream.behaviorHints?.proxyHeaders?.request || stream.headers,
      subtitles: stream.subtitles,
      behaviorHints: stream.behaviorHints,
    };
  }).filter((stream: StreamResult) => stream.url || stream.ytId || stream.infoHash);
}

export async function findStremioStreams(
  addons: InstalledAddon[],
  media: MediaItem,
  season?: number,
  episode?: number,
): Promise<{ streams: StreamResult[]; errors: SourceError[] }> {
  const baseId = media.imdbId || media.id;
  const resourceId = media.type === 'series' && season && episode ? `${baseId}:${season}:${episode}` : baseId;
  const eligible = addons.filter((addon) => addon.enabled && supportsResource(addon, 'stream', media.type, baseId));
  const results = await Promise.allSettled(eligible.map((addon) => fetchAddonStreams(addon, media, resourceId)));
  const streams: StreamResult[] = [];
  const errors: SourceError[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') streams.push(...result.value);
    else errors.push({ sourceName: eligible[index].manifest.name, message: result.reason?.message || 'Unable to load streams.' });
  });
  return { streams, errors };
}

/**
 * Queries installed Stremio subtitle addons (`/subtitles/{type}/{id}.json`),
 * such as OpenSubtitles v3, passing optional `videoHash` and `videoSize`
 * hints when reported by the stream.
 */
export async function findStremioSubtitles(
  addons: InstalledAddon[],
  media: MediaItem,
  season?: number,
  episode?: number,
  stream?: StreamResult,
): Promise<StreamSubtitle[]> {
  const baseId = media.imdbId || media.id;
  if (!baseId) return [];
  const resourceId = media.type === 'series' && season && episode ? `${baseId}:${season}:${episode}` : baseId;
  const eligible = addons.filter((addon) => addon.enabled && supportsResource(addon, 'subtitles', media.type, baseId));
  if (!eligible.length) return [];

  const hints = (stream?.behaviorHints || {}) as { videoHash?: string; videoSize?: number };
  const extras: string[] = [];
  if (hints.videoHash) extras.push(`videoHash=${encodeURIComponent(String(hints.videoHash))}`);
  if (hints.videoSize) extras.push(`videoSize=${encodeURIComponent(String(hints.videoSize))}`);
  const suffix = extras.length ? `/${extras.join('&')}` : '';

  const jobs = eligible.map(async (addon) => {
    const base = transportBase(addon.manifestUrl);
    base.pathname = `${base.pathname}/subtitles/${media.type}/${encodeURIComponent(resourceId)}${suffix}.json`;
    const data = await fetchJson<{ subtitles?: Array<Record<string, any>> }>(withManifestQuery(base, addon.manifestUrl), 12000);
    return (data.subtitles || [])
      .filter((sub) => typeof sub.url === 'string' && sub.url.startsWith('http'))
      .slice(0, 25)
      .map((sub, idx): StreamSubtitle => ({
        id: `${addon.manifest.id}:${sub.id || idx}`,
        url: sub.url,
        language: String(sub.lang || sub.language || 'und'),
        name: `${String(sub.lang || sub.language || 'Subtitles').toUpperCase()} · ${addon.manifest.name}`,
      }));
  });

  const settled = await Promise.allSettled(jobs);
  const collected: StreamSubtitle[] = [];
  const seenUrls = new Set<string>();
  settled.forEach((entry) => {
    if (entry.status !== 'fulfilled') return;
    entry.value.forEach((sub) => {
      if (seenUrls.has(sub.url)) return;
      seenUrls.add(sub.url);
      collected.push(sub);
    });
  });
  return collected;
}

export interface DiscoveredStremioAddon {
  transportUrl: string;
  manifest: StremioManifest;
}

/** Browse addons exposed by an installed `addon_catalog` resource. */
export async function fetchStremioAddonCatalogs(addons: InstalledAddon[]): Promise<DiscoveredStremioAddon[]> {
  const catalogAddons = addons.filter((addon) =>
    addon.enabled && addon.manifest.resources.some((resource) => resource.name === 'addon_catalog'),
  );
  if (!catalogAddons.length) return [];

  const jobs = catalogAddons.flatMap((addon) => {
    const entries = (addon.manifest as unknown as { addonCatalogs?: Array<{ type: string; id: string }> }).addonCatalogs || [
      { type: 'all', id: 'official' },
    ];
    return entries.slice(0, 3).map(async (cat) => {
      const base = transportBase(addon.manifestUrl);
      base.pathname = `${base.pathname}/addon_catalog/${encodeURIComponent(cat.type)}/${encodeURIComponent(cat.id)}.json`;
      const data = await fetchJson<{ addons?: Array<{ transportUrl?: string; manifest?: StremioManifest }> }>(
        withManifestQuery(base, addon.manifestUrl),
        12000,
      );
      return (data.addons || [])
        .filter((item): item is { transportUrl: string; manifest: StremioManifest } => Boolean(item?.transportUrl && item?.manifest?.name))
        .map((item) => ({ transportUrl: item.transportUrl, manifest: item.manifest }));
    });
  });

  const settled = await Promise.allSettled(jobs);
  const out: DiscoveredStremioAddon[] = [];
  const seen = new Set<string>();
  settled.forEach((res) => {
    if (res.status !== 'fulfilled') return;
    res.value.forEach((item) => {
      if (seen.has(item.transportUrl)) return;
      seen.add(item.transportUrl);
      out.push(item);
    });
  });
  return out;
}
