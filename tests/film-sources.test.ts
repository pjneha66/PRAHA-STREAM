import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FetchCall {
  url: string;
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  };
}

interface FetchReply {
  ok: boolean;
  status: number;
  data: string;
  headers?: Record<string, string>;
}

const state = vi.hoisted(() => ({
  handler: (_url: string, _options: FetchCall['options']) =>
    ({ ok: false, status: 500, data: '' }) as {
      ok: boolean;
      status: number;
      data: string;
      headers?: Record<string, string>;
    },
  calls: [] as Array<{
    url: string;
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
    };
  }>,
}));

vi.mock('../services/androidBridge', () => ({
  nativeFetchText: vi.fn(async (url: string, options: unknown) => {
    const opts = (options ?? {}) as FetchCall['options'];
    state.calls.push({ url, options: opts });
    return state.handler(url, opts);
  }),
}));

vi.mock('../services/tmdbConfig', () => ({ getTmdbApiKey: () => 'test-key' }));

import { FILM_SOURCES, type FilmQuery } from '../services/filmSources';

const film = (id: string): FilmQuery => ({ id, title: 'Fixture', year: '2024' });

const reply = (data: string, status = 200, headers?: Record<string, string>): FetchReply => ({
  ok: status >= 200 && status < 300,
  status,
  data,
  headers,
});

const json = (value: unknown): string => JSON.stringify(value);

