import { isAndroidApp, nativeFetchText } from './androidBridge';
import { MangaService } from './mangaService';

const PRIMARY_ORIGIN = 'https://www.sankavollerei.web.id';
const MIRROR_ORIGIN = 'https://www.sankavollerei.com';
const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env || {};
const isTestEnv = env.MODE === 'test' || Boolean(env.VITEST);
const forceProxy = env.VITE_API_PROXY === '1';
const isDevBrowser = Boolean(env.DEV) && !isTestEnv && !isAndroidApp();

export type SankaKind = 'anime' | 'comic';
export type ComicFeed = 'latest' | 'popular';

export const SANKA_COMIC_SOURCES = [
  { id: 'weebcentral', label: 'WeebCentral (English Manga)' },
  { id: 'bacakomik', label: 'BacaKomik' },
  { id: 'komiku', label: 'Komiku' },
  { id: 'komikstation', label: 'Komikstation' },
  { id: 'komikindo', label: 'Komikindo' },
  { id: 'komikcast', label: 'Komikcast' },
  { id: 'shinigami', label: 'Shinigami' },
  { id: 'kiryuu', label: 'Kiryuu' },
] as const;

export const SANKA_ANIME_SOURCES = [
  { id: 'otakudesu', label: 'Otakudesu' },
  { id: 'samehadaku', label: 'Samehadaku' },
  { id: 'donghua', label: 'Donghua' },
] as const;

export interface SankaTitle {
  id: string;
  slug: string;
  detailPath?: string;
  title: string;
  poster?: string;
  summary?: string;
  year?: string;
  status?: string;
  chapter?: string;
  rating?: string;
  comicType?: string;
  genres: string[];
  kind: SankaKind;
  source: string;
  sourceUrl?: string;
}

export interface SankaTitlesPage {
  items: SankaTitle[];
  hasMore: boolean;
  page: number;
}

export interface SankaChapter {
  id: string;
  slug: string;
  chapterPath?: string;
  title: string;
  date?: string;
}

export interface SankaMangaDetail {
  title: string;
  poster?: string;
  summary?: string;
  status?: string;
  author?: string;
  rating?: string;
  comicType?: string;
  genres: string[];
  chapters: SankaChapter[];
}

const RESPONSE_CACHE = new Map<string, { expiresAt: number; payload: unknown }>();
const ARTWORK_CACHE = new Map<string, string | null>();
const ARTWORK_INFLIGHT = new Map<string, Promise<string | null>>();
const FEED_TTL_MS = 5 * 60 * 1000;

let preferredBase: string | null = null;
const deadProxyBases = new Set<string>();
let activeArtworkLookups = 0;
const artworkWaitQueue: Array<() => void> = [];

export function clearSankaCache(): void {
  RESPONSE_CACHE.clear();
  ARTWORK_CACHE.clear();
  ARTWORK_INFLIGHT.clear();
  deadProxyBases.clear();
  preferredBase = null;
}

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
};

