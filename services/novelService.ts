import { load } from 'cheerio';
import { fetchReadingPage } from './readingRelay';

export const NOVEL_SOURCES = {
  readnovelfull: { label: 'ReadNovelFull', origin: 'https://readnovelfull.com', searchPath: '/novel-list/search' },
  novgo: { label: 'Novgo', origin: 'https://novgo.net', searchPath: '/search' },
} as const;

export type NovelSource = keyof typeof NOVEL_SOURCES;
export type Novel = { title: string; url: string; source: NovelSource };
export type NovelChapter = { title: string; url: string; source: NovelSource };

const novelPath = /^\/[\w-]+\.html$/;
const chapterPath = /^\/[\w-]+\/[\w-]+\.html$/;

function localPath(href: string | undefined, base: URL, allowed: RegExp) {
  try {
    const url = new URL(href || '', base);
    if (href && url.origin === base.origin && !url.username && !url.password && allowed.test(url.pathname)) return url.href;
  } catch { /* Invalid link. */ }
  return undefined;
}

export async function searchNovels(source: NovelSource, query: string, page: number) {
  const { origin, searchPath } = NOVEL_SOURCES[source];
  const url = new URL(query || page > 1 ? searchPath : '/', origin);
  if (query) url.searchParams.set('keyword', query);
  if (page > 1) url.searchParams.set('page', String(page));
  const $ = load(await fetchReadingPage(source, url.href));
  const items = new Map<string, Novel>();
  $('a[href$=".html"]').each((_, link) => {
    const title = $(link).text().trim();
    const target = localPath($(link).attr('href'), url, novelPath);
    if (title && target && !items.has(target)) items.set(target, { title, url: target, source });
  });
  return {
    items: [...items.values()],
    hasMore: $('.pagination a').toArray().some((link) => $(link).text().trim() === String(page + 1)),
  };
}

export async function loadNovelChapters(novel: Novel, page: number) {
  const { source } = novel;
  const base = new URL(novel.url);
  if (!localPath(base.href, new URL(NOVEL_SOURCES[source].origin), novelPath)) throw new Error('Invalid novel.');
  if (source === 'novgo' && page > 1) base.searchParams.set('page', String(page));
  const detail = load(await fetchReadingPage(source, base.href));
  const id = detail('[data-novel-id]').first().attr('data-novel-id');
  let $ = detail;
  if (source === 'readnovelfull' && id && /^\d+$/.test(id)) {
    const archive = new URL('/ajax/chapter-archive', base);
    archive.searchParams.set('novelId', id);
    try {
      const candidate = load(await fetchReadingPage(source, archive.href));
      if (candidate('.list-chapter a').length) $ = candidate;
    } catch { /* The detail page has an initial chapter list. */ }
  }
  const prefix = base.pathname.slice(0, -5) + '/';
  const chapters = new Map<string, NovelChapter>();
  $(source === 'novgo' ? '#idData a[href]' : '.list-chapter a[href]').each((_, link) => {
    const title = $(link).text().trim();
    const url = localPath($(link).attr('href'), base, chapterPath);
    if (title && url && new URL(url).pathname.startsWith(prefix)) chapters.set(url, { title, url, source });
  });
  return { items: [...chapters.values()], pageCount: source === 'novgo' ? Number(detail('#list-chapter').attr('data-total-page')) || 1 : 1 };
}

export async function loadNovelText(chapter: NovelChapter): Promise<string[]> {
  const { source } = chapter;
  const url = localPath(chapter.url, new URL(NOVEL_SOURCES[source].origin), chapterPath);
  if (!url) throw new Error('Invalid chapter.');
  const $ = load(await fetchReadingPage(source, url));
  const text = $(source === 'novgo' ? '#chapter-content' : '#chr-content').first();
  text.find('script, style, noscript, iframe, .ads, .advertisement').remove();
  text.find('br').replaceWith('\n');
  text.find('p, blockquote, h2, h3').after('\n\n');
  const paragraphs = text.text().split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (!paragraphs.length) throw new Error('This chapter has no readable text.');
  return paragraphs;
}
