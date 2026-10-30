import type {
  InstalledAddon, MediaItem, SourceError, StremioCatalog, StremioManifest,
  StremioResource, StreamResult,
} from '../types';

const timeoutFetch = async (url: string, timeout = 15000) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
};

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

const normalizeResources = (manifest: StremioManifest): StremioResource[] =>
  (manifest.resources || []).map((resource) => {
    if (typeof resource === 'string') {
      return { name: resource, types: manifest.types || [] };
    }
    return { ...resource, types: resource.types || manifest.types || [] };
  });

export async function fetchStremioManifest(rawUrl: string): Promise<InstalledAddon> {
  const manifestUrl = normalizeStremioUrl(rawUrl);
  const response = await timeoutFetch(manifestUrl);
  if (!response.ok) throw new Error(`Addon returned HTTP ${response.status}.`);
  const manifest = await response.json() as StremioManifest;
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
    const matchesType = resource.types.includes(type) || (type === 'series' && resource.types.includes('tv'));
    const matchesPrefix = !resource.idPrefixes?.length || resource.idPrefixes.some((prefix) => id.startsWith(prefix));
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
  const response = await timeoutFetch(withManifestQuery(base, addon.manifestUrl));
  if (!response.ok) throw new Error(`${addon.manifest.name} catalog returned HTTP ${response.status}.`);
  const data = await response.json();
  return (data.metas || data.metasDetailed || []).map((meta: Record<string, any>) => mapStremioMeta(meta, addon, catalog.type));
}

export async function fetchStremioMeta(addon: InstalledAddon, media: MediaItem): Promise<MediaItem> {
  if (!supportsResource(addon, 'meta', media.type, media.id)) return media;
  const base = transportBase(addon.manifestUrl);
  base.pathname = `${base.pathname}/meta/${media.type}/${encodeURIComponent(media.id)}.json`;
  const response = await timeoutFetch(withManifestQuery(base, addon.manifestUrl));
  if (!response.ok) throw new Error(`${addon.manifest.name} metadata returned HTTP ${response.status}.`);
  const data = await response.json();
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
  const response = await timeoutFetch(withManifestQuery(base, addon.manifestUrl), 20000);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return (data.streams || []).map((stream: Record<string, any>, index: number) => {
    const url = typeof stream.url === 'string' ? stream.url : stream.url?.url || stream.externalUrl || (stream.infoHash ? `magnet:?xt=urn:btih:${stream.infoHash}` : '');
    return {
      id: `${addon.manifest.id}-${index}-${stream.infoHash || stream.ytId || url}`,
      title: stream.title || stream.name || stream.description || 'Stream',
      url,
      sourceName: addon.manifest.name,
      sourceType: 'stremio' as const,
      quality: stream.quality || stream.behaviorHints?.videoQuality,
      provider: stream.name,
      infoHash: stream.infoHash,
      externalUrl: stream.externalUrl,
      ytId: stream.ytId,
      headers: stream.behaviorHints?.proxyHeaders?.request || stream.headers,
      subtitles: stream.subtitles,
      behaviorHints: stream.behaviorHints,
    };
  }).filter((stream: StreamResult) => stream.url || stream.ytId);
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
