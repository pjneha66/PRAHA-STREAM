// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ruleScraperBrowse, ruleScraperCatalogs, ruleScraperEpisodes, ruleScraperSearch,
  ruleScraperStreams, ruleScraperStreamsFor, splitSel, toRuleStreams,
  type RuleScraperConfig, type RuleScraperTitle,
} from '../services/ruleScraper';

vi.mock('../services/androidBridge', async (loadActual) => ({
  ...(await loadActual<typeof import('../services/androidBridge')>()),
  nativeFetchText: vi.fn(),
}));

import { nativeFetchText } from '../services/androidBridge';

const LIST_HTML = `
<html><body>
  <div class="item"><a href="/watch/one"><span class="title">Title One</span><img src="/p1.jpg"/></a></div>
  <div class="item"><a href="https://cdn.example.org/watch/two"><span class="title">Title Two</span></a></div>
</body></html>`;

const DETAIL_HTML = `
<html><body><h1>Detail Title</h1>
  <div class="poster"><img src="/big.jpg"/></div>
  <p class="desc">A story.</p>
</body></html>`;

const EPISODES_HTML = `
<html><body>
  <div class="episode"><a href="/watch/one/ep/2">Ep 02</a></div>
  <div class="episode"><a href="/watch/one/ep/1">Pilot</a></div>
  <div class="episode"><a href="/watch/one/ep/2b">Duplicate</a></div>
</body></html>`;

const STREAMS_HTML = `
<html><body>
  <video src="/direct.mp4"></video>
  <source type="video/m3u8" src="/list.m3u8"/>
  <iframe src="https://cdn.example.net/embed/1"></iframe>
</body></html>`;

const EMBED_HTML = `
<html><body><video src="https://cdn.example.net/embed/video.mp4"></video></body></html>`;

const IMAGE_HTML = `
<html><body>
  <img class="page" data-src="/pages/1.jpg"/>
  <img class="page" src="/pages/2.jpg"/>
  <img class="page" src="data:inlinegif"/>
</body></html>`;

const htmlConfig: RuleScraperConfig = {
  name: 'TestSite',
  baseUrl: 'https://example.org',
  homeUrl: '/',
  catalogUrl: '/home',
  search: { url: '/search?q={query}&p={page}', item: '.item', title: '.title', href: 'a@href', poster: 'img@src' },
  detail: { title: 'h1', poster: '.poster img@src', overview: '.desc', type: 'series' },
  episodes: { url: '{href}/episodes', item: '.episode', href: 'a@href', number: 'a@text' },
  streams: { video: 'video@src', m3u8: 'source[type*=m3u8]@src', iframe: 'iframe@src' },
};

const item = { id: 'https://example.org/watch/one', title: 'Title One', type: 'series' as const };

function mockPages(pages: Record<string, string>) {
  vi.mocked(nativeFetchText).mockImplementation(async (url: string) => {
    const data = pages[url];
    return { ok: Boolean(data), status: data ? 200 : 404, data: data ?? '' };
  });
}

beforeEach(() => vi.resetAllMocks());

