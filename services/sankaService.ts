import { nativeFetchText } from './androidBridge';

const ORIGIN = 'https://www.sankavollerei.web.id';
const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env || {};
const BASE = env.VITE_API_PROXY === '1' ? '/sanka' : ORIGIN;

export type SankaKind = 'anime' | 'comic';
export type ComicFeed = 'latest' | 'popular';

export const SANKA_COMIC_SOURCES = [
  { id: 'komiku', label: 'Komiku' },
  { id: 'kiryuu', label: 'Kiryuu' },
  { id: 'komikindo', label: 'Komikindo' },
  { id: 'komikcast', label: 'Komikcast' },
  { id: 'bacakomik', label: 'BacaKomik' },
  { id: 'shinigami', label: 'Shinigami' },
] as const;

export interface SankaTitle {
  id: string;
  slug: string;
  title: string;
  poster?: string;
  summary?: string;
  year?: string;
  status?: string;
  genres: string[];
  kind: SankaKind;
  source: string;
  sourceUrl?: string;
}

export interface SankaChapter {
  id: string;
  slug: string;
  title: string;
}

export interface SankaMangaDetail {
  title: string;
  poster?: string;
  summary?: string;
  status?: string;
  genres: string[];
  chapters: SankaChapter[];
}

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
};

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim(), ORIGIN);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function recordImage(record: Record<string, unknown>): string | undefined {
  const images = record.images && typeof record.images === 'object' && !Array.isArray(record.images)
    ? record.images as Record<string, unknown>
    : {};
  return safeUrl(firstString(
    record.poster, record.poster_url, record.posterUrl, record.cover, record.cover_url,
    record.coverImage, record.thumbnail, record.image, record.image_url, record.img,
    record.thumb, record.photo, images.poster, images.cover, images.thumbnail, images.image,
  ));
}

function sourceSlug(record: Record<string, unknown>): string {
  const direct = firstString(record.slug, record.manga_slug, record.anime_slug, record.chapter_slug);
  if (direct) return direct.replace(/^\/+|\/+$/g, '');
  const route = firstString(record.manga_url, record.url, record.link, record.href);
  const fallback = firstString(record.id) || 'unknown';
  try {
    const pathname = new URL(route || fallback, ORIGIN).pathname;
    const lastSegment = pathname.split('/').filter(Boolean).at(-1);
    return decodeURIComponent(lastSegment || fallback);
  } catch {
    return fallback.replace(/^\/+|\/+$/g, '');
  }
}

function toTitle(record: Record<string, unknown>, kind: SankaKind, source: string, index: number): SankaTitle | null {
  const title = firstString(record.title, record.name, record.title_english, record.title_en, record.judul, record.manga_name, record.anime_title);
  if (!title) return null;
  const genresRaw = record.genres ?? record.genre;
  const genres = Array.isArray(genresRaw)
    ? genresRaw.map((entry) => typeof entry === 'string' ? entry : firstString((entry as Record<string, unknown>)?.name)).filter((entry): entry is string => Boolean(entry))
    : typeof genresRaw === 'string' ? genresRaw.split(/[,|]/).map((entry) => entry.trim()).filter(Boolean) : [];
  const slug = sourceSlug(record);
  const year = firstString(record.year, record.release_year, record.releaseDate, record.release_date, record.released);
  const sourceUrl = safeUrl(firstString(record.url, record.link, record.href, record.manga_url));
  return {
    id: `${source}:${slug || `${title}-${index}`}`,
    slug: slug === 'unknown' ? `${title}-${index}` : slug,
    title,
    poster: recordImage(record),
    summary: firstString(record.synopsis, record.description, record.desc, record.summary, record.sinopsis),
    year: year?.match(/\d{4}/)?.[0],
    status: firstString(record.status, record.state),
    genres,
    kind,
    source,
    sourceUrl,
  };
}

/** Sanka uses several response envelopes; collect title-like records defensively. */
function collectRecords(payload: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || !node || typeof node !== 'object' || seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = node as Record<string, unknown>;
    if (firstString(record.title, record.name, record.title_english, record.title_en, record.judul, record.manga_name, record.anime_title)) {
      found.push(record);
      return;
    }
    for (const key of ['data', 'results', 'result', 'items', 'list', 'anime', 'comic', 'manga', 'latest', 'popular', 'update', 'chapters', 'chapter_list']) {
      if (key in record) visit(record[key], depth + 1);
    }
  };
  visit(payload, 0);
  return found;
}

