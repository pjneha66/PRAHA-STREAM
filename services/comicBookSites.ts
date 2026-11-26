import { load } from 'cheerio';
import { nativeFetchText, openPublicationUrl } from './androidBridge';
import type { ComicLanguageFilter } from './comicLanguages';
import type { SankaTitle, SankaTitlesPage } from './sankaService';

export const COMIC_BOOK_SITES = {
  annasarchive: { label: 'Anna’s Archive', origin: 'https://annas-archive.gl' },
  oceanofpdf: { label: 'OceanofPDF', origin: 'https://theoceanofpdf.com' },
  comicsall: { label: 'Comics-All', origin: 'https://comics-all.com' },
  comicsnake: { label: 'ComicSnake', origin: 'https://comicsnake.com' },
  getcomics: { label: 'GetComics', origin: 'https://getcomics.org' },
};

export type ComicBookSite = keyof typeof COMIC_BOOK_SITES;

export function isComicDownloadSite(source: ComicBookSite): boolean {
  return source === 'comicsall' || source === 'comicsnake' || source === 'getcomics';
}

const CATALOG_MARKUP = {
  annasarchive: { link: 'a[href^="/md5/"]', card: '', image: '', next: '' },
  oceanofpdf: { link: '.wp-block-post-title a[href]', card: '.wp-block-post', image: '.wp-block-post-featured-image img', next: '.wp-block-query-pagination-next' },
  comicsall: { link: '.preview-title[href]', card: '.preview-in', image: 'img', next: '.pagi-nav' },
  comicsnake: { link: '.comics_th-in[href][title]', card: '.comics_th-item', image: 'img', next: '.pagi-nav' },
  getcomics: { link: 'article.post:not(.category-news, .category-sponsored) .post-title a[href]', card: 'article.post', image: '.post-header-image img', next: '.page-contents .page-numbers' },
};

export function isComicBookSite(source: string): source is ComicBookSite {
  return Object.hasOwn(COMIC_BOOK_SITES, source);
}

export function comicBookSiteUrl(source: ComicBookSite, query: string, language: ComicLanguageFilter = 'all', page = 1): string {
  const url = new URL('/', COMIC_BOOK_SITES[source].origin);
  if (source === 'annasarchive') {
    url.pathname = '/search';
    url.searchParams.set('content', 'book_comic');
    if (query) url.searchParams.set('q', query);
    if (language !== 'all') url.searchParams.set('lang', language);
    if (page > 1) url.searchParams.set('page', String(page));
  } else if (source === 'oceanofpdf') {
    url.searchParams.set('s', query || 'comics');
    if (page > 1) url.searchParams.set('paged', String(page));
  } else if (!query || source === 'getcomics') {
    if (page > 1) url.pathname = `/page/${page}/`;
    if (query) url.searchParams.set('s', query);
  } else {
    url.pathname = '/index.php';
    url.search = new URLSearchParams({ do: 'search', subaction: 'search', story: query }).toString();
    if (page > 1 && source === 'comicsall') {
      url.searchParams.set('search_start', String(page));
      url.searchParams.set('result_from', String((page - 1) * 150 + 1));
    }
    if (page > 1 && source === 'comicsnake') url.searchParams.set('from_page', String(page));
  }
  return url.href;
}

export async function openComicBookSite(url: string): Promise<boolean> {
  return openPublicationUrl(url);
}

export async function loadComicBookSite(source: ComicBookSite, query: string, language: ComicLanguageFilter, page: number): Promise<SankaTitlesPage> {
  if (source !== 'annasarchive' && language !== 'all' && !(language === 'en' && isComicDownloadSite(source))) {
    return { page, items: [], hasMore: false };
  }
  const url = comicBookSiteUrl(source, query, language, page);
  const response = await nativeFetchText(url, { timeoutMs: 6500 });
  if (!response.ok) throw new Error('Open the site to browse its catalog.');

  const $ = load(response.data);
  if (!response.data || /ddos.guard|just a moment|verify you are human/i.test($('title').text())) {
    throw new Error('The site requires a browser check.');
  }
  const origin = COMIC_BOOK_SITES[source].origin;
  const items = new Map<string, SankaTitle>();
  const markup = CATALOG_MARKUP[source];
  $(markup.link).each((_, link) => {
    const href = $(link).attr('href');
    const title = (source === 'comicsnake' ? $(link).attr('title') || '' : $(link).text()).trim().replace(/^Download\s+/i, '');
    if (!href || !title) return;
    let detail: URL;
    try { detail = new URL(href, origin); } catch { return; }
    if (detail.origin !== origin || detail.username || detail.password || items.has(detail.pathname)) return;
    const card = markup.card ? $(link).closest(markup.card) : null;
    const image = card?.find(markup.image).first();
    const imageSrc = image?.attr('data-src') || image?.attr('src');
    let poster: string | undefined;
    try {
      const cover = imageSrc && new URL(imageSrc, url);
      if (cover && cover.protocol === 'https:' && !cover.username && !cover.password) poster = cover.href;
    } catch { /* Missing cover. */ }
    const slug = detail.pathname;
    items.set(slug, {
      id: `${source}:${slug}`, slug, title, sourceUrl: detail.href, kind: 'comic', source,
      poster,
      summary: card?.find('.wp-block-post-excerpt__excerpt').text().trim(),
      genres: [],
    });
  });
  return {
    page, items: [...items.values()],
    hasMore: source === 'oceanofpdf' ? $(markup.next).length > 0
      : Boolean(markup.next) && $(markup.next).find('a').toArray().some((link) => {
        const target = $(link).attr('href');
        return target === comicBookSiteUrl(source, query, language, page + 1)
          || $(link).text().trim() === String(page + 1);
      }),
  };
}