describe('rule scraper selector engine', () => {
  it('splits css@attr at the last @ only, like jsoup rules do', () => {
    expect(splitSel('a@href')).toEqual({ css: 'a', attr: 'href' });
    expect(splitSel('img[data-x@y]@src')).toEqual({ css: 'img[data-x@y]', attr: 'src' });
    expect(splitSel('.title')).toEqual({ css: '.title' });
    expect(splitSel('a@')).toEqual({ css: 'a@' });
    expect(splitSel('@text')).toEqual({ css: '@text' });
  });

  it('lists typed catalogs and falls back to a Home catalog from homeUrl', async () => {
    const typed = await ruleScraperCatalogs({ name: 'X', baseUrl: 'https://x', catalogs: [
      { id: 'movies', name: 'Movies', type: 'movie' },
      { id: 'junk', name: 'Junk', type: 'widget' },
    ] });
    expect(typed).toEqual([{ id: 'movies', name: 'Movies', type: 'movie' }]);
    const fallback = await ruleScraperCatalogs({ name: 'X', baseUrl: 'https://x', homeUrl: '/' });
    expect(fallback).toEqual([{ id: 'home', name: 'Home', type: 'unknown' }]);
    expect(await ruleScraperCatalogs({ name: 'X' })).toEqual([]);
  });

  it('builds absolute search URLs with encoded query and page', async () => {
    mockPages({});
    await ruleScraperSearch(htmlConfig, 'one punch', 2);
    expect(nativeFetchText).toHaveBeenCalledWith('https://example.org/search?q=one%20punch&p=2',
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }));
  });

  it('scrapes list rows with absolute hrefs and posters', async () => {
    mockPages({ 'https://example.org/home': LIST_HTML });
    const rows = await ruleScraperBrowse(htmlConfig, 'home');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'https://example.org/watch/one', title: 'Title One',
      posterUrl: 'https://example.org/p1.jpg', type: 'series' });
    expect(rows[1].id).toBe('https://cdn.example.org/watch/two');
  });

  it('parses detail pages with title, poster and overview', async () => {
    mockPages({ 'https://example.org/watch/one': DETAIL_HTML });
    const { ruleScraperDetails } = await import('../services/ruleScraper');
    const meta = await ruleScraperDetails(htmlConfig, item);
    expect(meta).toMatchObject({ title: 'Detail Title', posterUrl: 'https://example.org/big.jpg', overview: 'A story.' });
  });

  it('numbers episodes from selectors, falls back to position on collision, dedupes by season+number', async () => {
    // 'Pilot' and 'Duplicate' have no digits, so they take the Kotlin fallback
    // (rows collected so far + 1) and collide with explicit numbers; the first
    // entry wins the dedupe, leaving [2, 3] — exactly what UniversalScraper does.
    mockPages({ 'https://example.org/watch/one/episodes': EPISODES_HTML });
    const episodes = await ruleScraperEpisodes(htmlConfig, item);
    expect(episodes?.map((e) => e.number)).toEqual([2, 3]);
    expect(episodes?.every((e) => e.season === 1)).toBe(true);
  });

  it('returns null for movies without touching the network', async () => {
    const episodes = await ruleScraperEpisodes(htmlConfig, { ...item, type: 'movie' });
    expect(episodes).toBeNull();
    expect(nativeFetchText).not.toHaveBeenCalled();
  });

  it('collects direct, HLS and recursively-followed iframe streams, deduped', async () => {
    mockPages({
      'https://example.org/watch/one': STREAMS_HTML,
      'https://cdn.example.net/embed/1': EMBED_HTML,
    });
    const rows = await ruleScraperStreams(htmlConfig, item, null);
    expect(rows.map((r) => r.name)).toEqual(['Direct', 'HLS', 'Direct']);
    expect(rows[1]).toMatchObject({ url: 'https://example.org/list.m3u8', isM3u8: true });
    expect(rows[2].url).toBe('https://cdn.example.net/embed/video.mp4');
  });

  it('stops following iframes past the depth limit', async () => {
    mockPages({
      'https://example.org/watch/one': '<iframe src="/a"></iframe>',
      'https://example.org/a': '<iframe src="/b"></iframe>',
      'https://example.org/b': '<iframe src="/c"></iframe>',
      'https://example.org/c': '<iframe src="/d"></iframe>',
    });
    const rows = await ruleScraperStreams(htmlConfig, item, null);
    expect(rows).toEqual([]);
    // depth 0 page + /a + /b; /c would be depth 3, past the limit.
    expect(nativeFetchText).toHaveBeenCalledTimes(3);
  });

  it('extracts reader pages in image mode with page referers', async () => {
    mockPages({ 'https://example.org/watch/one': IMAGE_HTML });
    const rows = await ruleScraperStreams({ ...htmlConfig, streams: { images: 'img.page@src' } }, item, null);
    expect(rows.map((r) => r.name)).toEqual(['📖 Page 1', '📖 Page 2']);
    expect(rows[0].headers).toMatchObject({ Referer: 'https://example.org/watch/one' });
  });

  it('maps rows onto StreamResults and drops unreachable URLs', () => {
    const rows = toRuleStreams(htmlConfig, [
      { name: 'HLS', url: 'https://example.org/list.m3u8', isM3u8: true, quality: '1080p',
        headers: { Referer: 'https://example.org/' }, subtitles: [{ lang: 'en', url: 'https://example.org/en.vtt' }] },
      { name: 'Bad', url: 'file:///private' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceType: 'rule-scraper', sourceName: 'TestSite', format: 'hls',
      quality: '1080p', headers: { Referer: 'https://example.org/' },
      subtitles: [{ language: 'en', url: 'https://example.org/en.vtt' }] });
  });
});

