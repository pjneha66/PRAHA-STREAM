import { nativeFetchText } from './androidBridge';

const BASE_URL = 'https://weebcentral.com';
const COVER_CDN = 'https://temp.compsci88.com/cover';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface MangaItem {
  id: string;
  title: string;
  coverSmall: string;
  coverNormal: string;
  type: string;
  status?: string;
  author?: string;
  year?: string;
  tags?: string[];
  synopsis?: string;
  url: string;
}

export interface MangaChapter {
  id: string;
  name: string;
  url: string;
  chapterNumber?: number;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await nativeFetchText(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeoutMs: 12000,
  });
  return res.data || '';
}

function extractSeriesId(url: string): string | null {
  const match = url.match(/\/series\/([A-Z0-9]{26})/i);
  return match ? match[1] : null;
}

function extractChapterId(url: string): string | null {
  const match = url.match(/\/chapters\/([A-Z0-9]{26})/i);
  return match ? match[1] : null;
}

export class MangaService {
  /**
   * Fetches popular manga from WeebCentral.
   */
  static async getManga(page = 1, tag?: string): Promise<MangaItem[]> {
    try {
      const offset = (page - 1) * 32;
      let url = `${BASE_URL}/search/data?text=&display_mode=Full+Display&sort=Popularity&order=Descending&official=Any&adult=False&offset=${offset}`;
      if (tag) {
        url += `&included_tag=${encodeURIComponent(tag)}`;
      }
      const html = await fetchHtml(url);
      return this.parseSearchResults(html);
    } catch {
      return [];
    }
  }

  /**
   * Searches manga titles on WeebCentral.
   */
  static async searchManga(query: string, page = 1): Promise<MangaItem[]> {
    try {
      const offset = (page - 1) * 32;
      const url = `${BASE_URL}/search/data?text=${encodeURIComponent(query)}&display_mode=Full+Display&sort=Best+Match&order=Descending&official=Any&adult=False&offset=${offset}`;
      const html = await fetchHtml(url);
      return this.parseSearchResults(html);
    } catch {
      return [];
    }
  }

  private static parseSearchResults(html: string): MangaItem[] {
    const results: MangaItem[] = [];
    const articleRegex = /<article[\s\S]*?<\/article>/gi;
    let match: RegExpExecArray | null;

    while ((match = articleRegex.exec(html)) !== null) {
      const article = match[0];
      const seriesLinkMatch = article.match(/href="([^"]*\/series\/[A-Z0-9]{26}[^"]*)"/i);
      if (!seriesLinkMatch) continue;

      const href = seriesLinkMatch[1];
      const seriesId = extractSeriesId(href);
      if (!seriesId) continue;

      let title = '';
      const titleMatch = article.match(/class="[^"]*(?:line-clamp-1|link-hover)[^"]*"[^>]*>([^<]+)<\/a>/i);
      if (titleMatch && titleMatch[1].trim()) {
        title = titleMatch[1].trim();
      } else {
        const altMatch = article.match(/alt="([^"]+)"/i);
        if (altMatch) {
          title = altMatch[1].replace(/\s+cover$/i, '').trim();
        }
      }

      if (!title) {
        title = 'Manga Series';
      }

      let type = 'Manga';
      const tipMatch = article.match(/data-tip="(Manga|Manhwa|Manhua|OEL)"/i);
      if (tipMatch) type = tipMatch[1];

      results.push({
        id: seriesId,
        title: title.replace(/^Official\s+/i, '').trim(),
        coverSmall: `${COVER_CDN}/small/${seriesId}.webp`,
        coverNormal: `${COVER_CDN}/normal/${seriesId}.webp`,
        type,
        url: href,
      });
    }
    return results;
  }

  /**
   * Fetches metadata for a single manga series.
   */
  static async getSeriesDetail(seriesId: string): Promise<MangaItem> {
    const html = await fetchHtml(`${BASE_URL}/series/${seriesId}`);
    let title = '';
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) title = h1Match[1].trim();
    if (!title) {
      const ogMatch = html.match(/property="og:title"\s+content="([^"]+)"/i);
      if (ogMatch) title = ogMatch[1].replace(/\s*-\s*Weeb\s*Central.*$/i, '').trim();
    }

    const descMatch = html.match(/class="[^"]*whitespace-pre-wrap[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const synopsis = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const authorMatch = html.match(/Author(?:s)?(?:\s*:\s*|\s*<\/strong>\s*)([\s\S]*?)<\/(?:li|div)/i);
    const author = authorMatch ? authorMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    return {
      id: seriesId,
      title: title.replace(/^Official\s+/i, '').trim() || 'Manga Series',
      coverSmall: `${COVER_CDN}/small/${seriesId}.webp`,
      coverNormal: `${COVER_CDN}/normal/${seriesId}.webp`,
      type: 'Manga',
      author,
      synopsis,
      url: `/series/${seriesId}`,
    };
  }

  /**
   * Fetches all chapter entries for a series.
   */
  static async getChapters(seriesId: string): Promise<MangaChapter[]> {
    try {
      const html = await fetchHtml(`${BASE_URL}/series/${seriesId}/full-chapter-list`);
      const chapters: MangaChapter[] = [];
      const linkRegex = /<a[^>]*href="([^"]*\/chapters\/([A-Z0-9]{26})[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;

      while ((m = linkRegex.exec(html)) !== null) {
        const href = m[1];
        const chapterId = m[2];
        const inner = m[3];

        let chapterName = '';
        const spanMatch = inner.match(/<span[^>]*>([^<]+)<\/span>/i);
        if (spanMatch && spanMatch[1].trim()) {
          chapterName = spanMatch[1].trim();
        } else {
          chapterName = inner.replace(/<[^>]+>/g, '').replace(/Last Read/gi, '').trim();
        }

        const numMatch = chapterName.match(/(?:Chapter|Ch\.?)\s*(\d+(?:\.\d+)?)/i);
        const chapterNumber = numMatch ? parseFloat(numMatch[1]) : undefined;

        chapters.push({
          id: chapterId,
          name: chapterName || `Chapter ${chapters.length + 1}`,
          url: href,
          chapterNumber,
        });
      }
      return chapters;
    } catch {
      return [];
    }
  }

  /**
   * Fetches direct image URLs for a chapter (long strip reader format).
   */
  static async getChapterImages(chapterId: string): Promise<string[]> {
    try {
      const url = `${BASE_URL}/chapters/${chapterId}/images?is_prev=False&current_page=1&reading_style=long_strip`;
      const html = await fetchHtml(url);
      const images: string[] = [];
      const imgRegex = /<img[^>]*src="([^"]+)"/gi;
      let m: RegExpExecArray | null;

      while ((m = imgRegex.exec(html)) !== null) {
        const src = m[1];
        if (src && !src.includes('/static/') && !src.includes('brand') && !src.includes('logo')) {
          images.push(src);
        }
      }
      return images;
    } catch {
      return [];
    }
  }
}

