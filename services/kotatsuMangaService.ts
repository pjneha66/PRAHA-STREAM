import { load } from 'cheerio';
import type { NsfwMode } from '../types';
import { proxyStreamUrlWithHeaders } from './androidBridge';
import type { MangaChapter, MangaItem } from './mangaService';
import { fetchReadingPage } from './readingRelay';

const origins = {
  mangakatana: 'https://mangakatana.com',
  mangatellers: 'https://reader.mangatellers.gr',
  guyacubari: 'https://guya.cubari.moe',
};
export type ExtraKotatsuProvider = keyof typeof origins;

function sourceUrl(raw: string | undefined, origin: string, path: RegExp): URL | undefined {
  if (!raw) return;
  try {
    const url = new URL(raw, origin);
    if (url.origin === origin && !url.username && !url.password && path.test(url.pathname)) return url;
  } catch { /* Ignore malformed source links. */ }
}

function manga(provider: ExtraKotatsuProvider, url: URL, title: string, cover?: URL): MangaItem {
  return {
    id: provider + ':' + url.pathname, title, url: url.href, type: 'Manga', kotatsuProvider: provider,
    coverSmall: cover?.href || '', coverNormal: cover?.href || '',
  };
}

const katanaSeriesPath = /^\/manga\/[\w-]+\.\d+$/;
const katanaChapterPath = /^\/manga\/[\w-]+\.\d+\/c\d+(?:\.\d+)?$/;
const katanaAdult = /^(?:adult|mature|hentai|smut|ecchi)$/i;
const katanaHeaders = { Referer: origins.mangakatana + '/' };

