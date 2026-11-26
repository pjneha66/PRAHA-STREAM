import { load } from 'cheerio';
import { isAndroidApp, nativeFetchText, openProtectedEmbed, openSafeExternalUrl } from './androidBridge';
import type { ComicLanguageFilter } from './comicLanguages';
import type { SankaTitle, SankaTitlesPage } from './sankaService';

export const COMIC_BOOK_SITES = {
  annasarchive: { label: 'Anna’s Archive', origin: 'https://annas-archive.gl' },
  oceanofpdf: { label: 'OceanofPDF', origin: 'https://theoceanofpdf.com' },
};

export type ComicBookSite = keyof typeof COMIC_BOOK_SITES;

export function isComicBookSite(source: string): source is ComicBookSite {
  return Object.hasOwn(COMIC_BOOK_SITES, source);
}

export function comicBookSiteUrl(source: ComicBookSite, query: string, language: ComicLanguageFilter = 'all', page = 1): string {
  const url = new URL(source === 'annasarchive' ? '/search' : '/', COMIC_BOOK_SITES[source].origin);
  if (source === 'annasarchive') {
    url.searchParams.set('content', 'book_comic');
    if (query) url.searchParams.set('q', query);
    if (language !== 'all') url.searchParams.set('lang', language);
    if (page > 1) url.searchParams.set('page', String(page));
  } else {
    url.searchParams.set('s', query || 'comics');
    if (page > 1) url.searchParams.set('paged', String(page));
  }
  return url.href;
}

export async function openComicBookSite(url: string): Promise<boolean> {
  return isAndroidApp() ? openProtectedEmbed(url) : openSafeExternalUrl(url);
}

export async function loadComicBookSite(source: ComicBookSite, query: string, language: ComicLanguageFilter, page: number): Promise<SankaTitlesPage> {
  if (source === 'oceanofpdf' && language !== 'all') return { page, items: [], hasMore: false };
  const url = comicBookSiteUrl(source, query, language, page);
  const response = await nativeFetchText(url, { timeoutMs: 6500 });
  if (!response.ok) throw new Error('Open the site to browse its catalog.');

  const $ = load(response.data);
  if (!response.data || /ddos.guard|just a moment|verify you are human/i.test($('title').text())) {
    throw new Error('The site requires a browser check.');
  }
  const origin = COMIC_BOOK_SITES[source].origin;
  const items = new Map<string, SankaTitle>();
  const selector = source === 'annasarchive' ? 'a[href^="/md5/"]' : '.wp-block-post-title a[href]';
  $(selector).each((_, link) => {
    const href = $(link).attr('href');
    const title = $(link).text().trim().replace(/^Download\s+/i, '');
    if (!href || !title) return;
    let detail: URL;
    try { detail = new URL(href, origin); } catch { return; }
    if (detail.origin !== origin || detail.username || detail.password || items.has(detail.pathname)) return;
    const card = source === 'oceanofpdf' ? $(link).closest('.wp-block-post') : null;
    const image = card?.find('.wp-block-post-featured-image img').attr('src');
    const slug = detail.pathname;
    items.set(slug, {
      id: `${source}:${slug}`, slug, title, sourceUrl: detail.href, kind: 'comic', source,
      poster: image?.startsWith('https://') ? image : undefined,
      summary: card?.find('.wp-block-post-excerpt__excerpt').text().trim(),
      genres: [],
    });
  });
  return {
    page, items: [...items.values()],
    hasMore: source === 'oceanofpdf' && $('.wp-block-query-pagination-next').length > 0,
  };
}