describe('rule scraper JSON-API mode', () => {
  const apiConfig: RuleScraperConfig = {
    name: 'JustAPI',
    baseUrl: 'https://just.example.org',
    api: {
      base: 'https://core.just.example.org/api',
      catalogs: [{ id: 'trending', name: 'Trending', type: 'series' }],
      homePath: '/home',
      searchPath: '/search', searchResults: 'results',
      detailPath: '/anime/{id}', detailData: 'data',
      episodesPath: '/anime/{id}/episodes', episodesPageParam: 'page',
      episodesItems: 'episodes', episodesHasNext: 'hasNextPage', episodesMaxPages: 2,
      episodeNumber: 'number', episodeName: 'title',
      streamsPath: '/watch/{id}/episode/{ep}/anineko/{lang}/hd1',
      streamsLangs: 'sub,dub', streamsSources: 'sources',
      streamsHeaders: 'headers', proxyStreams: true,
      proxy: 'https://proxy.just.example.org/p',
      headers: { 'User-Agent': 'TestUA', Referer: 'https://just.example.org/' },
    },
  };

  const HOME = {
    trending: [
      { id: '7', title: { english: 'Show Seven', romaji: 'Seven Raw' }, coverImage: { extraLarge: 'https://img/7.jpg' }, format: 'TV', year: 2024 },
      { id: '', title: 'No id dropped' },
    ],
  };
  const SEARCH = { results: [{ id: '9', title: 'Result Nine', cover: 'https://img/9.jpg' }] };
  const DETAIL = { data: { id: '7', title: 'Show Seven', description: '<b>Air</b> story', genres: ['Action', 'Sci-Fi'],
    seasonYear: 2024, format: 'TV', bannerImage: 'https://img/7-banner.jpg' } };
  const EPISODES_PAGE1 = { episodes: [{ number: 1, title: 'Pilot' }, { number: 2, title: 'Two' }], hasNextPage: true };
  const EPISODES_PAGE2 = { episodes: [{ number: 2, title: 'Repeat' }, { number: 3, title: 'Three' }], hasNextPage: false };
  const STREAM_SUB = { sources: [{ url: '/hls/7/2/list.m3u8', quality: '1080p', isM3U8: true }],
    subtitles: [{ lang: 'en', url: 'https://just.example.org/en.vtt' }], headers: { Referer: 'https://just.example.org/', Origin: 'https://just.example.org' } };

  it('walks home, search, detail, paginated episodes and per-language streams', async () => {
    vi.mocked(nativeFetchText).mockImplementation(async (url: string) => {
      if (url.startsWith('https://core.just.example.org/api/home')) return { ok: true, status: 200, data: JSON.stringify(HOME) };
      if (url.includes('/api/search?')) return { ok: true, status: 200, data: JSON.stringify(SEARCH) };
      if (url.includes('/api/anime/7?')) return { ok: true, status: 200, data: JSON.stringify(DETAIL) };
      if (url.includes('/api/anime/7/episodes?page=1')) return { ok: true, status: 200, data: JSON.stringify(EPISODES_PAGE1) };
      if (url.includes('/api/anime/7/episodes?page=2')) return { ok: true, status: 200, data: JSON.stringify(EPISODES_PAGE2) };
      if (url.includes('/anineko/sub/')) return { ok: true, status: 200, data: JSON.stringify(STREAM_SUB) };
      if (url.includes('/anineko/dub/')) return { ok: false, status: 500, data: '' };
      return { ok: false, status: 404, data: '' };
    });
    const catalogs = await ruleScraperCatalogs(apiConfig);
    expect(catalogs).toEqual([{ id: 'trending', name: 'Trending', type: 'series' }]);
    const rows = await ruleScraperBrowse(apiConfig, 'trending');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '7', title: 'Show Seven', posterUrl: 'https://img/7.jpg', type: 'series', year: 2024 });
    const found = await ruleScraperSearch(apiConfig, 'seven', 1);
    expect(found[0]?.title).toBe('Result Nine');
    const episodes = await ruleScraperEpisodes(apiConfig, { id: '7', title: 'Show Seven', type: 'series' });
    expect(episodes?.map((e) => e.number)).toEqual([1, 2, 3]);
    const streams = await ruleScraperStreams(apiConfig, { id: '7', title: 'Show Seven', type: 'series' }, episodes![1]);
    expect(streams.map((s) => s.name)).toEqual(['Sub 1080p', 'Sub 1080p (proxy)']);
    expect(streams[0].headers).toMatchObject({ Referer: 'https://just.example.org/' });
    expect(streams[0].subtitles?.[0]).toEqual({ lang: 'en', url: 'https://just.example.org/en.vtt' });
    expect(streams[1].url).toContain('proxy.just.example.org/p?url=');
    expect(streams[1].headers).toMatchObject({ Referer: 'https://just.example.org/' });
  });

  it('retries through the proxy when the direct API answers error JSON', async () => {
    // A fresh api object means a fresh per-instance home cache, like a new
    // UniversalScraper instance in Hikari.
    const fresh: RuleScraperConfig = { ...apiConfig, api: { ...apiConfig.api } };
    vi.mocked(nativeFetchText).mockImplementation(async (url: string) => {
      if (url.startsWith('https://proxy.just.example.org/p?')) return { ok: true, status: 200, data: JSON.stringify(HOME) };
      return { ok: true, status: 200, data: JSON.stringify({ error: 'blocked' }) };
    });
    const rows = await ruleScraperBrowse(fresh, 'trending');
    expect(rows).toHaveLength(1);
    // Direct attempt + first proxy success (the loop returns as soon as one works).
    expect(nativeFetchText).toHaveBeenCalledTimes(2);
  });

  it('resolves the carried payload episode for PRAHA playback', async () => {
    const title: RuleScraperTitle = {
      config: apiConfig,
      media: { id: '7', title: 'Show Seven', type: 'series' },
      episodes: [{ id: '7|2', number: 2, season: 1 }, { id: '7|1', number: 1, season: 1 }],
    };
    vi.mocked(nativeFetchText).mockImplementation(async (url: string) => {
      if (url.includes('/anineko/sub/')) return { ok: true, status: 200, data: JSON.stringify(STREAM_SUB) };
      if (url.includes('/anineko/dub/')) return { ok: false, status: 500, data: '' };
      return { ok: false, status: 404, data: '' };
    });
    const streams = await ruleScraperStreamsFor(title, 1, 2);
    expect(streams).toHaveLength(2);
    expect(nativeFetchText).toHaveBeenCalledWith('https://core.just.example.org/api/watch/7/episode/2/anineko/sub/hd1', expect.anything());
    // An unknown episode falls back to the API's `{ep}` default of 1, like the Kotlin port.
    const fallback = await ruleScraperStreamsFor(title, 3, 1);
    expect(fallback).toHaveLength(2);
    expect(nativeFetchText).toHaveBeenCalledWith('https://core.just.example.org/api/watch/7/episode/1/anineko/sub/hd1', expect.anything());
  });
});
