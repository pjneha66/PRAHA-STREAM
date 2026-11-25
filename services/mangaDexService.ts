import { isAndroidApp, nativeFetchText } from './androidBridge';
import type { ComicLanguageFilter } from './comicLanguages';
import { comicsRelayUrl } from './comicsRelay';
import { currentNsfwMode } from './nsfwGate';
import type { ComicFeed, SankaMangaDetail, SankaTitle, SankaTitlesPage } from './sankaService';

const API = 'https://api.mangadex.org';
const PAGE_SIZE = 24;
const CHAPTER_LIMIT = 500;

type Localized = Record<string, string>;
interface Manga {
  id: string;
  attributes: {
    title: Localized;
    altTitles?: Localized[];
    description?: Localized;
    year?: number;
    status?: string;
    contentRating: string;
    availableTranslatedLanguages?: string[];
    tags?: { attributes: { name: Localized } }[];
  };
  relationships?: { type: string; attributes?: { fileName?: string; name?: string } }[];
}

interface Chapter {
  id: string;
  attributes: { chapter: string | null; title: string | null; pages: number; translatedLanguage?: string; externalUrl?: string };
}

interface Collection<T> {
  data: T[];
  total: number;
}

async function request<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const native = isAndroidApp();
  const endpoint = `${path}?${params}`;
  const url = native || import.meta.env.MODE === 'test' ? API + endpoint
    : import.meta.env.VITE_MANGADEX_RELAY === '1' ? '/mangadex-api' + endpoint
    : comicsRelayUrl('/mangadex-api' + endpoint);
  const headers = native ? { 'User-Agent': 'PRAHA-STREAM', Accept: 'application/json' } : { Accept: 'application/json' };
  const response = await nativeFetchText(url, { headers, timeoutMs: 12000 });
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(`MangaDex returned HTTP ${response.status}.`);
  try {
    return JSON.parse(response.data) as T;
  } catch {
    throw new Error('MangaDex did not return catalog data.');
  }
}

function allowedRatings(): string[] {
  const mode = currentNsfwMode();
  if (mode === 'only') return ['erotica', 'pornographic'];
  if (mode === 'on') return ['safe', 'suggestive', 'erotica', 'pornographic'];
  return ['safe', 'suggestive'];
}

function localized(values?: Localized): string | undefined {
  return values?.en || Object.values(values || {})[0];
}

function toTitle(manga: Manga): SankaTitle {
  const attributes = manga.attributes;
  const cover = manga.relationships?.find(({ type }) => type === 'cover_art')?.attributes?.fileName;
  return {
    id: `mangadex:${manga.id}`,
    slug: manga.id,
    title: attributes.title.en || attributes.altTitles?.find((title) => title.en)?.en || localized(attributes.title) || 'MangaDex title',
    poster: cover ? `https://uploads.mangadex.org/covers/${manga.id}/${encodeURIComponent(cover)}.256.jpg` : undefined,
    aliases: attributes.altTitles?.flatMap(Object.values),
    languages: attributes.availableTranslatedLanguages?.filter(Boolean),
    summary: localized(attributes.description),
    year: attributes.year?.toString(),
    status: attributes.status,
    genres: (attributes.tags || []).flatMap((tag) => localized(tag.attributes.name) || []),
    comicType: 'Manga',
    kind: 'comic',
    source: 'mangadex',
    sourceUrl: `https://mangadex.org/title/${manga.id}`,
  };
}

export async function mangaDexCatalog(query: string, page: number, feed: ComicFeed, signal?: AbortSignal, language: ComicLanguageFilter = 'en'): Promise<SankaTitlesPage> {
  const offset = (page - 1) * PAGE_SIZE;
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE), offset: String(offset), hasAvailableChapters: 'true',
    'includes[]': 'cover_art',
  });
  if (language !== 'all') params.set('availableTranslatedLanguage[]', language);
  if (query) params.set('title', query);
  else params.set(feed === 'popular' ? 'order[followedCount]' : 'order[latestUploadedChapter]', 'desc');
  allowedRatings().forEach((rating) => params.append('contentRating[]', rating));
  const { data, total } = await request<Collection<Manga>>('/manga', params, signal);
  return { items: data.map(toTitle), page, hasMore: offset + data.length < Math.min(total, 10000) && data.length > 0 };
}

export async function mangaDexDetail(id: string, signal?: AbortSignal, language: ComicLanguageFilter = 'en'): Promise<SankaMangaDetail> {
  const mangaPath = `/manga/${encodeURIComponent(id)}`;
  const infoParams = new URLSearchParams([['includes[]', 'cover_art'], ['includes[]', 'author']]);
  const { data: manga } = await request<{ data: Manga }>(mangaPath, infoParams, signal);
  const ratings = allowedRatings();
  if (!ratings.includes(manga.attributes.contentRating)) throw new Error('This title is unavailable with the current content filter.');
  const chapters: SankaMangaDetail['chapters'] = [];
  for (let offset = 0; offset < 10000;) {
    const params = new URLSearchParams({
      limit: String(CHAPTER_LIMIT), offset: String(offset), includeExternalUrl: '0',
      'order[volume]': 'asc', 'order[chapter]': 'asc',
    });
    if (language !== 'all') params.set('translatedLanguage[]', language);
    ratings.forEach((rating) => params.append('contentRating[]', rating));
    const { data, total } = await request<Collection<Chapter>>(`${mangaPath}/feed`, params, signal);
    for (const { id: chapterId, attributes } of data) {
      if (!attributes.pages || attributes.externalUrl) continue;
      const number = attributes.chapter ? `Chapter ${attributes.chapter}` : undefined;
      chapters.push({
        id: chapterId, slug: chapterId, language: attributes.translatedLanguage,
        title: [number, attributes.title].filter(Boolean).join(' · ') || 'Oneshot',
      });
    }
    offset += data.length;
    if (!data.length || offset >= total) break;
  }
  return {
    ...toTitle(manga),
    author: manga.relationships?.find(({ type }) => type === 'author')?.attributes?.name,
    chapters,
  };
}

export async function mangaDexPages(id: string, signal?: AbortSignal): Promise<string[]> {
  const { baseUrl, chapter } = await request<{
    baseUrl: string;
    chapter: { hash: string; data: string[]; dataSaver: string[] };
  }>(`/at-home/server/${encodeURIComponent(id)}`, new URLSearchParams({ forcePort443: 'true' }), signal);
  const server = new URL(baseUrl);
  if (server.protocol !== 'https:') throw new Error('MangaDex returned an invalid image server.');
  if (!chapter.data.length) throw new Error('MangaDex returned no pages for this chapter.');
  return chapter.data.map((file) => new URL(`/data/${encodeURIComponent(chapter.hash)}/${encodeURIComponent(file)}`, server).href);
}
