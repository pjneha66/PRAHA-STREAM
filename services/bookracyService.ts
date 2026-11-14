import type { BookItem } from './archiveService';
import { nativeFetchText } from './androidBridge';
import { evictOldest } from './cacheCaps';

/**
 * Bookracy source (port of PlayTorrio's BookracyService): search across the
 * Bookracy ebook catalog with direct md5 download links. Third Books mode
 * alongside Open Library and archive.org.
 */

const BASE_URL = 'https://api.bookracy.com/api/books';
const HEADERS = {
  Accept: 'application/json',
  Origin: 'https://bookracy.com',
  Referer: 'https://bookracy.com/',
};

/** Formats Bookracy serves that our reader/download flow can use. */
const BLOCKED_FORMATS = new Set(['lit', 'lrf', 'djvu', 'rtf', 'doc', 'docx']);

interface BookracyResult {
  id?: number | string;
  title?: string;
  author?: string;
  md5?: string;
  link?: string;
  book_image?: string;
  external_cover_url?: string;
  book_filetype?: string;
  book_lang?: string;
  book_size?: string;
  year?: string;
  publisher?: string;
}

const resultCache = new Map<string, BookItem[]>();

export class BookracyService {
  /** Download link for a result: mirror-style md5 URL when no direct link. */
  static downloadUrl(md5: string, link?: string): string {
    if (link && link.startsWith('http')) return link;
    return `https://bookracy.com/md5/${md5}`;
  }

  static async search(query: string, page = 1, limit = 24, lang = 'en'): Promise<BookItem[]> {
    const cleanQuery = query.trim() || 'fantasy';
    const cacheKey = `${cleanQuery}|${lang}|${page}|${limit}`;
    const cached = resultCache.get(cacheKey);
    if (cached) return cached;

    const params = new URLSearchParams({
      query: cleanQuery,
      limit: String(limit),
      page: String(page),
    });
    if (lang && lang.toLowerCase() !== 'all') params.set('lang', lang.toLowerCase());

    let response: Awaited<ReturnType<typeof nativeFetchText>>;
    try {
      // Native fetch throws on network failure (DNS dead, refused) — surface
      // that as an honest offline error instead of a quiet "no books".
      response = await nativeFetchText(`${BASE_URL}?${params.toString()}`, {
        headers: HEADERS,
        timeoutMs: 15000,
      });
    } catch {
      throw new Error('Bookracy is offline right now — the API did not answer.');
    }
    try {
      if (!response.ok || !response.data) {
        throw new Error('Bookracy is offline right now — the API did not answer.');
      }
      const decoded = JSON.parse(response.data) as { results?: BookracyResult[] };
      if (!Array.isArray(decoded.results)) return [];

      const items: BookItem[] = [];
      const seenMd5 = new Set<string>();
      for (const entry of decoded.results) {
        const md5 = (entry.md5 || '').trim();
        const title = (entry.title || '').trim();
        const filetype = (entry.book_filetype || 'epub').toLowerCase();
        if (!title || !md5 || seenMd5.has(md5)) continue;
        if (BLOCKED_FORMATS.has(filetype)) continue;
        seenMd5.add(md5);
        items.push({
          id: `bookracy-${md5}`,
          title,
          authors: entry.author ? [entry.author.trim()] : [],
          year: entry.year || undefined,
          coverUrl: entry.book_image || entry.external_cover_url || undefined,
          identifier: undefined,
          openLibraryKey: undefined,
          source: 'archive',
          // Bookracy-specific fields ride on the archive shape:
          ...( {
            bookracyMd5: md5,
            bookracyFiletype: filetype,
            bookracySize: entry.book_size,
          } as Partial<BookItem> ),
        });
      }
      resultCache.set(cacheKey, items);
      evictOldest(resultCache, 40);
      return items;
    } catch (err) {
      // Surface the offline error to the UI; parse hiccups stay a quiet empty.
      if (err instanceof Error && err.message.includes('offline')) throw err;
      return [];
    }
  }

  /** Curated home categories (port of PlayTorrio's fetchFeaturedCategories). */
  static async featuredCategories(lang = 'en'): Promise<Array<{ label: string; items: BookItem[] }>> {
    const categories: Array<[string, string]> = [
      ['Popular Fiction', 'fiction'],
      ['Sci-Fi & Fantasy', 'fantasy'],
      ['Mystery & Thriller', 'thriller'],
      ['Science & History', 'history'],
      ['Bestsellers', 'novel'],
    ];
    const sections = await Promise.all(categories.map(async ([label, term]) => ({
      label,
      items: await BookracyService.search(term, 1, 20, lang).catch(() => [] as BookItem[]),
    })));
    return sections.filter((section) => section.items.length > 0);
  }
}
