import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaItem } from '../types';

/**
 * End-to-end data flow for the Anime tab with recorded AniCore / Anikura / IMDx
 * payload shapes (captured from the live public APIs). No network is used.
 */

const ANICORE_ITEM = {
  id: 46474,
  slug: 'sousou-no-frieren',
  title: 'Sousou no Frieren',
  titleEnglish: 'Frieren: Beyond Journey’s End',
  format: 'TV',
  status: 'FINISHED',
  season: 'FALL',
  seasonYear: 2023,
  episodeCount: 28,
  durationMinutes: 24,
  images: { poster: 'https://media.kitsu.app/anime/46474/poster.jpg', banner: 'https://s4.anilist.co/banner.jpg', logo: null },
  trailer: { youtubeId: 'qgQunxD0qCk', url: 'https://www.youtube.com/watch?v=qgQunxD0qCk' },
  scores: { average: 91.7, anilist: 91, mal: 9.24, malRank: 1 },
  sources: ['kitsu', 'tvdb', 'tmdb', 'anilist', 'mal'],
  externalIds: { mal: 52991, anilist: 154587, kitsu: 46474, tvdb: 424536, tmdb: 209867 },
  genres: [{ name: 'Adventure' }, { name: 'Fantasy' }, { name: 'Drama' }],
  studios: [{ name: 'Madhouse' }],
};

const ANICORE_DETAIL = {
  ...ANICORE_ITEM,
  synopsis: 'An elf mage learns what living is all about.',
  externalIds: { ...ANICORE_ITEM.externalIds, imdb: 'tt22248376' },
  contentRating: 'pg_13',
};

const EPISODES = {
  pageInfo: { page: 1, perPage: 2, total: 28, hasNextPage: false },
  items: [
    { id: 256471, number: 1, seasonNumber: 1, title: 'The Journey’s End', synopsis: 'After the demon king falls…', airDate: '2023-09-29', runtimeMinutes: 24, thumbnail: 'https://img/ep1.jpg' },
    { id: 256472, number: 2, seasonNumber: 1, title: 'It Didn’t Have to Be Magic', synopsis: 'Fern trains.', airDate: '2023-09-29', runtimeMinutes: 24, thumbnail: 'https://img/ep2.jpg' },
  ],
};

const respond = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
}) as unknown as Response;

function mockProviders(requested: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/v1/anime/sousou-no-frieren/episodes')) return respond(EPISODES);
    if (url.includes('/v1/anime/sousou-no-frieren/characters')) {
      return respond({ items: [{ id: 5282, name: 'Frieren', role: 'MAIN', image: 'https://img/char.jpg', voiceActors: [{ name: 'Atsumi Tanezaki', image: 'https://img/va.jpg', language: 'Japanese' }] }] });
    }
    if (url.includes('/v1/anime/sousou-no-frieren/recommendations')) {
      return respond({ items: [{ anime: { ...ANICORE_ITEM, id: 12230, slug: 'violet-evergarden', title: 'Violet Evergarden', titleEnglish: 'Violet Evergarden' } }] });
    }
    if (url.includes('/v1/anime/sousou-no-frieren')) return respond(ANICORE_DETAIL);
    if (url.includes('/v1/anime?') && url.includes('search=')) {
      return respond({ pageInfo: { page: 1, perPage: 8, total: 1, hasNextPage: false }, items: [ANICORE_ITEM] });
    }
    if (url.includes('/v1/anime?')) return respond({ pageInfo: { page: 1, perPage: 24, total: 1, hasNextPage: false }, items: [ANICORE_ITEM] });
    if (url.includes('anikura.club/api/v1/catalog')) {
      return respond({ ok: true, data: { id: 1, title: 'Frieren', ids: { anikura: 1, mal: 52991 }, url: 'https://anikura.club/anime/1/frieren', episode_count: 28 } });
    }
    if (url.includes('anikura.club/api/v1/comments')) {
      return respond({ ok: true, series: { id: 1, watch_url: 'https://anikura.club/watch/1?ep=1' }, page: { total: 1 }, comments: [{ id: 'c1', body: 'Great episode', like_count: 3, author: { name: 'fern', avatar: 'https://img/a.png' } }] });
    }
    if (url.includes('api.tiffara.com/search/titles')) {
      return respond({ titles: [{ id: 'tt22248376', type: 'tvSeries', primaryTitle: 'Frieren: Beyond Journey’s End', primaryImage: { url: 'https://img/imdb.jpg' }, startYear: 2023, rating: { aggregateRating: 8.9 } }] });
    }
    if (url.includes('api.tiffara.com/titles/tt22248376/seasons')) return respond({ seasons: [{ season: '1', episodeCount: 28 }, { season: '2', episodeCount: 10 }] });
    if (url.includes('api.tiffara.com/titles/tt22248376/episodes')) return respond({ episodes: [{ id: 'tt1', title: 'IMDb episode', season: '1', episodeNumber: 1, runtimeSeconds: 1440 }] });
    if (url.includes('api.tiffara.com/titles/tt22248376')) {
      return respond({ id: 'tt22248376', type: 'tvSeries', primaryTitle: 'Frieren: Beyond Journey’s End', plot: 'IMDb plot', primaryImage: { url: 'https://img/imdb.jpg' }, startYear: 2023, runtimeSeconds: 1500, genres: ['Animation', 'Fantasy'], rating: { aggregateRating: 8.9 }, directors: [{ id: 'nm1', displayName: 'Keiichirô Saitô' }], stars: [{ id: 'nm2', displayName: 'Atsumi Tanezaki' }] });
    }
    return respond({ error: 'not_found' }, 404);
  }));
}

