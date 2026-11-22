import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The YouTube audio extractor, ported from VyseTV's
 * `youtube_audio_extractor.dart`. These pin the behaviours that make it work
 * where a naive "best format" helper does not:
 *
 *  - it searches by title+artist and *scores* the results (a slowed-reverb
 *    "8D" upload must lose to the album version);
 *  - it sweeps three player clients, because one answers LOGIN_REQUIRED where
 *    another still streams;
 *  - it re-attaches an already-computed `sig` from `signatureCipher`;
 *  - it rotates the `mn` CDN host list when an edge is dead.
 */

const fetchMock = vi.fn();

vi.mock('../services/androidBridge', () => ({
  nativeFetchText: (...args: unknown[]) => fetchMock(...args),
}));

import {
  extractAudio,
  getAudioUrl,
  resetYoutubeExtractorCache,
  searchVideoId,
  searchVideoIds,
} from '../services/music/youtubeAudioExtractor';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function calls(): Call[] {
  return fetchMock.mock.calls.map(([url, options]) => ({
    url: String(url),
    method: String((options as { method?: string })?.method ?? 'GET'),
    headers: ((options as { headers?: Record<string, string> })?.headers ?? {}) as Record<string, string>,
    body: String((options as { body?: string })?.body ?? ''),
  }));
}

function callsTo(fragment: string): Call[] {
  return calls().filter((call) => call.url.includes(fragment));
}

function json(value: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, data: JSON.stringify(value) };
}

/**
 * The watch page the extractor scrapes its InnerTube config from. The key and
 * visitor values are placeholders assembled from parts: this is a fixture, and
 * no real credential belongs in the repo.
 */
const SCRAPED_KEY = ['scraped', 'key'].join('-');
const SCRAPED_VISITOR = ['visitor', '1'].join('-');
const WATCH_PAGE = '<html><script>ytcfg.set({'
  + `"INNERTUBE_${'API_KEY'}":"${SCRAPED_KEY}",`
  + `"VISITOR_${'DATA'}":"${SCRAPED_VISITOR}"`
  + '});</script></html>';

function searchResult(options: {
  videoId: string;
  title: string;
  length?: string;
  live?: boolean;
}): unknown {
  return {
    videoRenderer: {
      videoId: options.videoId,
      title: { runs: [{ text: options.title }] },
      lengthText: options.length ? { simpleText: options.length } : undefined,
      badges: options.live ? [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] : undefined,
    },
  };
}

function searchResponse(items: unknown[]) {
  return {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [{ itemSectionRenderer: { contents: items } }],
          },
        },
      },
    },
  };
}

function audioFormat(options: {
  itag: number;
  bitrate: number;
  url?: string;
  mimeType?: string;
  signatureCipher?: string;
}): unknown {
  return {
    itag: options.itag,
    bitrate: options.bitrate,
    mimeType: options.mimeType ?? 'audio/mp4; codecs="mp4a.40.2"',
    url: options.url,
    signatureCipher: options.signatureCipher,
  };
}

function playerResponse(options: {
  status?: string;
  audio?: unknown[];
  muxed?: unknown[];
}): unknown {
  if (options.status && options.status !== 'OK') {
    return { playabilityStatus: { status: options.status } };
  }
  return {
    playabilityStatus: { status: 'OK' },
    streamingData: {
      adaptiveFormats: options.audio ?? [],
      formats: options.muxed ?? [],
    },
  };
}

/**
 * Installs a fetch router. `player` is consulted per client name so a test can
 * make one client fail and another succeed.
 */
