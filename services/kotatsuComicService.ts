import { load } from 'cheerio';
import { extraKotatsuProviders } from './kotatsuMangaService';
import { fetchReadingPage } from './readingRelay';
import type { SankaChapter, SankaMangaDetail, SankaTitle, SankaTitlesPage } from './sankaService';

export const KOTATSU_COMIC_SOURCES = [
  { id: 'grabberzone', name: 'Grabber', label: 'Grabber Zone' },
  { id: 'ithinkilikeyou', name: 'IThinkILikeYou', label: 'I Think I Like You' },
  { id: 'mangatellers', name: 'Mangatellers', label: 'Mangatellers' },
] as const;
type ComicProvider = typeof KOTATSU_COMIC_SOURCES[number]['id'];

export function isKotatsuComicSource(id: string): id is ComicProvider {
  return KOTATSU_COMIC_SOURCES.some((source) => source.id === id);
}

const grabber = 'https://grabber.zone';
const think = 'https://ithinkilikeyou.net';
const grabberSeries = /^\/comics\/[\w-]+\/$/;
const grabberIssue = /^\/comics\/[\w-]+(?:\/[\w-]+){1,2}\/$/;
const grabberFeed = /^\/type\/fancomic\/(?:page\/\d+\/)?$/;
const thinkSeries = /^\/series\/i-think-i-like-you\/$/;
const thinkIssue = /^\/comic\/[\w-]+\/$/;
const uploadedImage = /^\/wp-content\/uploads\//;

function sourceUrl(raw: string | undefined, origin: string, path: RegExp): URL | undefined {
  if (!raw?.trim()) return;
  try {
    const url = new URL(raw.trim(), origin);
    if (url.origin === origin && !url.username && !url.password && path.test(url.pathname)) return url;
  } catch { /* Ignore malformed source links. */ }
}

function thinkImage(raw: string | undefined): string | undefined {
  for (const origin of ['https://syd.ithinkilikeyou.net', 'https://assets.ithinkilikeyou.net', think]) {
    const url = sourceUrl(raw, origin, uploadedImage);
    if (url) return url.href;
  }
}

function title(source: ComicProvider, url: string, name: string, poster?: string): SankaTitle {
  return {
    id: source + ':' + url, slug: url, sourceUrl: url, title: name, poster, source,
    kind: 'comic', comicType: 'Comic', genres: [], languages: ['en'],
  };
}

function chapter(id: string, name: string, url?: string): SankaChapter {
  return { id, slug: id, title: name, chapterPath: url, language: 'en' };
}

async function grabberCatalogPage(url: URL) {
  const $ = load(await fetchReadingPage('grabberzone', url.href));
  const items = $('.page-listing-item .page-item-detail').toArray().flatMap((card) => {
    const link = $(card).find('.post-title a').first();
    const series = sourceUrl(link.attr('href'), grabber, grabberSeries);
    const name = link.text().trim();
    if (!series || !name || /[\u0400-\u04ff]|\((?:spanish|japanese|chinese|persian|russian|portuguese)\)/i.test(name)) return [];
    const img = $(card).find('.item-thumb img').first();
    const poster = sourceUrl(img.attr('data-src') || img.attr('src'), grabber, uploadedImage);
    return [title('grabberzone', series.href, name, poster?.href)];
  });
  const next = sourceUrl($('.paging-navigation .nav-previous a').attr('href'), grabber, grabberFeed);
  return { items, next };
}