function safeUrl(value: unknown, upgradeHttp = false): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  if (raw.startsWith('data:') || raw.includes('lazy.jpg') || raw.includes('placeholder')) return undefined;
  const normalized = raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    const url = new URL(normalized, PRIMARY_ORIGIN);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (
      upgradeHttp &&
      url.protocol === 'http:' &&
      url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1'
    ) {
      url.protocol = 'https:';
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function recordImage(record: Record<string, unknown>): string | undefined {
  const images = record.images && typeof record.images === 'object' && !Array.isArray(record.images)
    ? record.images as Record<string, unknown>
    : {};
  const jpg = images.jpg && typeof images.jpg === 'object' ? images.jpg as Record<string, unknown> : {};
  const webp = images.webp && typeof images.webp === 'object' ? images.webp as Record<string, unknown> : {};
  const candidates = [
    record.poster, record.poster_url, record.posterUrl,
    record.cover, record.cover_portrait, record.coverPortrait, record.cover_image_url,
    record.cover_url, record.coverImage, record.cover_image,
    record.imageSrc, record.image_src,
    record.data_src, record.dataSrc, record.lazySrc, record.lazy_src,
    record.thumbnail, record.thumb, record.thumbnailUrl, record.thumbnail_url,
    record.image, record.image_url, record.imageUrl, record.img, record.gambar, record.photo,
    record.background_image, record.chara_image,
    images.poster, images.cover, images.thumbnail, images.image,
    webp.large_image_url, webp.image_url, jpg.large_image_url, jpg.image_url,
  ];
  for (const candidate of candidates) {
    const resolved = safeUrl(candidate, true);
    if (resolved) return resolved;
  }
  return undefined;
}

function cleanRoutePath(raw: string): string {
  try {
    const pathname = new URL(raw, PRIMARY_ORIGIN).pathname;
    return decodeURIComponent(pathname).replace(/^\/+|\/+$/g, '');
  } catch {
    return raw.replace(/^\/+|\/+$/g, '');
  }
}

function sourceSlug(record: Record<string, unknown>): string {
  const direct = firstString(
    record.slug, record.manga_slug, record.comic_slug, record.series_slug,
    record.anime_slug, record.chapter_slug, record.chapter_id, record.chapterId,
    record.manga_id, record.mangaId, record.comic_id, record.comicId, record.animeId,
  );
  if (direct && !direct.includes('/')) return direct.replace(/^\/+|\/+$/g, '');
  const route = direct || firstString(
    record.detailUrl, record.detail_url, record.manga_url, record.comic_url,
    record.chapter_url, record.endpoint, record.url, record.link, record.href,
  );
  const fallback = firstString(record.id) || 'unknown';
  if (!route) return fallback.replace(/^\/+|\/+$/g, '');
  try {
    const pathname = new URL(route, PRIMARY_ORIGIN).pathname;
    const segments = pathname.split('/').filter(Boolean);
    const lastSegment = segments.at(-1);
    return decodeURIComponent(lastSegment || fallback);
  } catch {
    return fallback.replace(/^\/+|\/+$/g, '');
  }
}

function extractDetailPath(record: Record<string, unknown>): string | undefined {
  const route = firstString(record.detailUrl, record.detail_url, record.manga_url, record.comic_url, record.link, record.href, record.url);
  if (!route) return undefined;
  const cleaned = cleanRoutePath(route)
    .replace(/^(?:comic\/(?:[^/]+\/)?(?:manga|detail|comic)|detail-komik|manga|komik|plus)\//i, '')
    .replace(/^\/+|\/+$/g, '');
  return cleaned || undefined;
}

function extractChapterPath(record: Record<string, unknown>): string | undefined {
  const route = firstString(
    record.chapter_url, record.link, record.url, record.href,
    record.chapter_slug, record.chapter_id, record.chapterId, record.slug, record.id,
  );
  if (!route) return undefined;
  const cleaned = cleanRoutePath(route)
    .replace(/^(?:comic\/(?:[^/]+\/)?(?:chapter|read)|comic\/chapter)\//i, '')
    .replace(/^\/+|\/+$/g, '');
  return cleaned || undefined;
}

function parseGenres(genresRaw: unknown): string[] {
  if (Array.isArray(genresRaw)) {
    return genresRaw
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        if (entry && typeof entry === 'object') {
          const obj = entry as Record<string, unknown>;
          return firstString(obj.name, obj.title, obj.genre_name, obj.genre_title, obj.label);
        }
        return undefined;
      })
      .filter((entry): entry is string => Boolean(entry));
  }
  if (typeof genresRaw === 'string') {
    return genresRaw.split(/[,|/]/).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function extractLatestChapter(record: Record<string, unknown>, kind: SankaKind): string | undefined {
  if (typeof record.chapter === 'string' || typeof record.chapter === 'number') {
    const val = firstString(record.chapter);
    if (val) return /^\d+(\.\d+)?$/.test(val) ? `Ch. ${val}` : val;
  }
  if (typeof record.latestChapter === 'string' || typeof record.latestChapter === 'number') {
    const val = firstString(record.latestChapter);
    if (val) return /^\d+(\.\d+)?$/.test(val) ? `Ch. ${val}` : val;
  }
  if (record.latestChapter && typeof record.latestChapter === 'object') {
    const nested = record.latestChapter as Record<string, unknown>;
    const val = firstString(nested.title, nested.chapter, nested.name);
    if (val) return val.replace(/\s+/g, ' ');
  }
  if (Array.isArray(record.chapters) && record.chapters.length > 0) {
    const firstCh = record.chapters[0];
    if (firstCh && typeof firstCh === 'object') {
      const chObj = firstCh as Record<string, unknown>;
      const val = firstString(chObj.title, chObj.chapter, chObj.chapter_title, chObj.name);
      if (val) return val.replace(/\s+/g, ' ');
    }
  }
  const fallback = firstString(
    record.latest_chapter, record.last_chapter, record.latest_chapter_number,
    record.episodes, record.episode, record.episodeCount, record.episode_count, record.current_episode,
  );
  if (!fallback) return undefined;
  if (kind === 'anime' && /^\d+$/.test(fallback)) {
    return fallback === '0' ? undefined : `Ep ${fallback}`;
  }
  if (kind === 'comic' && /^\d+(\.\d+)?$/.test(fallback)) {
    return `Ch. ${fallback}`;
  }
  return fallback.replace(/\s+/g, ' ');
}

function extractRating(record: Record<string, unknown>): string | undefined {
  if (typeof record.rating === 'string' || typeof record.rating === 'number') {
    const val = String(record.rating).trim();
    return val && val !== 'N/A' && val !== '-' && val !== '0' ? val : undefined;
  }
  if (record.rating && typeof record.rating === 'object') {
    const nested = record.rating as Record<string, unknown>;
    return firstString(nested.score, nested.value, nested.average);
  }
  return firstString(record.score, record.user_rate);
}

function extractComicType(record: Record<string, unknown>): string | undefined {
  if (typeof record.type === 'string') return record.type.trim() || undefined;
  if (Array.isArray(record.type) && record.type.length > 0 && typeof record.type[0] === 'object' && record.type[0]) {
    return firstString((record.type[0] as Record<string, unknown>).name, (record.type[0] as Record<string, unknown>).title);
  }
  if (Array.isArray(record.format) && record.format.length > 0 && typeof record.format[0] === 'object' && record.format[0]) {
    return firstString((record.format[0] as Record<string, unknown>).name, (record.format[0] as Record<string, unknown>).title);
  }
  return firstString(record.series_type, record.format);
}

function toTitle(record: Record<string, unknown>, kind: SankaKind, source: string, index: number): SankaTitle | null {
  const title = firstString(
    record.title, record.name, record.title_english, record.title_en,
    record.judul, record.manga_name, record.series_title, record.anime_title, record.donghua_title,
  );
  if (!title) return null;

  const chapterLabel = extractLatestChapter(record, kind);
  if (
    kind === 'comic' &&
    /\bapk\b/i.test(title) &&
    ((chapterLabel && /\bdownload\b/i.test(chapterLabel)) || String(record.detailUrl || '').includes('/apk'))
  ) {
    return null;
  }

  const genres = parseGenres(record.genres ?? record.genre ?? record.genre_list ?? record.genreList);
  const slug = sourceSlug(record);
  const fallbackSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `${title}-${index}`;
  const resolvedSlug = slug === 'unknown' ? fallbackSlug : slug;
  const year = firstString(record.year, record.release_year, record.releaseDate, record.release_date, record.released, record.release);
  const sourceUrl = safeUrl(firstString(record.url, record.link, record.href, record.manga_url, record.detailUrl));

  return {
    id: `${source}:${resolvedSlug}-${index}`,
    slug: resolvedSlug,
    detailPath: extractDetailPath(record),
    title,
    poster: recordImage(record),
    summary: firstString(record.synopsis, record.description, record.desc, record.summary, record.sinopsis),
    year: year?.match(/\b(19\d{2}|20\d{2})\b/)?.[0],
    status: firstString(record.status, record.state, record.airing_status, record.statusAnime),
    chapter: chapterLabel,
    rating: extractRating(record),
    comicType: extractComicType(record),
    genres,
    kind,
    source,
    sourceUrl,
  };
}

const ENVELOPE_KEYS = [
  'data', 'results', 'result', 'items', 'list',
  'komikList', 'comicList', 'mangaList', 'manga_list', 'comic_list', 'seriesList',
  'animeList', 'anime_list',
  'comics', 'trending', 'recommendations', 'recommended', 'recomen', 'top', 'top10', 'slider',
  'hotUpdates', 'projectUpdates', 'latestReleases', 'latestUpdates', 'latest_release', 'recent',
  'anime', 'comic', 'manga',
  'latest', 'terbaru', 'popular', 'populer', 'pustaka', 'unlimited',
  'ongoing', 'completed', 'ongoing_anime', 'complete_anime',
  'ongoing_donghua', 'completed_donghua',
  'update', 'home', 'detail', 'details',
];

const SKIP_CONTAINER_KEYS = new Set([
  'pagination', 'navigation', 'genres', 'genre_list', 'genreList', 'chapters',
  'chapter_list', 'chapterList', 'authors', 'artists', 'badges', 'server', 'streams',
]);

/** Sanka uses several response envelopes across providers; collect title-like records defensively. */
function collectRecords(payload: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown, depth: number) => {
    if (depth > 7 || !node || typeof node !== 'object' || seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = node as Record<string, unknown>;
    if (firstString(
      record.title, record.name, record.title_english, record.title_en,
      record.judul, record.manga_name, record.series_title, record.anime_title, record.donghua_title,
    )) {
      found.push(record);
      return;
    }
    let matchedEnvelope = false;
    for (const key of ENVELOPE_KEYS) {
      if (key in record && record[key] && typeof record[key] === 'object') {
        matchedEnvelope = true;
        visit(record[key], depth + 1);
      }
    }
    if (!matchedEnvelope && depth < 4) {
      for (const [key, value] of Object.entries(record)) {
        if (SKIP_CONTAINER_KEYS.has(key)) continue;
        if (value && typeof value === 'object') {
          visit(value, depth + 1);
        }
      }
    }
  };
  visit(payload, 0);
  return found;
}

export function mapSankaTitles(payload: unknown, kind: SankaKind, source = kind === 'comic' ? 'bacakomik' : 'otakudesu'): SankaTitle[] {
  const seen = new Set<string>();
  return collectRecords(payload).map((record, index) => toTitle(record, kind, source, index)).filter((item): item is SankaTitle => {
    if (!item) return false;
    const key = `${item.slug.toLocaleLowerCase()}|${item.title.toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractHasMore(payload: unknown, itemCount: number, page: number): boolean {
  if (itemCount === 0) return false;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const root = payload as Record<string, unknown>;
    const dataObj = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? root.data as Record<string, unknown>
      : {};
    const pag = (root.pagination && typeof root.pagination === 'object' ? root.pagination : dataObj.pagination) as Record<string, unknown> | undefined;

    for (const candidate of [root.hasNextPage, root.has_next_page, dataObj.hasNextPage, dataObj.has_next_page, pag?.hasNextPage, pag?.has_next_page]) {
      if (typeof candidate === 'boolean') return candidate;
    }

    const cur = Number(pag?.current_page ?? pag?.currentPage ?? root.currentPage ?? dataObj.currentPage ?? page);
    const total = Number(pag?.total_pages ?? pag?.totalPages ?? root.totalPages ?? dataObj.totalPages ?? 0);
    if (Number.isFinite(cur) && Number.isFinite(total) && total > 0) {
      return cur < total;
    }

    if (pag && ('nextPage' in pag || 'next_page' in pag)) {
      return Boolean(pag.nextPage ?? pag.next_page);
    }
  }
  return itemCount >= 8;
}

function candidateBases(): string[] {
  if (isTestEnv) {
    return forceProxy ? ['/sanka'] : [PRIMARY_ORIGIN];
  }
  let bases: string[];
  if (forceProxy) {
    bases = ['/sanka', '/sanka-mirror', PRIMARY_ORIGIN, MIRROR_ORIGIN];
  } else if (isAndroidApp()) {
    bases = [PRIMARY_ORIGIN, MIRROR_ORIGIN];
  } else if (isDevBrowser) {
    bases = [PRIMARY_ORIGIN, MIRROR_ORIGIN, '/sanka', '/sanka-mirror'];
  } else {
    bases = [PRIMARY_ORIGIN, MIRROR_ORIGIN, '/sanka'];
  }
  if (!forceProxy && deadProxyBases.size > 0) {
    bases = bases.filter((b) => !deadProxyBases.has(b));
  }
  if (preferredBase && bases.includes(preferredBase)) {
    return [preferredBase, ...bases.filter((b) => b !== preferredBase)];
  }
  return bases;
}

function lastErrPrefer(prev: Error | null, next: Error, base: string): Error {
  if (prev && base.startsWith('/') && /returned 404|returned 502|unreadable/i.test(next.message)) {
    return prev;
  }
  return next;
}

async function fetchJson(route: string, signal?: AbortSignal, bypassCache = false): Promise<unknown> {
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  const cleanRoute = route.replace(/^\/+/, '');

  if (!isTestEnv && !bypassCache) {
    const cached = RESPONSE_CACHE.get(cleanRoute);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.payload;
    }
  }

  const bases = candidateBases();
  let lastError: Error | null = null;

  for (const base of bases) {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    const url = `${base}/${cleanRoute}`;
    try {
      let response = await nativeFetchText(url, {
        headers: { Accept: 'application/json' },
        timeoutMs: 14000,
      });

      if (!isTestEnv && response.status === 429) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1600));
        if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
        response = await nativeFetchText(url, {
          headers: { Accept: 'application/json' },
          timeoutMs: 14000,
        });
      }

      if (!response.ok) {
        if (base.startsWith('/') && (response.status === 500 || response.status === 502 || response.status === 504)) {
          deadProxyBases.add(base);
        }
        const statusErr = new Error(`Sanka API returned ${response.status}.`);
        lastError = lastErrPrefer(lastError, statusErr, base);
        if (response.status === 404 && !base.startsWith('/')) break;
        continue;
      }

      const trimmed = response.data.trim();
      if (!trimmed || trimmed.startsWith('<!') || trimmed.startsWith('<html')) {
        lastError = lastError || new Error('Sanka API returned an unreadable response.');
        continue;
      }

      const parsed = JSON.parse(trimmed) as unknown;
      if (!isTestEnv) {
        preferredBase = base;
        RESPONSE_CACHE.set(cleanRoute, { expiresAt: Date.now() + FEED_TTL_MS, payload: parsed });
      }
      return parsed;
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') {
        if (signal?.aborted) throw error;
        lastError = lastErrPrefer(lastError, new Error('Sanka API timed out.'), base);
        continue;
      }
      const normalized = error instanceof SyntaxError
        ? new Error('Sanka API returned an unreadable response.')
        : error instanceof Error
          ? error
          : new Error('Could not reach Sanka API.');
      lastError = lastErrPrefer(lastError, normalized, base);
    }
  }

  throw lastError || new Error('Could not reach Sanka API.');
}

function buildTitleRoutes(kind: SankaKind, query: string, source: string, feed: ComicFeed, page = 1): string[] {
  const q = encodeURIComponent(query);
  const s = encodeURIComponent(source);
  const p = Math.max(1, Math.floor(page));

  if (kind === 'anime') {
    if (query) {
      if (source === 'donghua') {
        return p === 1
          ? [`anime/donghua/search/${q}`, `anime/search/${q}`]
          : [`anime/donghua/search/${q}/${p}`, `anime/donghua/search/${q}?page=${p}`];
      }
      if (source === 'samehadaku') {
        return p === 1
          ? [`anime/samehadaku/search/${q}`, `anime/samehadaku/search?q=${q}`, `anime/search/${q}`]
          : [`anime/samehadaku/search?q=${q}&page=${p}`, `anime/samehadaku/search/${q}?page=${p}`];
      }
      return p === 1
        ? [`anime/otakudesu/search/${q}`, `anime/search/${q}`, `anime/samehadaku/search?q=${q}`]
        : [`anime/search/${q}?page=${p}`, `anime/otakudesu/search/${q}?page=${p}`];
    }

    if (source === 'donghua') {
      return p === 1
        ? ['anime/donghua/ongoing/1', 'anime/donghua/home/1']
        : [`anime/donghua/ongoing/${p}`, `anime/donghua/completed/${p}`];
    }
    if (source === 'samehadaku') {
      return p === 1
        ? ['anime/samehadaku/home', 'anime/samehadaku/ongoing?page=1']
        : [`anime/samehadaku/ongoing?page=${p}`, `anime/samehadaku/completed?page=${p}`, `anime/samehadaku/anime?page=${p}`];
    }
    // Otakudesu default
    return p === 1
      ? ['anime/home', 'anime/ongoing-anime?page=1', 'anime/samehadaku/home']
      : [`anime/ongoing-anime?page=${p}`, `anime/complete-anime/${p}`, `anime/complete-anime?page=${p}`];
  }

  // Comic search routes
  if (query) {
    if (source === 'bacakomik') {
      return [`comic/bacakomik/search/${q}?page=${p}`, ...(p === 1 ? [`comic/bacakomik/search/${q}`] : [])];
    }
    if (source === 'komiku') {
      return p === 1
        ? [`comic/komiku/search/${q}`, `comic/search?q=${q}`, `comic/search/${q}`]
        : [`comic/search?q=${q}&page=${p}`, `comic/komiku/search/${q}?page=${p}`];
    }
    if (source === 'komikstation') {
      return p === 1
        ? [`comic/komikstation/search/${q}`, `comic/komikstation/search?q=${q}`]
        : [`comic/komikstation/search/${q}?page=${p}`, `comic/komikstation/search/${q}/${p}`];
    }
    if (source === 'komikindo' || source === 'komikcast') {
      return p === 1
        ? [`comic/${s}/search/${q}/1`, `comic/${s}/search/${q}`, `comic/${s}/search?q=${q}`]
        : [`comic/${s}/search/${q}/${p}`, `comic/${s}/search/${q}?page=${p}`];
    }
    if (source === 'shinigami') {
      return p === 1
        ? [`comic/shinigami/search/${q}`, `comic/shinigami/search?q=${q}`]
        : [`comic/shinigami/search/${q}?page=${p}`, `comic/shinigami/list?q=${q}&page=${p}`];
    }
    return p === 1
      ? [`comic/${s}/search/${q}`, `comic/${s}/search/${q}/1`, `comic/${s}/search?q=${q}`]
      : [`comic/${s}/search/${q}/${p}`, `comic/${s}/search/${q}?page=${p}`, `comic/${s}/search?q=${q}&page=${p}`];
  }

  // Comic Popular feed
  if (feed === 'popular') {
    if (source === 'bacakomik') {
      return p === 1
        ? ['comic/bacakomik/populer', 'comic/bacakomik/top', 'comic/bacakomik/popular']
        : [`comic/bacakomik/populer?page=${p}`, `comic/bacakomik/komikberwarna/${p}`, `comic/bacakomik/latest?page=${p}`];
    }
    if (source === 'komiku') {
      return p === 1
        ? ['comic/trending', 'comic/populer', 'comic/recommendations', 'comic/pustaka/1']
        : [`comic/pustaka/${p}`, `comic/berwarna/${p}`, `comic/populer?page=${p}`];
    }
    if (source === 'komikstation') {
      return [`comic/komikstation/popular?page=${p}`, `comic/komikstation/list?page=${p}`, ...(p === 1 ? ['comic/komikstation/home'] : [])];
    }
    if (source === 'komikindo') {
      return [`comic/komikindo/popular/${p}`, `comic/komikindo/library?page=${p}`, `comic/komikindo/latest/${p}`];
    }
    if (source === 'komikcast') {
      return p === 1
        ? ['comic/komikcast/popular/1', 'comic/komikcast/popular', 'comic/komikcast/home']
        : [`comic/komikcast/popular/${p}`, `comic/komikcast/popular?page=${p}`, `comic/komikcast/latest/${p}`, `comic/komikcast/list?page=${p}`];
    }
    if (source === 'shinigami') {
      return [`comic/shinigami/popular?page=${p}&page_size=24`, ...(p === 1 ? ['comic/shinigami/home'] : [`comic/shinigami/list?format=manhwa&page=${p}`])];
    }
    return p === 1
      ? [`comic/${s}/popular`, `comic/${s}/popular/1`, `comic/${s}/populer`, `comic/${s}/home`, `comic/${s}/top`]
      : [`comic/${s}/popular/${p}`, `comic/${s}/popular?page=${p}`, `comic/${s}/populer?page=${p}`, `comic/${s}/list?page=${p}`];
  }

  // Comic Latest feed
  if (source === 'bacakomik') {
    return p === 1
      ? ['comic/bacakomik/latest', 'comic/bacakomik/recomen', 'comic/bacakomik/komikberwarna/1']
      : [`comic/bacakomik/latest?page=${p}`, `comic/bacakomik/komikberwarna/${p}`, `comic/bacakomik/only/manhwa?page=${p}`];
  }
  if (source === 'komiku') {
    return p === 1
      ? ['comic/homepage', 'comic/terbaru', 'comic/pustaka/1', 'comic/berwarna/1', 'comic/unlimited']
      : [`comic/pustaka/${p}`, `comic/berwarna/${p}`, `comic/terbaru?page=${p}`];
  }
  if (source === 'komikstation') {
    return p === 1
      ? ['comic/komikstation/home', 'comic/komikstation/list', 'comic/komikstation/popular?page=1']
      : [`comic/komikstation/list?page=${p}`, `comic/komikstation/popular?page=${p}`];
  }
  if (source === 'komikindo') {
    return [`comic/komikindo/latest/${p}`, `comic/komikindo/library?page=${p}`, ...(p === 1 ? ['comic/komikindo/home', 'comic/komikindo/latest'] : [])];
  }
  if (source === 'komikcast') {
    return p === 1
      ? ['comic/komikcast/home', 'comic/komikcast/latest/1', 'comic/komikcast/latest', 'comic/komikcast/list?page=1']
      : [`comic/komikcast/latest/${p}`, `comic/komikcast/list?page=${p}`, `comic/komikcast/latest?page=${p}`, `comic/komikcast/popular/${p}`];
  }
  if (source === 'shinigami') {
    return p === 1
      ? ['comic/shinigami/home', 'comic/shinigami/popular?page=1&page_size=24', 'comic/shinigami/list?format=manhwa&page=1']
      : [`comic/shinigami/list?format=manhwa&page=${p}`, `comic/shinigami/popular?page=${p}&page_size=24`, `comic/shinigami/list?page=${p}`];
  }
  return p === 1
    ? [`comic/${s}/home`, `comic/${s}/latest`, `comic/${s}/latest/1`, `comic/${s}/terbaru`, `comic/${s}/list`]
    : [`comic/${s}/latest/${p}`, `comic/${s}/latest?page=${p}`, `comic/${s}/list?page=${p}`, `comic/${s}/popular?page=${p}`];
}

export async function fetchSankaTitlesPage(
  kind: SankaKind,
  options: {
    query?: string;
    source?: string;
    feed?: ComicFeed;
    page?: number;
    signal?: AbortSignal;
    bypassCache?: boolean;
  } = {},
): Promise<SankaTitlesPage> {
  const normalizedQuery = (options.query || '').trim();
  const source = options.source || (kind === 'comic' ? 'bacakomik' : 'otakudesu');
  const feed = options.feed || 'latest';
  const page = Math.max(1, Math.floor(options.page || 1));

  if (source === 'weebcentral') {
    try {
      const mangaList = normalizedQuery
        ? await MangaService.searchManga(normalizedQuery, page)
        : await MangaService.getManga(page);
      const items: SankaTitle[] = mangaList.map((m) => ({
        id: `weebcentral:${m.id}`,
        slug: m.id,
        detailPath: `/series/${m.id}`,
        title: m.title,
        poster: m.coverNormal || m.coverSmall,
        kind: 'comic',
        source: 'weebcentral',
        sourceUrl: `https://weebcentral.com/series/${m.id}`,
        comicType: m.type,
        genres: m.tags || ['Manga'],
      }));
      return {
        items,
        hasMore: mangaList.length >= 30,
        page,
      };
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') throw e;
      return { items: [], hasMore: false, page };
    }
  }

  const routes = buildTitleRoutes(kind, normalizedQuery, source, feed, page);

  let lastError: unknown = null;
  let hadValidEmptyResponse = false;

  for (const route of routes) {
    if (options.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    try {
      const payload = await fetchJson(route, options.signal, options.bypassCache);
      if (options.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      hadValidEmptyResponse = true;
      const items = mapSankaTitles(payload, kind, source);
      if (items.length > 0) {
        return {
          items,
          hasMore: extractHasMore(payload, items.length, page),
          page,
        };
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw error;
      lastError = error;
    }
  }

  if (hadValidEmptyResponse || page > 1) {
    return { items: [], hasMore: false, page };
  }
  throw lastError instanceof Error ? lastError : new Error('Could not load titles from Sanka API.');
}

export async function fetchSankaTitles(
  kind: SankaKind,
  query = '',
  source = kind === 'comic' ? 'bacakomik' : 'otakudesu',
  feed: ComicFeed = 'latest',
  signal?: AbortSignal,
  options: { bypassCache?: boolean; page?: number } = {},
): Promise<SankaTitle[]> {
  const page = options.page || 1;
  const normalizedQuery = query.trim();

  if (source === 'weebcentral') {
    const mangaList = normalizedQuery
      ? await MangaService.searchManga(normalizedQuery, page)
      : await MangaService.getManga(page);
    return mangaList.map((m) => ({
      id: `weebcentral:${m.id}`,
      slug: m.id,
      detailPath: `/series/${m.id}`,
      title: m.title,
      poster: m.coverNormal || m.coverSmall,
      kind: 'comic',
      source: 'weebcentral',
      sourceUrl: `https://weebcentral.com/series/${m.id}`,
      comicType: m.type,
      genres: m.tags || ['Manga'],
    }));
  }

  const routes = buildTitleRoutes(kind, normalizedQuery, source, feed, page);
  let lastError: unknown = null;
  let hadValidEmptyResponse = false;

  for (const route of routes) {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    try {
      const payload = await fetchJson(route, signal, options.bypassCache);
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      hadValidEmptyResponse = true;
      const items = mapSankaTitles(payload, kind, source);
      if (items.length > 0) return items;
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw error;
      lastError = error;
    }
  }

  if (hadValidEmptyResponse) return [];
  throw lastError instanceof Error ? lastError : new Error('Could not load titles from Sanka API.');
}

function findArrayByKeys(payload: unknown, keys: string[], depth = 0): unknown[] | undefined {
  if (depth > 7 || !payload || typeof payload !== 'object') return undefined;
  if (Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  for (const key of ['detail', 'details', 'data', 'result', 'results', 'manga', 'comic']) {
    const found = findArrayByKeys(record[key], keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function unwrapDetailRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const root = payload as Record<string, unknown>;
  for (const key of ['detail', 'details', 'data', 'result', 'manga', 'comic']) {
    const nested = root[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const candidate = nested as Record<string, unknown>;
      if (
        firstString(candidate.title, candidate.name, candidate.manga_name, candidate.synopsis, candidate.description, candidate.sinopsis) ||
        Array.isArray(candidate.chapters)
      ) {
        return candidate;
      }
    }
  }
  const records = collectRecords(payload);
  return records[0] || root;
}

function chapterLabelFromSlug(slug: string): string | undefined {
  const match = slug.match(/(?:^|-)chapter-(\d+(?:[.-]\d+)?)/i) || slug.match(/(?:^|-)ch-(\d+(?:[.-]\d+)?)/i);
  return match ? `Chapter ${match[1].replace('-', '.')}` : undefined;
}

function mapChapterEntries(entries: unknown[] | undefined, source: string): SankaChapter[] {
  return (entries || []).map((entry, index): SankaChapter | null => {
    if (typeof entry === 'string' || typeof entry === 'number') {
      const value = String(entry);
      const slug = sourceSlug({ slug: value });
      return { id: `${source}:${slug}-${index}`, slug, chapterPath: extractChapterPath({ slug: value }), title: value };
    }
    if (!entry || typeof entry !== 'object') return null;
    const chapter = entry as Record<string, unknown>;
    const slug = sourceSlug(chapter);
    const chapterPath = extractChapterPath(chapter);
    const rawTitle = firstString(
      chapter.title, chapter.chapter, chapter.chapter_title,
      chapter.name, chapter.chapter_number, chapter.number,
    );
    const cleanRaw = rawTitle?.replace(/\s+/g, ' ').trim();
    const title = cleanRaw
      ? (/^\d+(\.\d+)?$/.test(cleanRaw) ? `Chapter ${cleanRaw}` : cleanRaw)
      : chapterLabelFromSlug(slug) || `Chapter ${index + 1}`;
    const date = firstString(chapter.date, chapter.release_date, chapter.releaseTime, chapter.upload_date, chapter.time_ago, chapter.time, chapter.updated_at);
    return { id: `${source}:${slug}-${index}`, slug, chapterPath, title, date };
  }).filter((chapter): chapter is SankaChapter => Boolean(chapter && chapter.slug && chapter.slug !== 'unknown'));
}

export function mapSankaMangaDetail(payload: unknown, source: string, fallbackTitle = 'Manga'): SankaMangaDetail {
  const record = unwrapDetailRecord(payload);
  const subDetail = record.detail && typeof record.detail === 'object' && !Array.isArray(record.detail)
    ? record.detail as Record<string, unknown>
    : {};
  const chapterEntries = findArrayByKeys(payload, ['chapters', 'chapter_list', 'chapterList', 'list_chapter', 'chapter']);
  const chapters = mapChapterEntries(chapterEntries, source);

  const authorFromArray = Array.isArray(record.authors) && record.authors[0] && typeof record.authors[0] === 'object'
    ? firstString((record.authors[0] as Record<string, unknown>).name, (record.authors[0] as Record<string, unknown>).title)
    : undefined;

  const genres = parseGenres(record.genres ?? record.genre ?? record.genre_list ?? subDetail.genres);
  return {
    title: firstString(record.title, record.name, record.manga_name, record.judul) || fallbackTitle,
    poster: recordImage(record),
    summary: firstString(record.synopsis, record.description, record.desc, record.summary, record.sinopsis),
    status: firstString(record.status, record.state, subDetail.status),
    author: firstString(record.author, record.creator, record.pengarang, record.artist, subDetail.author, authorFromArray),
    rating: extractRating(record),
    comicType: extractComicType(record) || firstString(subDetail.type),
    genres,
    chapters,
  };
}

function encodePathSegments(pathValue: string): string {
  return pathValue.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/');
}

function buildDetailRoutes(source: string, slug: string, detailPath?: string): string[] {
  const s = encodeURIComponent(source);
  const encodedSlug = encodeURIComponent(slug);
  const encodedDetailPath = detailPath ? encodePathSegments(detailPath) : '';

  if (source === 'bacakomik') {
    return [`comic/bacakomik/detail/${encodedSlug}`, `comic/bacakomik/manga/${encodedSlug}`];
  }
  if (source === 'komiku') {
    const routes = [
      `comic/komiku/manga/${encodedSlug}`,
      ...(encodedDetailPath ? [`comic/comic/${encodedDetailPath}`] : []),
      `comic/comic/${encodedSlug}`,
      `comic/komiku/detail/${encodedSlug}`,
      `comic/manga/${encodedSlug}`,
    ];
    return [...new Set(routes)];
  }
  if (source === 'komikindo' || source === 'komikcast' || source === 'shinigami') {
    return [`comic/${s}/detail/${encodedSlug}`, `comic/${s}/manga/${encodedSlug}`, `comic/${s}/comic/${encodedSlug}`];
  }
  return [`comic/${s}/manga/${encodedSlug}`, `comic/${s}/detail/${encodedSlug}`, `comic/${s}/comic/${encodedSlug}`];
}

export async function fetchSankaMangaDetail(
  source: string,
  slug: string,
  signal?: AbortSignal,
  detailPath?: string,
): Promise<SankaMangaDetail> {
  if (source === 'weebcentral') {
    const [detail, chapters] = await Promise.all([
      MangaService.getSeriesDetail(slug),
      MangaService.getChapters(slug),
    ]);
    return {
      title: detail.title,
      poster: detail.coverNormal || detail.coverSmall,
      summary: detail.synopsis || '',
      genres: detail.tags || ['Manga'],
      author: detail.author || '',
      status: detail.status || 'Ongoing',
      chapters: chapters.map((c) => ({
        id: `weebcentral:${c.id}`,
        slug: c.id,
        chapterPath: `/chapters/${c.id}`,
        title: c.name,
      })),
    };
  }

  const routes = buildDetailRoutes(source, slug, detailPath);
  let lastError: unknown = null;
  let fallbackDetail: SankaMangaDetail | null = null;

  for (const route of routes) {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    try {
      const payload = await fetchJson(route, signal);
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      const mapped = mapSankaMangaDetail(payload, source);
      if (mapped.chapters.length > 0) return mapped;
      if (!fallbackDetail) fallbackDetail = mapped;
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw error;
      lastError = error;
    }
  }

  // Shinigami serves chapters on a dedicated `/comic/shinigami/chapters/:id` endpoint
  if (fallbackDetail && source === 'shinigami' && fallbackDetail.chapters.length === 0) {
    try {
      const chPayload = await fetchJson(`comic/shinigami/chapters/${encodeURIComponent(slug)}?page=1&page_size=500`, signal);
      const chEntries = findArrayByKeys(chPayload, ['chapters', 'data', 'results']);
      const extraChapters = mapChapterEntries(chEntries, source);
      if (extraChapters.length > 0) {
        return { ...fallbackDetail, chapters: extraChapters };
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw error;
    }
  }

  if (fallbackDetail) return fallbackDetail;
  throw lastError instanceof Error ? lastError : new Error('Could not load manga details.');
}

function collectImageUrls(payload: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const addUrl = (raw: unknown, requireImageExt: boolean) => {
    const url = safeUrl(raw, true);
    if (!url) return;
    if (!requireImageExt || /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(url)) {
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  };

  const visit = (node: unknown, depth: number, inImageList = false) => {
    if (depth > 8 || node == null) return;
    if (typeof node === 'string') {
      addUrl(node, !inImageList);
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry, depth + 1, inImageList));
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (/^(navigation|chapters|chapter_list|chapterList|recommendations|genres)$/i.test(key)) continue;
      const imageListKey = /^(images?|pages?|image_?urls?|image_?list|chapter_?images?|page_?list|gambar|slides)$/i.test(key);
      if (typeof value === 'string') {
        if (inImageList && /^(image|img|src|url|link|page|image_url|page_url)$/i.test(key)) {
          addUrl(value, false);
        } else if (/^(image_url|page_url)$/i.test(key)) {
          addUrl(value, false);
        }
      } else if (imageListKey || ['data', 'result', 'results', 'chapter', 'detail'].includes(key.toLowerCase())) {
        visit(value, depth + 1, imageListKey || inImageList);
      }
    }
  };
  visit(payload, 0);
  return urls;
}

function buildChapterRoutes(source: string, slug: string, chapterPath?: string): string[] {
  const s = encodeURIComponent(source);
  const encodedSlug = encodeURIComponent(slug);
  const encodedPath = chapterPath ? encodePathSegments(chapterPath) : '';

  if (source === 'shinigami') {
    return [
      `comic/shinigami/read/${encodedSlug}`,
      `comic/shinigami/chapter/${encodedSlug}`,
      ...(encodedPath && encodedPath !== encodedSlug ? [`comic/shinigami/read/${encodedPath}`] : []),
    ];
  }
  if (source === 'komiku') {
    const routes = [
      `comic/komiku/chapter/${encodedSlug}`,
      ...(encodedPath ? [`comic/chapter/${encodedPath}`] : []),
      `comic/chapter/${encodedSlug}`,
      `comic/chapter/ch/${encodedSlug}`,
    ];
    return [...new Set(routes)];
  }
  return [
    `comic/${s}/chapter/${encodedSlug}`,
    `comic/${s}/read/${encodedSlug}`,
    ...(encodedPath && encodedPath !== encodedSlug ? [`comic/${s}/chapter/${encodedPath}`] : []),
    `comic/chapter/${encodedSlug}`,
  ];
}

export async function fetchSankaChapterImages(
  source: string,
  slug: string,
  signal?: AbortSignal,
  chapterPath?: string,
): Promise<string[]> {
  if (source === 'weebcentral') {
    const images = await MangaService.getChapterImages(slug);
    if (images.length > 0) return images;
  }

  const routes = buildChapterRoutes(source, slug, chapterPath);
  let lastError: unknown = null;

  for (const route of routes) {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    try {
      const payload = await fetchJson(route, signal);
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      const images = collectImageUrls(payload);
      if (images.length > 0) return images;
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw error;
      lastError = error;
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error('This chapter did not include any readable page images.');
}

function acquireArtworkSlot(): Promise<void> {
  if (activeArtworkLookups < 4) {
    activeArtworkLookups += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    artworkWaitQueue.push(() => {
      activeArtworkLookups += 1;
      resolve();
    });
  });
}

function releaseArtworkSlot(): void {
  activeArtworkLookups = Math.max(0, activeArtworkLookups - 1);
  const next = artworkWaitQueue.shift();
  if (next) next();
}

/**
 * Resolves a clean cover poster from Kitsu / Jikan public CORS APIs when an
 * upstream scraper omits its cover or its image domain is blocked on the user's network.
 */
export async function resolveArtworkFallback(title: string, kind: SankaKind): Promise<string | null> {
  if (isTestEnv) return null;
  const clean = title
    .replace(/\b(?:bahasa\s+indonesia|sub\s+indo|subtitle\s+indonesia|komik|manga|manhwa|manhua)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;

  const key = `${kind}:${clean.toLowerCase()}`;
  if (ARTWORK_CACHE.has(key)) {
    return ARTWORK_CACHE.get(key) ?? null;
  }
  const existing = ARTWORK_INFLIGHT.get(key);
  if (existing) return existing;

  const job = (async (): Promise<string | null> => {
    await acquireArtworkSlot();
    try {
      const kitsuType = kind === 'comic' ? 'manga' : 'anime';
      const kitsuRes = await nativeFetchText(
        `https://kitsu.io/api/edge/${kitsuType}?filter[text]=${encodeURIComponent(clean)}&page[limit]=1`,
        { headers: { Accept: 'application/vnd.api+json, application/json' }, timeoutMs: 7000 },
      );
      if (kitsuRes.ok) {
        const parsed = JSON.parse(kitsuRes.data) as {
          data?: Array<{ attributes?: { posterImage?: Record<string, string | undefined> } }>;
        };
        const poster = parsed.data?.[0]?.attributes?.posterImage;
        const url = safeUrl(poster?.medium || poster?.large || poster?.small || poster?.original, true);
        if (url) {
          ARTWORK_CACHE.set(key, url);
          return url;
        }
      }
    } catch {
      // Fall through to Jikan
    }

    try {
      const jikanType = kind === 'comic' ? 'manga' : 'anime';
      const jikanRes = await nativeFetchText(
        `https://api.jikan.moe/v4/${jikanType}?q=${encodeURIComponent(clean)}&limit=1&sfw=true`,
        { headers: { Accept: 'application/json' }, timeoutMs: 7000 },
      );
      if (jikanRes.ok) {
        const parsed = JSON.parse(jikanRes.data) as {
          data?: Array<{ images?: { webp?: { large_image_url?: string; image_url?: string }; jpg?: { large_image_url?: string; image_url?: string } } }>;
        };
        const img = parsed.data?.[0]?.images;
        const url = safeUrl(img?.webp?.large_image_url || img?.webp?.image_url || img?.jpg?.large_image_url || img?.jpg?.image_url, true);
        if (url) {
          ARTWORK_CACHE.set(key, url);
          return url;
        }
      }
    } catch {
      // Ignore fallback lookup errors
    } finally {
      releaseArtworkSlot();
      ARTWORK_INFLIGHT.delete(key);
    }

    ARTWORK_CACHE.set(key, null);
    return null;
  })();

  ARTWORK_INFLIGHT.set(key, job);
  return job;
}

export const SANKA_API_ORIGIN = PRIMARY_ORIGIN;