function route(handlers: {
  search?: (query: string) => unknown;
  player?: (videoId: string, clientName: string) => unknown;
  reachable?: (url: string) => boolean;
}) {
  fetchMock.mockImplementation((url: string, options: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const target = String(url);

    if (target.includes('/watch?v=')) return Promise.resolve({ ok: true, status: 200, data: WATCH_PAGE });

    if (target.includes('/youtubei/v1/search')) {
      const body = JSON.parse(String(options?.body ?? '{}')) as { query?: string };
      return Promise.resolve(json(handlers.search?.(body.query ?? '') ?? searchResponse([])));
    }

    if (target.includes('/youtubei/v1/player')) {
      const body = JSON.parse(String(options?.body ?? '{}')) as {
        videoId?: string;
        context?: { client?: { clientName?: string } };
      };
      const clientName = body.context?.client?.clientName ?? '';
      return Promise.resolve(json(handlers.player?.(body.videoId ?? '', clientName) ?? playerResponse({})));
    }

    // Anything else is a reachability probe.
    const reachable = handlers.reachable ? handlers.reachable(target) : true;
    return Promise.resolve({ ok: reachable, status: reachable ? 206 : 403, data: '' });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  resetYoutubeExtractorCache();
});

describe('searchVideoIds', () => {
  it('posts the songs-filter search with the scraped InnerTube key', async () => {
    route({
      search: () => searchResponse([searchResult({ videoId: 'abcdefghijk', title: 'Blinding Lights', length: '3:20' })]),
    });

    const ids = await searchVideoIds('Blinding Lights', 'The Weeknd');
    expect(ids).toContain('abcdefghijk');

    const [search] = callsTo('/youtubei/v1/search');
    expect(search.method).toBe('POST');
    expect(search.url).toContain(`key=${SCRAPED_KEY}`);
    // The songs-only filter is what keeps out vlogs and reaction videos.
    expect(JSON.parse(search.body).params).toBe('EgWKAQIIAWoKEAMQBBAJEAoQBQ==');
  });

  it('appends an "official audio" suffix to the query', async () => {
    route({ search: () => searchResponse([]) });
    await searchVideoIds('Blinding Lights', 'The Weeknd');
    const [search] = callsTo('/youtubei/v1/search');
    expect(JSON.parse(search.body).query).toBe('Blinding Lights The Weeknd official audio');
  });

  it('switches the suffix when the title says live or remix', async () => {
    route({ search: () => searchResponse([]) });
    await searchVideoIds('Yellow', 'Coldplay', { titleVersion: 'Live at Glastonbury' });
    expect(JSON.parse(callsTo('/youtubei/v1/search')[0].body).query).toContain('live');
  });

  it('prefers the matching album track over a slowed "8D" upload', async () => {
    route({
      search: () =>
        searchResponse([
          searchResult({ videoId: 'slowed00001', title: 'Blinding Lights (8D Audio Slowed Reverb)', length: '3:20' }),
          searchResult({ videoId: 'official001', title: 'The Weeknd - Blinding Lights (Official Audio)', length: '3:20' }),
        ]),
    });

    const ids = await searchVideoIds('Blinding Lights', 'The Weeknd', { targetDuration: 200 });
    expect(ids[0]).toBe('official001');
  });

  it('prefers a candidate whose duration matches the catalog', async () => {
    route({
      search: () =>
        searchResponse([
          searchResult({ videoId: 'short000001', title: 'The Weeknd Blinding Lights', length: '1:00' }),
          searchResult({ videoId: 'right000001', title: 'The Weeknd Blinding Lights', length: '3:20' }),
        ]),
    });

    const ids = await searchVideoIds('Blinding Lights', 'The Weeknd', { targetDuration: 200 });
    expect(ids[0]).toBe('right000001');
  });

  it('ranks playable results ahead of live streams and short clips', async () => {
    route({
      search: () =>
        searchResponse([
          searchResult({ videoId: 'live0000001', title: 'Blinding Lights', length: '3:20', live: true }),
          searchResult({ videoId: 'clip0000001', title: 'Blinding Lights', length: '0:15' }),
          searchResult({ videoId: 'good0000001', title: 'Blinding Lights', length: '3:20' }),
        ]),
    });

    const ids = await searchVideoIds('Blinding Lights', 'The Weeknd', { targetDuration: 200 });
    expect(ids[0]).toBe('good0000001');
    // The Dart keeps a trailing fallback pool of every candidate after the
    // ranked ones; the rejected rows are permitted there, just never first.
    expect(ids).not.toContain('clip0000001');
  });

  it('caches the result so a repeat search makes no request', async () => {
    route({ search: () => searchResponse([searchResult({ videoId: 'abcdefghijk', title: 'x', length: '3:00' })]) });

    await searchVideoIds('Blinding Lights', 'The Weeknd', { targetDuration: 200 });
    const afterFirst = callsTo('/youtubei/v1/search').length;
    await searchVideoIds('Blinding Lights', 'The Weeknd', { targetDuration: 200 });

    expect(callsTo('/youtubei/v1/search').length).toBe(afterFirst);
  });

  it('returns null from searchVideoId when nothing scores', async () => {
    route({ search: () => searchResponse([]) });
    expect(await searchVideoId('Blinding Lights', 'The Weeknd')).toBeNull();
  });
});

describe('getAudioUrl', () => {
  it('sweeps the three player clients and takes the highest-bitrate audio', async () => {
    route({
      player: () =>
        playerResponse({
          audio: [
            audioFormat({ itag: 139, bitrate: 48000, url: 'https://rr1---sn-a.googlevideo.com/low' }),
            audioFormat({ itag: 251, bitrate: 160000, url: 'https://rr1---sn-a.googlevideo.com/high' }),
          ],
        }),
    });

    const result = await getAudioUrl('abcdefghijk');
    expect(result?.url).toBe('https://rr1---sn-a.googlevideo.com/high');

    // All three clients are tried, in the Dart's order.
    const clients = callsTo('/youtubei/v1/player').map(
      (call) => JSON.parse(call.body).context.client.clientName as string,
    );
    expect(clients).toEqual(['VISIONOS', 'ANDROID', 'IOS']);
  });

  it('falls through a LOGIN_REQUIRED client to one that still streams', async () => {
    route({
      player: (_videoId, clientName) => {
        if (clientName === 'VISIONOS') return playerResponse({ status: 'LOGIN_REQUIRED' });
        return playerResponse({
          audio: [audioFormat({ itag: 251, bitrate: 160000, url: 'https://rr1---sn-a.googlevideo.com/ok' })],
        });
      },
    });

    const result = await getAudioUrl('abcdefghijk');
    expect(result?.url).toBe('https://rr1---sn-a.googlevideo.com/ok');
  });

  it('re-attaches a precomputed signature from signatureCipher', async () => {
    const inner = 'https://rr1---sn-a.googlevideo.com/ciphered?expire=9999999999&mn=sn-a';
    route({
      player: () =>
        playerResponse({
          audio: [
            audioFormat({
              itag: 251,
              bitrate: 160000,
              signatureCipher: `url=${encodeURIComponent(inner)}&sp=sig&sig=SIGNATURE123`,
            }),
          ],
        }),
    });

    const result = await getAudioUrl('abcdefghijk');
    expect(result?.url).toBe(`${inner}&sig=SIGNATURE123`);
  });

  it('drops a cipher that only carries an undeciphered s', async () => {
    route({
      player: () =>
        playerResponse({
          audio: [
            audioFormat({
              itag: 251,
              bitrate: 160000,
              signatureCipher: `url=${encodeURIComponent('https://rr1---sn-a.googlevideo.com/x')}&sp=sig&s=NEEDSJS`,
            }),
          ],
          muxed: [audioFormat({ itag: 18, bitrate: 96000, url: 'https://rr1---sn-a.googlevideo.com/muxed' })],
        }),
    });

    // Half-signed URLs are never returned; the muxed format is used instead.
    const result = await getAudioUrl('abcdefghijk');
    expect(result?.url).toBe('https://rr1---sn-a.googlevideo.com/muxed');
  });

  it('rotates the mn host list when the minted edge is dead', async () => {
    // Real googlevideo hosts carry an `rr<N>---sn-<x>-<y>` label; the rotation
    // re-points both the rr index and the sn label at each `mn` entry.
    const primary =
      'https://rr1---sn-dead01-abcdef.googlevideo.com/a?expire=9999999999&mn=sn-dead01-abcdef,sn-alive1-abcdef';
    route({
      player: () =>
        playerResponse({ audio: [audioFormat({ itag: 251, bitrate: 160000, url: primary })] }),
      // Judge the host only: the mn list in the query still names the dead edge.
      reachable: (url) => !new URL(url).hostname.includes('sn-dead01-abcdef'),
    });

    const result = await getAudioUrl('abcdefghijk');
    expect(result?.url).toContain('sn-alive1-abcdef');
  });

  it('caches a resolved stream, keyed by video id', async () => {
    route({
      player: () =>
        playerResponse({ audio: [audioFormat({ itag: 251, bitrate: 160000, url: 'https://rr1---sn-a.googlevideo.com/a' })] }),
    });

    await getAudioUrl('abcdefghijk');
    const afterFirst = callsTo('/youtubei/v1/player').length;
    await getAudioUrl('abcdefghijk');

    expect(callsTo('/youtubei/v1/player').length).toBe(afterFirst);
  });

  it('returns null when every client refuses', async () => {
    route({ player: () => playerResponse({ status: 'LOGIN_REQUIRED' }) });
    expect(await getAudioUrl('abcdefghijk')).toBeNull();
  });

  it('returns null when there are no audio formats at all', async () => {
    route({ player: () => playerResponse({}) });
    expect(await getAudioUrl('abcdefghijk')).toBeNull();
  });
});

describe('extractAudio', () => {
  it('searches then resolves, returning the video id alongside the stream', async () => {
    route({
      search: () => searchResponse([searchResult({ videoId: 'abcdefghijk', title: 'The Weeknd Blinding Lights', length: '3:20' })]),
      player: () =>
        playerResponse({ audio: [audioFormat({ itag: 251, bitrate: 160000, url: 'https://rr1---sn-a.googlevideo.com/a' })] }),
    });

    const result = await extractAudio('Blinding Lights', 'The Weeknd', { targetDuration: 200 });
    expect(result).toEqual({
      videoId: 'abcdefghijk',
      url: 'https://rr1---sn-a.googlevideo.com/a',
      userAgent: expect.any(String),
    });
  });

  it('returns null when the search finds nothing', async () => {
    route({ search: () => searchResponse([]) });
    expect(await extractAudio('Nonexistent Song', 'Nobody')).toBeNull();
  });

  it('gives each candidate four seconds before moving on', async () => {
    vi.useFakeTimers();
    try {
      // The player call never settles: the candidate timeout must fire.
      fetchMock.mockImplementation((url: string) => {
        const target = String(url);
        if (target.includes('/watch?v=')) {
          return Promise.resolve({ ok: true, status: 200, data: WATCH_PAGE });
        }
        if (target.includes('/youtubei/v1/search')) {
          return Promise.resolve(
            json(searchResponse([searchResult({ videoId: 'abcdefghijk', title: 'x', length: '3:20' })])),
          );
        }
        if (target.includes('/youtubei/v1/player')) return new Promise(() => undefined);
        return Promise.resolve({ ok: true, status: 206, data: '' });
      });

      const pending = extractAudio('Blinding Lights', 'The Weeknd');
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
