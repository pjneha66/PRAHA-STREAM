import { load } from 'cheerio';
import { proxyStreamUrlWithHeaders } from './androidBridge';
import type { MangaChapter, MangaItem } from './mangaService';
import { fetchReadingPage } from './readingRelay';

const origin = 'https://www.webtoons.com';
const seriesPath = /^\/en\/[\w-]+\/[\w-]+\/list$/;
const episodePath = /^\/en\/[\w-]+\/[\w-]+\/[\w-]+\/viewer$/;
const pageSize = 24;
const imageHeaders = { Referer: origin + '/' };
const desktopHeaders = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
};

function webtoonUrl(raw: string | undefined, path: RegExp) {
  try {
    const url = new URL(raw || '', origin);
    if (url.origin === origin && !url.username && !url.password && path.test(url.pathname)
        && /^\d+$/.test(url.searchParams.get('title_no') || '')) return url;
  } catch { /* Ignore malformed catalogue links. */ }
  return undefined;
}

function cdnImage(raw?: string) {
  try {
    const url = new URL(raw || '');
    if (url.origin === 'https://webtoon-phinf.pstatic.net' && !url.username && !url.password) return url.href;
  } catch { /* Ignore malformed artwork. */ }
  return undefined;
}

export async function webtoonsCatalog(query: string, page: number) {
  const url = new URL(query ? '/en/search' : '/en/originals', origin);
  if (query) url.searchParams.set('keyword', query);
  const $ = load(await fetchReadingPage('webtoonsenglish', url.href, desktopHeaders));
  const titles = new Map<string, MangaItem>();
  $('a[href*="/list?title_no="]').each((_, link) => {
    const item = $(link);
    const series = webtoonUrl(item.attr('href'), seriesPath);
    const title = item.find('.subj, .title').first().text().trim();
    if (!series || !title) return;
    const id = `webtoons:${series.searchParams.get('title_no')}`;
    const cover = cdnImage(item.find('img').first().attr('src')) || '';
    titles.set(id, { id, title, url: series.href, coverSmall: cover, coverNormal: cover, type: 'WEBTOON', kotatsuProvider: 'webtoons' });
  });
  const end = page * pageSize;
  return { items: [...titles.values()].slice(end - pageSize, end), hasMore: titles.size > end };
}

export async function webtoonsChapters(item: MangaItem, page: number) {
  const url = webtoonUrl(item.url, seriesPath);
  if (!url || item.id !== `webtoons:${url.searchParams.get('title_no')}`) throw new Error('Invalid WEBTOON series.');
  if (page > 1) url.searchParams.set('page', String(page));
  const $ = load(await fetchReadingPage('webtoonsenglish', url.href, desktopHeaders));
  const chapters: MangaChapter[] = [];
  $('li._episodeItem a[href]').each((_, link) => {
    const episode = webtoonUrl($(link).attr('href'), episodePath);
    const number = episode?.searchParams.get('episode_no');
    if (!episode || !number || !/^\d+$/.test(number) || episode.searchParams.get('title_no') !== url.searchParams.get('title_no')) return;
    chapters.push({
      id: `${item.id}:${number}`, name: $(link).find('.subj').text().trim() || `Episode ${number}`,
      url: episode.href, chapterNumber: Number(number),
    });
  });
  const hasMore = $('.paginate a[href]').toArray().some((link) => {
    const next = webtoonUrl($(link).attr('href'), seriesPath);
    return next?.pathname === url.pathname && Number(next.searchParams.get('page')) === page + 1;
  });
  return { chapters, hasMore };
}

export async function webtoonsPages(chapter: MangaChapter) {
  const url = webtoonUrl(chapter.url, episodePath);
  const number = url?.searchParams.get('episode_no');
  if (!url || !number || !/^\d+$/.test(number)
      || chapter.id !== `webtoons:${url.searchParams.get('title_no')}:${number}`) throw new Error('Invalid WEBTOON episode.');
  const $ = load(await fetchReadingPage('webtoonsenglish', url.href, desktopHeaders));
  const images = $('#_imageList img').toArray()
    .map((image) => cdnImage($(image).attr('data-url')))
    .filter((image): image is string => Boolean(image));
  return [...new Set(images)].map((image) => proxyStreamUrlWithHeaders(image, imageHeaders));
}
