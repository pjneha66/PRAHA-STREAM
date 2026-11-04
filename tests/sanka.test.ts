import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSankaCache, fetchSankaChapterImages, fetchSankaMangaDetail,
  fetchSankaTitles, fetchSankaTitlesPage, mapSankaMangaDetail, mapSankaTitles,
} from '../services/sankaService';

const respond = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
}) as unknown as Response;

describe('Sanka API adapter', () => {
  afterEach(() => {
    clearSankaCache();
    vi.unstubAllGlobals();
  });

  it('maps wrapped anime and comic entries across komikList, hotUpdates, latestUpdates, and animeList', () => {
    const anime = mapSankaTitles(
      { data: { ongoing: { animeList: [{ title: 'Frieren', poster: '/images/frieren.jpg', year: 2023, episodes: 8, genres: ['Fantasy', 'Adventure'] }] } } },
      'anime',
    );
    expect(anime).toHaveLength(1);
    expect(anime[0]).toMatchObject({ title: 'Frieren', year: '2023', chapter: 'Ep 8', genres: ['Fantasy', 'Adventure'], kind: 'anime' });
    expect(anime[0].poster).toBe('https://www.sankavollerei.web.id/images/frieren.jpg');

    const komikcast = mapSankaTitles(
      {
        success: true,
        data: {
          hotUpdates: [{ title: 'Tower of God', slug: 'tower-of-god', image: 'https://komikcast03.com/wp-content/uploads/tog.jpg', type: 'Manhwa', chapter: 'Ch. 620', rating: '8.8' }],
          latestReleases: [{ title: 'Nano Machine', slug: 'nano-machine', image: 'data:image/svg+xml;base64,PHN2Zz4=', data_src: 'https://komikcast03.com/wp-content/uploads/nano.jpg', chapters: [{ title: 'Ch. 215', slug: 'nano-215' }] }],
        },
      },
      'comic',
      'komikcast',
    );
    expect(komikcast).toHaveLength(2);
    expect(komikcast[0]).toMatchObject({ title: 'Tower of God', slug: 'tower-of-god', chapter: 'Ch. 620', source: 'komikcast' });
    expect(komikcast[1]).toMatchObject({
      title: 'Nano Machine',
      slug: 'nano-machine',
      poster: 'https://komikcast03.com/wp-content/uploads/nano.jpg',
      chapter: 'Ch. 215',
    });

    const komikuPustaka = mapSankaTitles(
      {
        results: [
          { title: 'Download Komiku APK', detailUrl: '/apk/', latestChapter: { title: 'Download Now' } },
          { title: 'Blue Period', thumbnail: 'https://img.komiku.org/lazy.jpg', detailUrl: '/detail-komik/blue-period/', latestChapter: { title: 'Chapter 68' } },
        ],
      },
      'comic',
      'komiku',
    );
    expect(komikuPustaka).toHaveLength(1);
    expect(komikuPustaka[0]).toMatchObject({
      title: 'Blue Period',
      slug: 'blue-period',
      detailPath: 'blue-period',
      poster: undefined,
      chapter: 'Chapter 68',
    });
  });

  it('uses verified provider routes for Komikcast (/home), Komikindo (/latest/1), BacaKomik (/populer), and Komiku (/terbaru)', async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/comic/homepage')) return respond({}, 404);
      if (url.endsWith('/comic/terbaru')) {
        return respond({ comics: [{ title: 'One Piece', link: '/manga/one-piece/', chapter: 'Chapter 1130', image: 'https://img.komiku.org/op.jpg' }] });
      }
      if (url.endsWith('/comic/komikcast/home')) {
        return respond({ success: true, data: { hotUpdates: [{ title: 'Eleceed', slug: 'eleceed', image: 'https://img.example/eleceed.jpg' }] } });
      }
      if (url.endsWith('/comic/komikindo/latest/2')) {
        return respond({ success: true, hasNextPage: false, komikList: [{ title: 'Sakamoto Days', slug: 'sakamoto-days', image: 'https://img.example/sd.jpg' }] });
      }
      return respond({ komikList: [{ title: 'Dandadan', slug: 'dandadan' }], hasNextPage: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const searchRes = await fetchSankaTitles('comic', 'Dandadan', 'kiryuu');
    await fetchSankaTitles('comic', '', 'bacakomik', 'popular');
    const komikuLatest = await fetchSankaTitles('comic', '', 'komiku', 'latest');
    const komikcastHome = await fetchSankaTitles('comic', '', 'komikcast', 'latest');
    const komikindoPage2 = await fetchSankaTitlesPage('comic', { source: 'komikindo', feed: 'latest', page: 2 });

    expect(requests[0]).toContain('/comic/kiryuu/search/Dandadan');
    expect(requests[1]).toContain('/comic/bacakomik/populer');
    expect(requests[2]).toContain('/comic/homepage');
    expect(requests[3]).toContain('/comic/terbaru');
    expect(requests.some((u) => u.endsWith('/comic/komikcast/home'))).toBe(true);
    expect(requests.some((u) => u.endsWith('/comic/komikindo/latest/2'))).toBe(true);
    expect(searchRes[0]).toMatchObject({ title: 'Dandadan', source: 'kiryuu', slug: 'dandadan' });
    expect(komikuLatest[0]).toMatchObject({ title: 'One Piece', source: 'komiku', slug: 'one-piece' });
    expect(komikcastHome[0]).toMatchObject({ title: 'Eleceed', source: 'komikcast', slug: 'eleceed' });
    expect(komikindoPage2).toMatchObject({ page: 2, hasMore: false, items: [expect.objectContaining({ title: 'Sakamoto Days' })] });
  });

  it('uses the documented anime home, paginated ongoing, and source search endpoints', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return respond({ data: { ongoing: { animeList: [{ title: 'Dandadan' }] } }, hasNextPage: true });
    }));
    await fetchSankaTitles('anime');
    await fetchSankaTitlesPage('anime', { source: 'otakudesu', page: 2 });
    await fetchSankaTitles('anime', 'Dandadan', 'samehadaku');
    expect(requests[0]).toContain('/anime/home');
    expect(requests[1]).toContain('/anime/ongoing-anime?page=2');
    expect(requests[2]).toContain('/anime/samehadaku/search/Dandadan');
  });

  it('maps BacaKomik detail.chapters and Shinigami split chapters/read endpoints', async () => {
    const bacakomikDetail = mapSankaMangaDetail(
      {
        detail: {
          title: 'Blue Period',
          synopsis: 'A young artist.',
          genres: [{ title: 'Drama', slug: 'drama' }],
          chapters: [
            { slug: 'blue-period-chapter-2' },
            { title: 'Chapter 1', slug: 'blue-period-chapter-1' },
          ],
        },
      },
      'bacakomik',
    );
    expect(bacakomikDetail.title).toBe('Blue Period');
    expect(bacakomikDetail.genres).toEqual(['Drama']);
    expect(bacakomikDetail.chapters.map((ch) => ({ title: ch.title, slug: ch.slug }))).toEqual([
      { title: 'Chapter 2', slug: 'blue-period-chapter-2' },
      { title: 'Chapter 1', slug: 'blue-period-chapter-1' },
    ]);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/comic/shinigami/detail/solo-id')) {
        return respond({ data: { manga_id: 'solo-id', title: 'Solo Leveling', cover_portrait: 'https://cdn.example/solo.jpg', description: 'Hunter story.' } });
      }
      if (url.includes('/comic/shinigami/manga/solo-id') || url.includes('/comic/shinigami/comic/solo-id')) {
        return respond({}, 404);
      }
      if (url.includes('/comic/shinigami/chapters/solo-id')) {
        return respond({ data: { chapters: [{ chapter_id: 'ch-uuid-1', chapter_number: 1, upload_date: 'Today' }] } });
      }
      if (url.includes('/comic/shinigami/read/ch-uuid-1')) {
        return respond({ data: { chapter_title: 'Chapter 1', images: ['https://cdn.example/page-1.jpg', 'https://cdn.example/page-2.jpg'] } });
      }
      return respond({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const shinigamiDetail = await fetchSankaMangaDetail('shinigami', 'solo-id');
    expect(shinigamiDetail.chapters).toHaveLength(1);
    expect(shinigamiDetail.chapters[0]).toMatchObject({ slug: 'ch-uuid-1', title: 'Chapter 1' });
    const pages = await fetchSankaChapterImages('shinigami', shinigamiDetail.chapters[0].slug);
    expect(pages).toEqual(['https://cdn.example/page-1.jpg', 'https://cdn.example/page-2.jpg']);
  });

  it('reports upstream HTTP errors when all candidate routes fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ error: 'unavailable' }, 503)));
    await expect(fetchSankaTitles('comic')).rejects.toThrow('Sanka API returned 503');
  });
});
