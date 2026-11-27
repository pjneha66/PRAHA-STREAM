import { load } from 'cheerio';
import type { NsfwMode } from '../types';
import type { ComicLanguageFilter } from './comicLanguages';
import { currentNsfwMode } from './nsfwGate';
import { fetchReadingPage } from './readingRelay';
import type { SankaMangaDetail, SankaTitle } from './sankaService';

const origin = 'https://twokinds.keenspot.com';
const series: SankaTitle = {
  id: 'twokinds', slug: 'twokinds', title: 'Twokinds', source: 'twokinds', kind: 'comic',
  comicType: 'Webcomic', genres: ['Fantasy'], languages: ['en'], sourceUrl: origin,
  poster: 'https://cdn.twokinds.keenspot.com/comics/20031022.jpg',
};

export function twokindsCatalog(query: string, page: number, language: ComicLanguageFilter = 'all', adultMode: NsfwMode = currentNsfwMode()) {
  const matches = query.trim().toLowerCase().split(/\s+/).every((word) => 'twokinds two kinds tom fischbach webcomic fantasy'.includes(word));
  return {
    items: matches && page === 1 && (language === 'all' || language === 'en') && adultMode !== 'only' ? [series] : [],
    page,
    hasMore: false,
  };
}

export async function twokindsDetail(): Promise<SankaMangaDetail> {
  const $ = load(await fetchReadingPage('twokinds', origin + '/archive/'));
  const ids = new Set($('main a[href]').toArray().map((link) => $(link).attr('href')?.match(/^\/comic\/(\d+)\/$/)?.[1]).filter((id): id is string => Boolean(id)));
  if (!ids.size) throw new Error('Twokinds did not return its archive.');
  return {
    ...series,
    author: 'Tom Fischbach',
    chapters: [...ids].map((id) => ({ id, slug: id, title: `Page ${id}`, language: 'en' })),
  };
}

export async function twokindsPages(id: string): Promise<string[]> {
  if (!/^\d{1,7}$/.test(id)) throw new Error('Invalid Twokinds page.');
  const $ = load(await fetchReadingPage('twokinds', `${origin}/comic/${id}/`));
  const image = $('meta[property="og:image"]').attr('content');
  if (!image || !/^https:\/\/cdn\.twokinds\.keenspot\.com\/comics\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(image)) {
    throw new Error('Twokinds did not return a comic page.');
  }
  return [image];
}