const mangakatana = {
  async catalog(query: string, page: number, mode: NsfwMode) {
    const origin = origins.mangakatana;
    const url = new URL((query ? '' : '/manga') + (page === 1 ? '' : '/page/' + page) || '/', origin);
    if (query) {
      url.searchParams.set('search', query);
      url.searchParams.set('search_by', 'm_name');
    }
    const $ = load(await fetchReadingPage('mangakatana', url.href));
    const items: MangaItem[] = [];
    $('#book_list > .item').each((_, element) => {
      const card = $(element);
      const link = card.find('h3.title > a').first();
      const series = sourceUrl(link.attr('href'), origin, katanaSeriesPath);
      const title = link.text().trim();
      const genres = card.find('.genres a').toArray().map((tag) => $(tag).text().trim());
      if (!series || !title || (mode === 'off' && (!genres.length || genres.some((genre) => katanaAdult.test(genre))))) return;
      const cover = sourceUrl(card.find('.wrap_img img').attr('src'), origin, /^\/imgs\/cover\//);
      items.push(manga('mangakatana', series, title, cover));
    });
    const hasMore = $('.uk-pagination a').toArray().some((link) => {
      const target = sourceUrl($(link).attr('href'), origin, /^\/(?:manga\/)?page\/\d+$/);
      return target?.pathname === (query ? '' : '/manga') + '/page/' + (page + 1);
    });
    return { items, hasMore };
  },
  async chapters(item: MangaItem, mode: NsfwMode) {
    const origin = origins.mangakatana;
    const series = sourceUrl(item.url, origin, katanaSeriesPath);
    if (!series) throw new Error('Invalid MangaKatana title.');
    const $ = load(await fetchReadingPage('mangakatana', series.href));
    const genres = $('#single_book .genres a').toArray().map((tag) => $(tag).text().trim());
    if (mode === 'off' && (!genres.length || genres.some((genre) => katanaAdult.test(genre)))) {
      throw new Error('This title is hidden by the adult-content filter.');
    }
    return $('#single_book .chapters .chapter a').toArray().flatMap((element) => {
      const link = $(element);
      const url = sourceUrl(link.attr('href'), origin, katanaChapterPath);
      if (!url?.pathname.startsWith(series.pathname + '/')) return [];
      return [{ id: url.pathname, url: url.href, name: link.text().trim(), chapterNumber: Number(url.pathname.split('/c').at(-1)) }];
    });
  },
  async pages(chapter: MangaChapter) {
    const url = sourceUrl(chapter.url, origins.mangakatana, katanaChapterPath);
    if (!url || url.pathname !== chapter.id) throw new Error('Invalid MangaKatana chapter.');
    const $ = load(await fetchReadingPage('mangakatana', url.href));
    const script = $('script').toArray().map((node) => $(node).text()).find((code) => /data-src['"]\s*,\s*\w+\[i\]/.test(code));
    const variable = script?.match(/data-src['"]\s*,\s*(\w+)\[i\]/)?.[1];
    const array = variable && script?.match(new RegExp('\\bvar\\s+' + variable + '\\s*=\\s*\\[([^\\]]*)\\]'))?.[1];
    const urls = array ? [...array.matchAll(/['"](https:\/\/[^'"]+)['"]/g)].map((match) => match[1]) : [];
    const pages = urls.filter((raw) => {
      const host = new URL(raw).hostname;
      return /^i\d*\.mangakatana\.com$/.test(host) && sourceUrl(raw, 'https://' + host, /^\/token\//);
    });
    const expected = $('#imgs .wrap_img').length;
    return expected && pages.length === expected ? pages.map((page) => proxyStreamUrlWithHeaders(page, katanaHeaders)) : [];
  },
};

const tellersSeriesPath = /^\/series\/[\w-]+\/$/;
const tellersChapterPath = /^\/read\/[\w-]+\/en\/\d+(?:\.\d+)?\/\d+(?:\.\d+)?\/$/;
const tellersImagePath = /^\/content\/comics\//;

const mangatellers = {
  async catalog(query: string, page: number) {
    if (page !== 1) return { items: [], hasMore: false };
    const origin = origins.mangatellers;
    const $ = load(await fetchReadingPage('mangatellers', origin + '/directory/'));
    const items = $('.list.series > .group').toArray().flatMap((element) => {
      const card = $(element);
      const link = card.find('> .title a').first();
      const url = sourceUrl(link.attr('href'), origin, tellersSeriesPath);
      const title = link.text().trim();
      const cover = sourceUrl(card.find('img.preview').attr('src'), origin, tellersImagePath);
      return url && title && title.toLowerCase().includes(query.toLowerCase()) ? [manga('mangatellers', url, title, cover)] : [];
    });
    return { items, hasMore: false };
  },
  async chapters(item: MangaItem) {
    const origin = origins.mangatellers;
    const series = sourceUrl(item.url, origin, tellersSeriesPath);
    if (!series) throw new Error('Invalid Mangatellers title.');
    const prefix = series.pathname.replace('/series/', '/read/') + 'en/';
    const $ = load(await fetchReadingPage('mangatellers', series.href));
    return $('.list .element .title a').toArray().flatMap((element) => {
      const link = $(element);
      const url = sourceUrl(link.attr('href'), origin, tellersChapterPath);
      if (!url?.pathname.startsWith(prefix)) return [];
      const name = link.attr('title') || link.text().trim();
      return [{ id: url.pathname, url: url.href, name, chapterNumber: Number(url.pathname.split('/').at(-2)) }];
    });
  },
  async pages(chapter: MangaChapter) {
    const origin = origins.mangatellers;
    const url = sourceUrl(chapter.url, origin, tellersChapterPath);
    if (!url || url.pathname !== chapter.id) throw new Error('Invalid Mangatellers chapter.');
    const html = await fetchReadingPage('mangatellers', url.href);
    const data = html.match(/\bvar pages\s*=\s*(\[[^\r\n]*\]);/)?.[1];
    const pages: { url?: string; hidden?: string }[] = data ? JSON.parse(data) : [];
    return pages.flatMap((page) => {
      const image = sourceUrl(page.url, origin, tellersImagePath);
      return image && page.hidden === '0' ? [image.href] : [];
    });
  },
};

const guyaSeries = [
  ['Kaguya-Wants-To-Be-Confessed-To', 'Kaguya-sama: Love is War', '28/87307.jpg'],
  ['We-Want-To-Talk-About-Kaguya', 'We Want to Talk About Kaguya', '8/20535.jpg'],
  ['Oshi-no-Ko', 'Oshi no Ko', '8/98850.jpg'],
  ['Renai-Daikou', 'Renai Daikou', '1/30618.jpg'],
];
type GuyaChapter = { title: string; folder: string; groups: Record<string, string[]> };

async function guyaChapters(slug: string): Promise<Record<string, GuyaChapter>> {
  if (!guyaSeries.some(([id]) => id === slug)) throw new Error('Invalid GuyaCubari title.');
  const json = await fetchReadingPage('guyacubari', origins.guyacubari + '/api/series/' + slug + '/');
  return JSON.parse(json).chapters;
}

const guyacubari = {
  async catalog(query: string, page: number) {
    const origin = origins.guyacubari;
    const term = query.toLowerCase();
    const items = page === 1 ? guyaSeries.filter(([slug, title]) =>
      title.toLowerCase().includes(term) || slug.toLowerCase().replaceAll('-', ' ').includes(term),
    ).map(([slug, title, cover]) => manga('guyacubari', new URL('/read/manga/' + slug + '/', origin), title,
      new URL('/media/manga/' + slug + '/volume_covers/' + cover, origin))) : [];
    return { items, hasMore: false };
  },
  async chapters(item: MangaItem) {
    const series = sourceUrl(item.url, origins.guyacubari, /^\/read\/manga\/[\w-]+\/$/);
    if (!series) throw new Error('Invalid GuyaCubari title.');
    const slug = series.pathname.split('/').at(-2)!;
    const chapters = await guyaChapters(slug);
    return Object.entries(chapters).flatMap(([number, chapter]) => /^\d+(?:\.\d+)?$/.test(number)
      ? [{ id: slug + ':' + number, name: 'Chapter ' + number + (chapter.title ? ': ' + chapter.title : ''), url: '', chapterNumber: Number(number) }] : []);
  },
  async pages(chapter: MangaChapter) {
    const [slug, number] = chapter.id.split(':');
    if (!/^\d+(?:\.\d+)?$/.test(number)) throw new Error('Invalid GuyaCubari chapter.');
    const available = (await guyaChapters(slug))[number];
    if (!available || !/^[\w.-]+$/.test(available.folder)) return [];
    const [group, files] = Object.entries(available.groups).find(([id, pages]) => /^\d+$/.test(id) && Array.isArray(pages) && pages.length) ?? [];
    if (!group || !files) return [];
    return files.filter((file) => /^[\w.%-]+\.(?:jpe?g|png|webp|gif)(?:\?[\w=&-]+)?$/i.test(file))
      .map((file) => origins.guyacubari + '/media/manga/' + slug + '/chapters/' + available.folder + '/' + group + '/' + file);
  },
};

export const extraKotatsuProviders = { mangakatana, mangatellers, guyacubari };

export function extraKotatsuProvider(id?: string) {
  return id && Object.hasOwn(extraKotatsuProviders, id) ? extraKotatsuProviders[id as ExtraKotatsuProvider] : undefined;
}
