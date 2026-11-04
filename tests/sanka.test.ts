import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSankaChapterImages, fetchSankaMangaDetail, fetchSankaTitles, mapSankaMangaDetail, mapSankaTitles } from '../services/sankaService';

const respond = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
}) as unknown as Response;

describe('Sanka API adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps wrapped anime and comic entries into safe catalog cards', () => {
    const anime = mapSankaTitles({ data: { anime: [{ title: 'Frieren', poster: '/images/frieren.jpg', year: 2023, genres: ['Fantasy', 'Adventure'] }] } }, 'anime');
    expect(anime).toHaveLength(1);
    expect(anime[0]).toMatchObject({ title: 'Frieren', year: '2023', genres: ['Fantasy', 'Adventure'], kind: 'anime' });
    expect(anime[0].poster).toBe('https://www.sankavollerei.web.id/images/frieren.jpg');

    const comics = mapSankaTitles([{ name: 'Blue Period', cover_url: 'https://images.example/blue.jpg', synopsis: 'An art student finds his path.' }], 'comic');
    expect(comics[0]).toMatchObject({ title: 'Blue Period', summary: 'An art student finds his path.', kind: 'comic' });
  });

  it('uses source-specific comic search and feed endpoints', async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return respond({ data: [{ title: 'Dandadan', slug: 'dandadan' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await fetchSankaTitles('comic', 'Dandadan', 'kiryuu');
    await fetchSankaTitles('comic', '', 'kiryuu', 'popular');
    await fetchSankaTitles('comic', '', 'komiku', 'latest');
    expect(requests[0]).toContain('/comic/kiryuu/search/Dandadan');
    expect(requests[1]).toContain('/comic/kiryuu/popular');
    expect(requests[2]).toContain('/comic/homepage');
    expect(results[0]).toMatchObject({ title: 'Dandadan', source: 'kiryuu', slug: 'dandadan' });
  });

  it('uses the documented anime home and source search endpoints', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return respond({ data: [{ title: 'Dandadan' }] });
    }));
    await fetchSankaTitles('anime');
    await fetchSankaTitles('anime', 'Dandadan', 'samehadaku');
    expect(requests[0]).toContain('/anime/home');
    expect(requests[1]).toContain('/anime/samehadaku/search/Dandadan');
  });

  it('maps manga chapters and reads their page-image URLs from source endpoints', async () => {
    const detail = mapSankaMangaDetail({ data: { title: 'Blue Period', synopsis: 'A young artist.', chapters: [{ title: 'Chapter 1', slug: 'blue-period-1' }, { chapter: 'Chapter 2', url: '/comic/komiku/chapter/blue-period-2' }] } }, 'komiku');
    expect(detail.title).toBe('Blue Period');
    expect(detail.chapters.map((chapter) => chapter.slug)).toEqual(['blue-period-1', 'blue-period-2']);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/manga/')) return respond({ data: { title: 'Blue Period', chapters: [{ title: 'Chapter 1', slug: 'blue-period-1' }] } });
      return respond({ data: { images: ['https://cdn.example/page-1.jpg', 'https://cdn.example/page-2.jpg'] } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fetchedDetail = await fetchSankaMangaDetail('komiku', 'blue-period');
    const pages = await fetchSankaChapterImages('komiku', fetchedDetail.chapters[0].slug);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/comic/komiku/manga/blue-period');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/comic/komiku/chapter/blue-period-1');
    expect(pages).toEqual(['https://cdn.example/page-1.jpg', 'https://cdn.example/page-2.jpg']);
  });

  it('reports upstream HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ error: 'unavailable' }, 503)));
    await expect(fetchSankaTitles('comic')).rejects.toThrow('Sanka API returned 503');
  });
});