describe('filmSources ports', () => {
  beforeEach(() => {
    state.calls.length = 0;
    state.handler = () => ({ ok: false, status: 500, data: '' });
  });

  it('loads all 41 sources with unique ids', () => {
    // VyseTV's 39 ported scrapers, plus its two built-in sources: Movy and Knaben.
    expect(FILM_SOURCES).toHaveLength(41);
    expect(new Set(FILM_SOURCES.map((source) => source.id)).size).toBe(41);
  });

  it("puts VyseTV's built-in sources where VyseTV puts them", () => {
    expect(FILM_SOURCES[0].id).toBe('movy');
    expect(FILM_SOURCES[FILM_SOURCES.length - 1].id).toBe('knaben');
  });

  it('gives every source a callable scraper', () => {
    for (const source of FILM_SOURCES) {
      expect(typeof source.scraper, source.id).toBe('function');
    }
  });

  it('cno parses an HLS master into a stream', async () => {
    state.handler = (url) => {
      if (/\/api\/s\/1\/movie\//.test(url)) {
        return reply(
          [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080',
            'https://cdn.example.test/tracks/master.m3u8',
          ].join('\n'),
        );
      }
      return reply('', 500);
    };
    const streams = await FILM_SOURCES.find((source) => source.id === 'cno')!.scraper(film('101'));
    expect(streams.length).toBeGreaterThan(0);
    expect(streams[0]?.type).toBe('hls');
    expect(streams[0]?.url).toMatch(/^https?:\/\//);
    expect(streams[0]?.url).toContain('/tracks/master.m3u8');
  });

  it('vidcore stages through enc-dec and returns the decoded mirror', async () => {
    state.handler = (url, options) => {
      if (url.startsWith('https://vidcore.io/movie/')) return reply('{\\"en\\":\\"TOKEN\\"}');
      if (url.includes('enc-vidcore') && url.includes('stage=1')) {
        return reply(
          json({ status: 200, result: { stage1: 'https://stage.test/one', token: 'csrf-1' } }),
        );
      }
      if (url === 'https://stage.test/one') return reply('stage-one-body');
      if (url.includes('enc-vidcore') && url.includes('stage=2')) {
        return reply(
          json({
            status: 200,
            result: {
              servers: 'https://stage.test/servers',
              stream: 'https://cdn.example.test',
              token: 'csrf-2',
            },
          }),
        );
      }
      if (url === 'https://stage.test/servers') return reply('servers-body');
      if (url === 'https://cdn.example.test/fast') return reply('enc-body');
      if (url.includes('dec-vidcore')) {
        const text = JSON.parse(String(options.body)).text as string;
        if (text === 'servers-body') {
          return reply(json({ status: 200, result: [{ data: 'fast', name: 'Fast' }] }));
        }
        return reply(json({ status: 200, result: { url: 'https://cdn.example.test/video.m3u8' } }));
      }
      return reply('', 500);
    };
    const streams = await FILM_SOURCES.find((source) => source.id === 'vidcore')!.scraper(film('202'));
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      server: 'VidCore - Fast',
      type: 'hls',
      url: 'https://cdn.example.test/video.m3u8',
    });
  });

  it('torrentio reads the first useful SSE batch', async () => {
    state.handler = (url) => {
      if (url.includes('s.torrentio.to/v1/sources/stream')) {
        return reply(
          'data: ' +
            json({
              sources: [
                {
                  url: 'https://cdn.example.test/torrentio.mp4',
                  provider: { name: 'FixtureProv' },
                  quality: '1080',
                  type: 'mp4',
                },
              ],
            }) +
            '\n\n',
        );
      }
      return reply('', 500);
    };
    const streams = await FILM_SOURCES.find((source) => source.id === 'torrentio')!.scraper(film('303'));
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      server: 'Torrentio - FixtureProv',
      quality: '1080p',
      type: 'mp4',
      url: 'https://cdn.example.test/torrentio.mp4',
    });
  });

  it('vixsrc follows the embed and names the audio track', async () => {
    state.handler = (url) => {
      if (url.includes('vixsrc.to/api/movie/')) return reply(json({ src: '/embed/fixture' }));
      if (url === 'https://vixsrc.to/embed/fixture') {
        return reply(
          [
            '<script>',
            'const cfg = { "token": "tok", "expires": "123", "url": "https://cdn.example.test/vix/master.m3u8", "lang": "it" };',
            '</script>',
          ].join('\n'),
        );
      }
      if (url.startsWith('https://cdn.example.test/vix/master.m3u8')) {
        return reply('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="Italiano",LANGUAGE="it"\n');
      }
      return reply('', 500);
    };
    const streams = await FILM_SOURCES.find((source) => source.id === 'vixsrc')!.scraper(film('404'));
    expect(streams).toHaveLength(1);
    expect(streams[0]?.server).toBe('VixSrc (Italiano)');
    expect(streams[0]?.type).toBe('hls');
    expect(streams[0]?.url).toMatch(/^https:\/\/cdn\.example\.test\//);
  });

  it('anime123 finds an anime episode and returns its source', async () => {
    state.handler = (url) => {
      if (/api\.themoviedb\.org\/3\/(movie|tv)\/505/.test(url)) {
        return reply(
          json({
            title: 'Fixture Anime',
            original_title: 'Fixture Anime',
            release_date: '2024-01-01',
            original_language: 'ja',
            origin_country: ['JP'],
            genres: [{ id: 16 }],
          }),
        );
      }
      if (url.includes('/ajax/film/search')) {
        return reply(json({ html: '<a href="/anime/fixture-anime">Fixture</a>' }));
      }
      if (url.includes('/ajax/episode/info')) {
        return reply(json({ target: 'https://embed.example.test/embed-xyz/TOKEN123' }));
      }
      if (url === 'https://embed.example.test/embed-xyz/TOKEN123') {
        return reply('<html></html>', 200, { 'set-cookie': 'sid=abc; Path=/' });
      }
      if (url.includes('/hs/getSources?id=TOKEN123')) {
        return reply(json({ sources: 'https://cdn.example.test/anime.m3u8' }));
      }
      return reply('', 500);
    };
    const streams = await FILM_SOURCES.find((source) => source.id === '123anime')!.scraper({
      ...film('505'),
      season: 1,
      episode: 1,
    });
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      server: '123Anime',
      type: 'hls',
      url: 'https://cdn.example.test/anime.m3u8',
    });
  });

  it('returns [] when the network rejects, without throwing', async () => {
    state.handler = () => {
      throw new Error('offline');
    };
    const streams = await FILM_SOURCES.find((source) => source.id === 'braflix')!.scraper(film('606'));
    expect(streams).toEqual([]);
  });
});