export function mapSankaTitles(payload: unknown, kind: SankaKind, source = kind === 'comic' ? 'komiku' : 'otakudesu'): SankaTitle[] {
  const seen = new Set<string>();
  return collectRecords(payload).map((record, index) => toTitle(record, kind, source, index)).filter((item): item is SankaTitle => {
    if (!item) return false;
    const key = `${item.title.toLocaleLowerCase()}|${item.year || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchJson(route: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  const response = await nativeFetchText(`${BASE}/${route}`, { timeoutMs: 15000 });
  if (!response.ok) throw new Error(`Sanka API returned ${response.status}.`);
  try {
    return JSON.parse(response.data) as unknown;
  } catch {
    throw new Error('Sanka API returned an unreadable response.');
  }
}

export async function fetchSankaTitles(
  kind: SankaKind,
  query = '',
  source = kind === 'comic' ? 'komiku' : 'otakudesu',
  feed: ComicFeed = 'latest',
  signal?: AbortSignal,
): Promise<SankaTitle[]> {
  const normalizedQuery = query.trim();
  let route: string;
  if (kind === 'anime') {
    route = normalizedQuery
      ? `anime/${encodeURIComponent(source)}/search/${encodeURIComponent(normalizedQuery)}`
      : source === 'otakudesu' ? 'anime/home' : `anime/${encodeURIComponent(source)}/home`;
  } else if (normalizedQuery) {
    route = `comic/${encodeURIComponent(source)}/search/${encodeURIComponent(normalizedQuery)}`;
  } else if (feed === 'popular') {
    route = `comic/${encodeURIComponent(source)}/popular`;
  } else {
    route = source === 'komiku' ? 'comic/homepage' : `comic/${encodeURIComponent(source)}/latest`;
  }

  const payload = await fetchJson(route, signal);
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  return mapSankaTitles(payload, kind, source);
}

function findArrayByKeys(payload: unknown, keys: string[], depth = 0): unknown[] | undefined {
  if (depth > 7 || !payload || typeof payload !== 'object') return undefined;
  if (Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  for (const key of ['data', 'result', 'results', 'manga', 'comic', 'details']) {
    const found = findArrayByKeys(record[key], keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function mapSankaMangaDetail(payload: unknown, source: string, fallbackTitle = 'Manga'): SankaMangaDetail {
  const records = collectRecords(payload);
  const record = records[0] || (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {});
  const chapterEntries = findArrayByKeys(payload, ['chapters', 'chapter_list', 'chapterList', 'chapter']);
  const chapters = (chapterEntries || []).map((entry, index): SankaChapter | null => {
    if (typeof entry === 'string' || typeof entry === 'number') {
      const value = String(entry);
      return { id: `${source}:${value}`, slug: sourceSlug({ slug: value }), title: value };
    }
    if (!entry || typeof entry !== 'object') return null;
    const chapter = entry as Record<string, unknown>;
    const title = firstString(chapter.title, chapter.chapter, chapter.name, chapter.chapter_number, chapter.number) || `Chapter ${index + 1}`;
    const slug = sourceSlug(chapter);
    return { id: `${source}:${slug}`, slug, title };
  }).filter((chapter): chapter is SankaChapter => Boolean(chapter));
  const genresRaw = record.genres ?? record.genre;
  const genres = Array.isArray(genresRaw)
    ? genresRaw.map((entry) => typeof entry === 'string' ? entry : firstString((entry as Record<string, unknown>)?.name)).filter((entry): entry is string => Boolean(entry))
    : typeof genresRaw === 'string' ? genresRaw.split(/[,|]/).map((entry) => entry.trim()).filter(Boolean) : [];
  return {
    title: firstString(record.title, record.name, record.manga_name) || fallbackTitle,
    poster: recordImage(record),
    summary: firstString(record.synopsis, record.description, record.desc, record.summary, record.sinopsis),
    status: firstString(record.status, record.state),
    genres,
    chapters,
  };
}

export async function fetchSankaMangaDetail(source: string, slug: string, signal?: AbortSignal): Promise<SankaMangaDetail> {
  const payload = await fetchJson(`comic/${encodeURIComponent(source)}/manga/${encodeURIComponent(slug)}`, signal);
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  return mapSankaMangaDetail(payload, source);
}

function collectImageUrls(payload: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, depth: number, inImageList = false) => {
    if (depth > 8 || node == null) return;
    if (typeof node === 'string') {
      const url = safeUrl(node);
      if (url && (inImageList || /\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(url))) {
        if (!seen.has(url)) { seen.add(url); urls.push(url); }
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry, depth + 1, inImageList));
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      const imageField = /^(images?|pages?|image_urls?)$/i.test(key);
      if (typeof value === 'string' && /^(image|img|src|url|link)$/i.test(key)) visit(value, depth + 1, true);
      else if (imageField || ['data', 'result', 'results', 'chapter'].includes(key.toLowerCase())) visit(value, depth + 1, imageField || inImageList);
    }
  };
  visit(payload, 0);
  return urls;
}

export async function fetchSankaChapterImages(source: string, slug: string, signal?: AbortSignal): Promise<string[]> {
  const payload = await fetchJson(`comic/${encodeURIComponent(source)}/chapter/${encodeURIComponent(slug)}`, signal);
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  const images = collectImageUrls(payload);
  if (!images.length) throw new Error('This chapter did not include any readable page images.');
  return images;
}

export const SANKA_API_ORIGIN = ORIGIN;
