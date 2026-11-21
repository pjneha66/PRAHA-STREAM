import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeFetchText } from '../services/androidBridge';
import {
  MIN_REQUEST_INTERVAL_MS,
  rateLimitGuard,
  resetYouTubeMusicCache,
  resolveAudioStream,
  searchMusic,
} from '../services/youtubeMusicClient';

vi.mock('../services/androidBridge', () => ({ nativeFetchText: vi.fn() }));

const fetchMock = vi.mocked(nativeFetchText);

/* ------------------------------------------------------------------ *
 * Fixtures — trimmed but structurally faithful InnerTube payloads.
 * ------------------------------------------------------------------ */

const BASE_TIME = new Date('2026-11-21T00:00:00.000Z');

/** A `musicResponsiveListItemRenderer` as the music search returns it. */
function searchItem(options: { videoId: string; title: string; subtitle: string; clock?: string }): unknown {
  return {
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId: options.videoId },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: options.title }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: options.subtitle }] } } },
      ],
      fixedColumns: [
        { musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: options.clock ?? '3:45' }] } } },
      ],
      thumbnail: {
        musicThumbnailRenderer: {
          thumbnail: {
            thumbnails: [
              { url: 'https://lh3.googleusercontent.com/small.jpg', width: 60, height: 60 },
              { url: 'https://lh3.googleusercontent.com/large.jpg', width: 544, height: 544 },
            ],
          },
        },
      },
    },
  };
}

const SEARCH_RESPONSE = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            {
              musicShelfRenderer: {
                title: { runs: [{ text: 'Songs' }] },
                contents: [
                  searchItem({
                    videoId: 'dQw4w9WgXcQ',
                    title: 'Never Gonna Give You Up',
                    subtitle: 'Rick Astley • Whenever You Need Somebody • 1987',
                    clock: '3:33',
                  }),
                  searchItem({
                    videoId: 'kJQP7kiw5Fk',
                    title: 'Despacito',
                    subtitle: 'Luis Fonsi • Despacito • 2017',
                    clock: '4:41',
                  }),
                ],
              },
            },
          ],
        },
      },
    },
  },
};

/** An audio-only adaptive format; `expire` is an epoch in seconds. */
function audioFormat(itag: number, mimeType: string, bitrate: number, expire: number): unknown {
  return {
    itag,
    mimeType,
    bitrate,
    audioSampleRate: '48000',
    approxDurationMs: '213000',
    url: `https://rr1---sn-abc.googlevideo.com/videoplayback?itag=${itag}&expire=${expire}&mime=audio`,
  };
}

function playerResponse(formats: unknown[], lengthSeconds = '213'): unknown {
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId: 'dQw4w9WgXcQ', lengthSeconds },
    streamingData: { adaptiveFormats: formats, formats: [] },
  };
}

/** Seconds-since-epoch `expire` value for a URL that should live for `hours`. */
function expireIn(hours: number): number {
  return Math.floor(Date.now() / 1000) + hours * 3600;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  fetchMock.mockReset();
  rateLimitGuard.reset();
  resetYouTubeMusicCache();
});

/**
 * The rate-limit guard deliberately spaces requests (2s minimum) and backs off
 * on throttling. Under fake timers those sleeps only fire when time is advanced,
 * so every async call under test must be paired with a timer flush.
 */
async function withTimers<T>(task: () => Promise<T>, advanceMs = 30_000): Promise<T> {
  const promise = task();
  await vi.advanceTimersByTimeAsync(advanceMs);
  return promise;
}

