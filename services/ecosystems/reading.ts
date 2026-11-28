import type { NsfwMode } from '../../types';
// The reading facade over the ecosystems' manga and novel extensions — the
// piece that lets Reading → Manga and Reading → Novels browse them and open
// chapters in the reader.
//
// Hikari keeps this split across AnymexMangaProvider and SoraMangaProvider;
// here it is one module with two shapes:
//
//   * manga (AnymeX manga extensions, Sora manga modules) answer catalogs,
//     chapters and page image lists for MangaView's reader;
//   * novels (Sora novel modules) answer catalogs, chapter lists and chapter
//     text for NovelsView's reader.
//
// An extension is recognised by its key being the prefix of the item's id
// (`<extension key>:<own id>`), which is how the reader resolves the right
// extension when a chapter is opened.

import type { MangaChapter, MangaItem } from '../mangaService';
import type { Novel } from '../novelService';
import {
  anymexCatalog, anymexChapters, anymexDetail, anymexPages, anymexSearch,
} from './anymex';
import {
  soraChapters, soraDetail, soraNovelText, soraPages, soraSearch, SORA_CATALOGS,
} from './sora';
import { ecosystemExtensions, type EcosystemExtension, type EcosystemKind } from './store';

/** The installed extensions that serve one reading kind. */
export function installedReadingExtensions(kind: Extract<EcosystemKind, 'manga' | 'novel'>, mode?: NsfwMode): EcosystemExtension[] {
  return ecosystemExtensions('anymex')
    .concat(ecosystemExtensions('sora'))
    .filter((entry) => entry.enabled && entry.kind === kind && (mode === 'only' ? entry.nsfw : mode !== 'off' || !entry.nsfw));
}

/** The extension an item id (`<key>:<own id>`) belongs to, from what is installed. */
export function extensionForItemId(id: string | undefined, kind?: 'manga' | 'novel', mode?: NsfwMode): EcosystemExtension | null {
  if (!id) return null;
  const pool = kind
    ? installedReadingExtensions(kind, mode)
    : [...installedReadingExtensions('manga'), ...installedReadingExtensions('novel')];
  return pool.find((entry) => id.startsWith(`${entry.key}:`)) ?? null;
}

const ownIdOf = (extension: EcosystemExtension, id: string): string =>
  id.startsWith(`${extension.key}:`) ? id.slice(extension.key.length + 1) : id;

// ── manga ──

/**
 * One catalog page: a search when there is a query, else the browse rows —
 * AnymeX answers Popular; a Sora module has no browse endpoint, so its browse
 * list is the first seeded search, exactly as its reference provider seeds.
 */
export async function ecoMangaCatalog(
  extension: EcosystemExtension,
  query: string,
  page: number,
): Promise<{ items: MangaItem[]; hasMore: boolean }> {
  const toMangaItem = (raw: { id: string; title: string; poster?: string; overview?: string }): MangaItem => ({
    id: `${extension.key}:${raw.id}`,
    title: raw.title,
    coverSmall: raw.poster ?? '',
    coverNormal: raw.poster ?? '',
    type: 'Manga',
    synopsis: raw.overview || '',
    url: raw.id,
  });
  if (extension.ecosystem === 'anymex') {
    const items = query.trim()
      ? await anymexSearch(extension, query.trim(), page)
      : await anymexCatalog(extension, 'popular', page);
    return { items: items.map((item) => toMangaItem({ id: item.providerMediaId ?? '', title: item.title, poster: item.poster, overview: item.overview })), hasMore: false };
  }
  if (query.trim()) {
    const items = await soraSearch(extension, query.trim(), page);
    return { items: items.map((item) => toMangaItem({ id: item.providerMediaId ?? '', title: item.title, poster: item.poster, overview: item.overview })), hasMore: false };
  }
  // SoraMangaProvider's browse seeds: popular first, one page each.
  const seeds = ['popular', 'top', 'trending', 'best'];
  const seed = seeds[Math.max(1, page) - 1];
  if (!seed) return { items: [], hasMore: false };
  const items = await soraSearch(extension, seed, 1);
  return { items: items.map((item) => toMangaItem({ id: item.providerMediaId ?? '', title: item.title, poster: item.poster, overview: item.overview })), hasMore: page < seeds.length };
}

