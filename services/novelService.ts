import { load } from 'cheerio';
import { fetchReadingPage } from './readingRelay';

export const NOVEL_SOURCES = {
  readnovelfull: { label: 'ReadNovelFull', origin: 'https://readnovelfull.com', searchPath: '/novel-list/search' },
  wanderinginn: { label: 'The Wandering Inn', origin: 'https://wanderinginn.com', searchPath: '/table-of-contents/' },
  standardebooks: { label: 'Standard Ebooks', origin: 'https://standardebooks.org', searchPath: '/ebooks' },
  novgo: { label: 'Novgo', origin: 'https://novgo.net', searchPath: '/search' },
} as const;

export type NovelSource = keyof typeof NOVEL_SOURCES;
export type Novel = { title: string; url: string; source: NovelSource; cover?: string; author?: string };
export type NovelChapter = { title: string; url: string; source: NovelSource };

const standardBookPath = /^\/ebooks\/[\w-]+\/[\w-]+(?:\/[\w-]+)?$/;
const standardChapterPath = /^\/ebooks\/[\w-]+\/[\w-]+(?:\/[\w-]+)?\/text\/[\w-]+$/;
const innChapterPath = /^\/\d{4}\/\d{2}\/\d{2}\/[\w-]+\/$/;

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
  if (source === 'wanderinginn') {
    const matches = query.toLowerCase().trim().split(/\s+/).every((word) => "the wandering inn pirateaba".includes(word));
    const item: Novel = {
      title: 'The Wandering Inn', url: origin + searchPath, source, author: 'pirateaba',
      cover: origin + '/wp-content/uploads/2026/03/WanderingInn_Series_rev3-683x1024.jpg',
    };
    return { items: page === 1 && matches ? [item] : [], hasMore: false };
  }
  if (source === 'standardebooks') {
    const url = new URL(searchPath, origin);
    if (query) url.searchParams.set('query', query);
    if (page > 1) url.searchParams.set('page', String(page));
    const $ = load(await fetchReadingPage(source, url.href));
    const items = new Map<string, Novel>();
    $('main [typeof="schema:Book"] a[property="schema:url"]').each((_, link) => {
      const href = localPath($(link).attr('href'), url, standardBookPath);
      const title = $(link).text().trim();
      if (!href || !title) return;
      const book = $(link).closest('[typeof="schema:Book"]');
      const cover = localPath(book.find('img[property="schema:image"]').attr('src'), url, /^\/images\/covers\//);
      const author = book.find('[property="schema:author"]').text().trim();
      items.set(href, { title, url: href, source, cover, author });
    });
    return { items: [...items.values()], hasMore: $('a[rel="next"]').length > 0 };
  }
  const url = new URL(query || page > 1 ? searchPath : '/', origin);
  if (query) url.searchParams.set('keyword', query);
  if (page > 1) url.searchParams.set('page', String(page));
  const $ = load(await fetchReadingPage(source, url.href));
  const items = new Map<string, Novel>();
  const covers = new Map<string, string>();
  const imageBase = source === 'readnovelfull' ? new URL('https://img.readnovelfull.com') : url;
  const imagePath = source === 'readnovelfull' ? /^\/thumb\// : /^\/uploads\//;
  $('a[href$=".html"]').each((_, link) => {
    const anchor = $(link);
    const target = localPath(anchor.attr('href'), url, novelPath);
    if (!target) return;
    const title = anchor.text().trim();
    const img = anchor.find('img').first();
    const raw = img.attr('data-src') || img.attr('src');
    const cover = localPath(raw, imageBase, imagePath);
    if (cover) covers.set(target, cover);
    if (title && !items.has(target)) items.set(target, { title, url: target, source });
  });
  return {
    items: [...items.values()].map((item) => ({ ...item, cover: covers.get(item.url) })),
    hasMore: $('.pagination a').toArray().some((link) => $(link).text().trim() === String(page + 1)),
  };
}

export async function loadNovelChapters(novel: Novel, page: number) {
  const { source } = novel;
  const base = new URL(novel.url);
  if (source === 'wanderinginn' || source === 'standardebooks') {
    const origin = new URL(NOVEL_SOURCES[source].origin);
    const isInn = source === 'wanderinginn';
    const path = isInn ? /^\/table-of-contents\/$/ : standardBookPath;
    if (!localPath(base.href, origin, path)) throw new Error('Invalid novel.');
    const toc = new URL(isInn ? base.pathname : base.pathname + '/text', origin);
    const $ = load(await fetchReadingPage(source, toc.href));
    const items = new Map<string, NovelChapter>();
    $(isInn ? '.chapter-entry a[href]' : 'main nav a[href], main ol a[href]').each((_, link) => {
      const url = localPath($(link).attr('href'), toc, isInn ? innChapterPath : standardChapterPath);
      const title = $(link).text().trim().replace(/\s+/g, ' ');
      if (url && title && !items.has(url) && (isInn || new URL(url).pathname.startsWith(toc.pathname + '/'))) {
        items.set(url, { title, url, source });
      }
    });
    return { items: [...items.values()], pageCount: 1 };
  }
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
  const url = localPath(chapter.url, new URL(NOVEL_SOURCES[source].origin),
    source === 'wanderinginn' ? innChapterPath : source === 'standardebooks' ? standardChapterPath : chapterPath);
  if (!url) throw new Error('Invalid chapter.');
  const $ = load(await fetchReadingPage(source, url));
  const selector = {
    novgo: '#chapter-content', readnovelfull: '#chr-content', wanderinginn: '#reader-content', standardebooks: 'main',
  }[source];
  const text = $(selector).first();
  if (source === 'wanderinginn' && text.find('.patreon-protected-post').length) {
    throw new Error('The publisher requires a subscription for this chapter.');
  }
  text.find('script, style, noscript, iframe, .ads, .advertisement').remove();
  text.find('br').replaceWith('\n');
  text.find('p, blockquote, h2, h3').after('\n\n');
  const paragraphs = text.text().split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (!paragraphs.length) throw new Error('This chapter has no readable text.');
  return paragraphs;
}