describe('searchMusic', () => {
  it('posts to the music InnerTube search endpoint as WEB_REMIX and parses songs', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: JSON.stringify(SEARCH_RESPONSE) });

    const results = await searchMusic('never gonna give you up', { limit: 5 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://music.youtube.com/youtubei/v1/search');
    expect(url).toContain('key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8');
    expect(init?.method).toBe('POST');

    const body = JSON.parse(String(init?.body)) as {
      query: string;
      params: string;
      context: { client: { clientName: string; clientVersion: string } };
    };
    expect(body.query).toBe('never gonna give you up');
    expect(body.params).toBe('EgWKAQIIAWoKEAMQBBAJEAoQBQ==');
    expect(body.context.client.clientName).toBe('WEB_REMIX');
    expect(body.context.client.clientVersion).toBe('2.20250217.03.00');

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      album: 'Whenever You Need Somebody',
      duration: 213, // 3:33
      thumbnail: 'https://lh3.googleusercontent.com/large.jpg',
    });
    expect(results[1].duration).toBe(281); // 4:41
  });

  it('returns an empty list for a blank query without touching the network', async () => {
    const results = await searchMusic('   ');
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveAudioStream', () => {
  it('picks opus itag 251 over m4a itag 140 when both are available', async () => {
    const expire = expireIn(6);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: JSON.stringify(
        playerResponse([
          audioFormat(140, 'audio/mp4; codecs="mp4a.40.2"', 129000, expire),
          audioFormat(251, 'audio/webm; codecs="opus"', 160000, expire),
        ]),
      ),
    });

    const stream = await withTimers(() => resolveAudioStream('dQw4w9WgXcQ'));

    expect(stream).not.toBeNull();
    expect(stream?.codec).toBe('opus');
    expect(stream?.bitrate).toBe(160000);
    expect(stream?.mimeType).toContain('opus');
    expect(stream?.url).toContain('itag=251');
    expect(stream?.duration).toBe(213);
    expect(stream?.expiresAt).toBe(expire * 1000);
  });

  it('returns null instead of a muxed stream when no audio-only format exists', async () => {
    // `formats` are the muxed video+audio streams; adaptiveFormats here only
    // carry a video track. Nothing audio-only is on offer.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: JSON.stringify({
        playabilityStatus: { status: 'OK' },
        videoDetails: { videoId: 'dQw4w9WgXcQ', lengthSeconds: '213' },
        streamingData: {
          formats: [{ itag: 18, mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', bitrate: 500000, url: 'https://x/18' }],
          adaptiveFormats: [
            { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4000000, url: 'https://x/137' },
          ],
        },
      }),
    });

    const stream = await withTimers(() => resolveAudioStream('dQw4w9WgXcQ'));

    expect(stream).toBeNull();
    // Both clients are asked before giving up, but never more than once each.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves from cache, then re-resolves once the signed URL has expired', async () => {
    const firstExpire = expireIn(6);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: JSON.stringify(playerResponse([audioFormat(251, 'audio/webm; codecs="opus"', 160000, firstExpire)])),
    });

    const first = await withTimers(() => resolveAudioStream('dQw4w9WgXcQ'));
    expect(first).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Inside the validity window: cache hit, no second request.
    const cached = await withTimers(() => resolveAudioStream('dQw4w9WgXcQ'));
    expect(cached?.url).toBe(first?.url);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Push past the CDN expiry (6 h + margin) — the guard's minimum interval
    // is long gone too, so the next resolve must hit the network again.
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 7 * 60 * 60 * 1000));

    const secondExpire = expireIn(6);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: JSON.stringify(playerResponse([audioFormat(251, 'audio/webm; codecs="opus"', 160000, secondExpire)])),
    });

    const refreshed = await withTimers(() => resolveAudioStream('dQw4w9WgXcQ'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed).not.toBeNull();
    expect(refreshed?.expiresAt).toBe(secondExpire * 1000);
    expect(refreshed?.expiresAt).not.toBe(first?.expiresAt);
  });

  it('re-attaches a pre-computed sig from signatureCipher', async () => {
    const expire = expireIn(6);
    const cipher = new URLSearchParams({
      s: 'SIGNED_BLOB',
      sp: 'signature',
      url: `https://rr1---sn-abc.googlevideo.com/videoplayback?itag=251&expire=${expire}`,
    }).toString();
    // A cipher carrying `sig` (not `s`) needs no JS: it is already signed.
    const readyCipher = new URLSearchParams({
      sig: 'READY_SIG',
      sp: 'sig',
      url: `https://rr1---sn-abc.googlevideo.com/videoplayback?itag=251&expire=${expire}`,
    }).toString();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: JSON.stringify(
        playerResponse([
          { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160000, signatureCipher: cipher },
          { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 159000, signatureCipher: readyCipher },
        ]),
      ),
    });

    const stream = await withTimers(() => resolveAudioStream('dQw4w9WgXcQ'));

    // The `s`-only format is unportable without a JS interpreter and is dropped;
    // the already-signed one is used and its signature survives the round trip.
    expect(stream).not.toBeNull();
    expect(new URL(stream!.url).searchParams.get('sig')).toBe('READY_SIG');
  });
});

describe('rateLimitGuard', () => {
  it('enforces the minimum interval between two consecutive acquisitions', async () => {
    const arrivals: number[] = [];

    const first = rateLimitGuard.acquire().then(() => arrivals.push(Date.now()));
    const second = rateLimitGuard.acquire().then(() => arrivals.push(Date.now()));

    await vi.advanceTimersByTimeAsync(0);
    expect(arrivals).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MIN_REQUEST_INTERVAL_MS - 1);
    expect(arrivals).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(arrivals).toHaveLength(2);
    expect(arrivals[1] - arrivals[0]).toBeGreaterThanOrEqual(MIN_REQUEST_INTERVAL_MS);

    await Promise.all([first, second]);
  });

  it('opens the circuit after repeated 429s and refuses further acquisitions', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      rateLimitGuard.recordFailure('429 Too Many Requests');
    }

    expect(rateLimitGuard.isBlocked()).toBe(true);
    await expect(rateLimitGuard.acquire()).rejects.toThrow(/busy on this network/i);

    // Once the backoff window elapses the gate reopens.
    await vi.advanceTimersByTimeAsync(rateLimitGuard.waitRemainingMs() + 1);
    rateLimitGuard.reset();
    await expect(rateLimitGuard.acquire()).resolves.toBeUndefined();
  });
});