export async function kotatsuComicCatalog(source: ComicProvider, query: string, page: number, signal?: AbortSignal): Promise<SankaTitlesPage> {
  const term = query.toLowerCase();
  if (source === 'mangatellers') {
    const result = await extraKotatsuProviders.mangatellers.catalog(query, page);
    return {
      page, hasMore: result.hasMore, items: result.items.map((item) => title(source, item.url, item.title, item.coverNormal)),
    };
  }
  if (source === 'ithinkilikeyou') {
    const name = 'I Think I Like You';
    if (page !== 1 || !name.toLowerCase().includes(term)) return { page, items: [], hasMore: false };
    const $ = load(await fetchReadingPage(source, think + '/'));
    const card = $('#series-grid a.series-thumbnail').toArray().find((link) => sourceUrl($(link).attr('href'), think, thinkSeries));
    if (!card) throw new Error('I Think I Like You did not return its catalog.');
    const url = sourceUrl($(card).attr('href'), think, thinkSeries)!;
    return { page, items: [title(source, url.href, name, thinkImage($(card).find('img').attr('src')))], hasMore: false };
  }
  const first = new URL('/type/fancomic/' + (page > 1 ? 'page/' + page + '/' : ''), grabber);
  const result = await grabberCatalogPage(first);
  if (!term) return { page, items: result.items, hasMore: Boolean(result.next) };
  if (page > 1) return { page, items: [], hasMore: false };
  const items = [...result.items];
  const visited = new Set([first.href]);
  let next = result.next;
  while (next && !visited.has(next.href)) {
    signal?.throwIfAborted();
    visited.add(next.href);
    const more = await grabberCatalogPage(next);
    items.push(...more.items);
    next = more.next;
  }
  return { page, items: items.filter((item) => item.title.toLowerCase().includes(term)), hasMore: false };
}

export async function kotatsuComicDetail(source: ComicProvider, slug: string, page = 1): Promise<SankaMangaDetail> {
  if (source === 'mangatellers') {
    const chapters = await extraKotatsuProviders.mangatellers.chapters({
      id: slug, url: slug, title: '', type: 'Comic', coverNormal: '', coverSmall: '',
    });
    return { title: '', genres: [], chapters: chapters.map((entry) => chapter(entry.id, entry.name, entry.url)) };
  }
  const url = source === 'grabberzone' ? sourceUrl(slug, grabber, grabberSeries) : sourceUrl(slug, think, thinkSeries);
  if (!url) throw new Error('Invalid comic series.');
  if (source === 'ithinkilikeyou' && page > 1) url.searchParams.set('comics_paged', String(page));
  const $ = load(await fetchReadingPage(source, url.href));
  if (source === 'grabberzone') {
    const chapters = $('.listing-chapters_wrap li.wp-manga-chapter > a').toArray().flatMap((link) => {
      const issue = sourceUrl($(link).attr('href'), grabber, grabberIssue);
      const name = $(link).text().trim();
      return issue?.pathname.startsWith(url.pathname) && name ? [chapter(issue.href, name, issue.href)] : [];
    });
    return { title: '', genres: [], chapters };
  }
  const chapters = $('#comic-list > li').toArray().flatMap((row) => {
    const entry = $(row);
    const issue = sourceUrl(entry.find('> a').attr('href'), think, thinkIssue);
    if (!issue || issue.searchParams.get('sid') !== '61' || entry.find('img[src$="lockedTn.png"]').length) return [];
    const name = entry.find('.comic-title').text().trim();
    return name ? [chapter(issue.href, name, issue.href)] : [];
  });
  const next = sourceUrl($('nav.pagination a.next').attr('href'), think, thinkSeries);
  return {
    title: '', genres: [], chapters,
    nextChapterPage: Number(next?.searchParams.get('comics_paged')) === page + 1 ? page + 1 : undefined,
  };
}

export async function kotatsuComicPages(source: ComicProvider, slug: string, chapterPath?: string): Promise<string[]> {
  if (source === 'mangatellers') return extraKotatsuProviders.mangatellers.pages({ id: slug, url: chapterPath || '', name: '' });
  const url = source === 'grabberzone' ? sourceUrl(slug, grabber, grabberIssue) : sourceUrl(slug, think, thinkIssue);
  if (!url) throw new Error('Invalid comic chapter.');
  const $ = load(await fetchReadingPage(source, url.href));
  if (source === 'grabberzone') {
    return $('.reading-content .page-break img.wp-manga-chapter-img').toArray().flatMap((node) => {
      const img = $(node);
      const url = sourceUrl(img.attr('data-src') || img.attr('src'), grabber, /^\/wp-content\/uploads\/WP-manga\/data\//);
      return url ? [url.href] : [];
    });
  }
  const panels = $('#spliced-comic .default-lang img');
  return [...new Set((panels.length ? panels : $('#unspliced-comic .default-lang img')).toArray()
    .flatMap((node) => thinkImage($(node).attr('src')) || []))];
}