describe('Anime tab data flow', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('loads every Anime tab row set from AniCore', async () => {
    const requested: string[] = [];
    mockProviders(requested);
    const { animeService, clearAnimeCache } = await import('../services/animeService');
    clearAnimeCache();

    const [trending, topRated, season, airing, movies, browse] = await Promise.all([
      animeService.trending(),
      animeService.topRated(),
      animeService.thisSeason(),
      animeService.airing(),
      animeService.movies(),
      animeService.browse({ page: 2, format: 'TV', minScore: 80 }),
    ]);

    expect(trending[0].title).toBe('Frieren: Beyond Journey’s End');
    expect(topRated).toHaveLength(1);
    expect(season).toHaveLength(1);
    expect(airing).toHaveLength(1);
    expect(movies).toHaveLength(1);
    expect(browse.hasMore).toBe(false);
    expect(requested.some((url) => url.includes('sort=trending'))).toBe(true);
    expect(requested.some((url) => url.includes('sort=score'))).toBe(true);
    expect(requested.some((url) => url.includes('status=RELEASING'))).toBe(true);
    expect(requested.some((url) => url.includes('format=MOVIE'))).toBe(true);
    expect(requested.some((url) => url.includes('page=2') && url.includes('format=TV') && url.includes('minScore=80'))).toBe(true);
  });

  it('enriches an anime item with IMDb id, cast, seasons and recommendations', async () => {
    const requested: string[] = [];
    mockProviders(requested);
    const { animeService, clearAnimeCache } = await import('../services/animeService');
    clearAnimeCache();

    const listItem: MediaItem = {
      id: 'anicore:sousou-no-frieren',
      type: 'series',
      title: 'Sousou no Frieren',
      overview: '',
      poster: 'https://img/p.jpg',
      genres: ['Fantasy'],
      source: 'anicore',
      anime: { slug: 'sousou-no-frieren' },
    };

    const enriched = await animeService.enrich(listItem);
    expect(enriched.title).toBe('Frieren: Beyond Journey’s End');
    expect(enriched.imdbId).toBe('tt22248376');
    expect(enriched.tmdbId).toBe(209867);
    expect(enriched.overview).toContain('elf mage');
    expect(enriched.anime?.malId).toBe(52991);
    expect(enriched.anime?.episodeCount).toBe(2);
    expect(enriched.seasons).toEqual([{ id: 1, seasonNumber: 1, name: 'Season 1', episodeCount: 2 }]);
    expect(enriched.cast?.[0]).toMatchObject({ name: 'Atsumi Tanezaki', character: 'Frieren' });
    expect(enriched.recommendations?.[0].title).toBe('Violet Evergarden');
    expect(enriched.maturity).toBe('PG_13');
  });

  it('matches an unrelated TMDB item to AniCore so discussions work outside the Anime tab', async () => {
    mockProviders([]);
    const { animeService, clearAnimeCache } = await import('../services/animeService');
    clearAnimeCache();

    const tmdbItem: MediaItem = {
      id: 'tmdb:209867',
      tmdbId: 209867,
      type: 'series',
      title: 'Sousou no Frieren',
      overview: 'From TMDB',
      poster: 'https://img/tmdb.jpg',
      year: '2023',
      genres: ['Animation'],
      source: 'tmdb',
    };
    const match = await animeService.findForMedia(tmdbItem);
    expect(match?.anime?.malId).toBe(52991);

    const noMatch = await animeService.findForMedia({ ...tmdbItem, title: 'Unrelated Title', year: '1954', tmdbId: 1 });
    expect(noMatch).toBeNull();
  });

  it('reads Anikura catalog records and episode comments for that title', async () => {
    mockProviders([]);
    const { anikuraService, anikuraIds, clearAnimeCache } = await import('../services/animeService');
    clearAnimeCache();

    const item: MediaItem = {
      id: 'anicore:sousou-no-frieren',
      type: 'series',
      title: 'Frieren',
      overview: '',
      poster: '',
      genres: [],
      source: 'anicore',
      anime: { slug: 'sousou-no-frieren', malId: 52991, anilistId: 154587 },
    };

    const catalog = await anikuraService.getCatalog(anikuraIds(item));
    expect(catalog?.episode_count).toBe(28);

    const discussion = await anikuraService.getComments(anikuraIds(item), 1, { limit: 12 });
    expect(discussion.comments[0].body).toBe('Great episode');
    expect(discussion.total).toBe(1);
  });

  it('uses IMDx for anime search, title enrichment and season data', async () => {
    mockProviders([]);
    const { imdxService } = await import('../services/imdxService');
    const settings = { enabled: true, baseUrl: 'https://api.tiffara.com', apiKey: '' };

    const results = await imdxService.search('frieren', settings);
    expect(results[0].imdbId).toBe('tt22248376');

    const enriched = await imdxService.enrich(
      { id: 'imdx:tt22248376', imdbId: 'tt22248376', type: 'series', title: 'Frieren', overview: '', poster: '', genres: [], source: 'imdx' },
      settings,
    );
    expect(enriched.overview).toBe('IMDb plot');
    expect(enriched.director).toBe('Keiichirô Saitô');
    expect(enriched.cast?.[0].name).toBe('Atsumi Tanezaki');
    expect(enriched.seasons).toEqual([
      { id: 1, seasonNumber: 1, name: 'Season 1', episodeCount: 28 },
      { id: 2, seasonNumber: 2, name: 'Season 2', episodeCount: 10 },
    ]);
  });
});