/** A title's details, filling synopsis (and tags when the module gives them). */
export async function ecoMangaDetail(
  extension: EcosystemExtension,
  item: MangaItem,
): Promise<MangaItem> {
  const own = ownIdOf(extension, item.id);
  const known: Parameters<typeof soraDetail>[2] = {
    id: item.id,
    type: 'series',
    title: item.title,
    overview: item.synopsis ?? '',
    poster: item.coverNormal ?? '',
    genres: item.tags ?? [],
    source: extension.ecosystem,
    providerId: extension.key,
    providerMediaId: own,
  };
  const filled = extension.ecosystem === 'anymex'
    ? await anymexDetail(extension, own, known)
    : await soraDetail(extension, own, known);
  if (!filled) return item;
  return {
    ...item,
    synopsis: filled.overview || item.synopsis,
    tags: filled.genres?.length ? filled.genres : item.tags,
    author: undefined,
  };
}

/** The chapter list, numbered the way the reader's order control expects. */
export async function ecoMangaChapters(extension: EcosystemExtension, item: MangaItem): Promise<MangaChapter[]> {
  const own = ownIdOf(extension, item.id);
  const list = extension.ecosystem === 'anymex'
    ? await anymexChapters(extension, own)
    : await soraChapters(extension, own);
  return list.map((chapter) => ({
    id: chapter.id,
    name: chapter.name,
    url: '',
    chapterNumber: chapter.number,
  }));
}

/** One chapter's page images — what MangaReader shows. */
export async function ecoMangaPages(extension: EcosystemExtension, item: MangaItem, chapter: MangaChapter): Promise<string[]> {
  return extension.ecosystem === 'anymex'
    ? anymexPages(extension, ownIdOf(extension, item.id), chapter.id)
    : soraPages(extension, chapter.id);
}

// ── novels ──

/** Sora novel modules: a search (their only surface; they have no browse). */
export async function ecoNovelSearch(extension: EcosystemExtension, query: string, page: number): Promise<{ items: Novel[]; hasMore: boolean }> {
  const items = await soraSearch(extension, query.trim() || 'popular', page);
  return {
    // `source` stays unset on ecosystem novels: their chapters are read
    // through this facade (`ecoNovelText`), never through loadNovelText.
    items: items.map((item) => ({
      title: item.title,
      url: item.providerMediaId ?? '',
      ecoKey: extension.key,
      cover: item.poster || undefined,
    })),
    hasMore: false,
  };
}

export async function ecoNovelChapters(extension: EcosystemExtension, ownId: string): Promise<Array<{ title: string; url: string; ecoKey?: string }>> {
  const list = await soraChapters(extension, ownId);
  return list.map((chapter) => ({ title: chapter.name, url: chapter.id, ecoKey: extension.key }));
}

/** Chapter text as paragraphs, the way the novel reader renders them. */
export function htmlToParagraphs(html: string): string[] {
  const cleaned = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const blocks = cleaned.match(/<p[\s>][\s\S]*?<\/p>|<br\s*\/?\s*>\s*<br\s*\/?\s*>/gi) || [];
  const decode = (value: string): string => value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/\s+/g, ' ')
    .trim();
  const paragraphs = blocks
    .map(decode)
    .filter(Boolean);
  if (paragraphs.length) return paragraphs;
  // A module that returned plain text (or stripped HTML) reads as paragraphs
  // split on blank lines — split the raw text, decode each block after, since
  // decoding collapses the very whitespace the split needs.
  return cleaned.split(/\n{2,}/).map(decode).filter(Boolean);
}

export async function ecoNovelText(extension: EcosystemExtension, chapterId: string): Promise<string[]> {
  const html = await soraNovelText(extension, chapterId);
  return htmlToParagraphs(html);
}
