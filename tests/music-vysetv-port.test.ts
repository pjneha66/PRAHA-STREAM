import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The VyseTV stream resolution chain. Each test pins one tier, so a future
 * "simplification" of the order fails here rather than in the field:
 *
 *   rate-limit gate → per-track stream cache → cached video id →
 *   title+artist extractor → Convertytmp3 mirror → Deezer preview
 */

const fetchMock = vi.fn();

vi.mock('../services/androidBridge', () => ({
  nativeFetchText: (...args: unknown[]) => fetchMock(...args),
  proxyStreamUrlWithHeaders: (url: string) => url,
}));

const extractMock = vi.fn();
const getAudioUrlMock = vi.fn();

vi.mock('../services/music/youtubeAudioExtractor', () => ({
  extractAudio: (...args: unknown[]) => extractMock(...args),
  getAudioUrl: (...args: unknown[]) => getAudioUrlMock(...args),
}));

const convertyMock = vi.fn();

vi.mock('../services/music/convertytmp3Client', () => ({
  getStreamUrl: (...args: unknown[]) => convertyMock(...args),
  CONVERTYTMP3_USER_AGENT: 'converty-ua',
}));

import { forgetStreamUrl, resetStreamResolverCache, resolveUrl } from '../services/music/youtubeStreamResolver';
import { isRateLimitError, youtubeRateLimitGuard } from '../services/music/youtubeRateLimitGuard';
import type { MusicTrack } from '../services/music/musicTrack';

const PREVIEW_URL = 'https://cdnt-preview.dzcdn.net/api/1/1/x/y/0/preview.mp3';

function track(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: 'deezer-123',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    artistId: '4050205',
    album: 'After Hours',
    albumId: '115243282',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/x/500x500-000000-80-0-0.jpg',
    durationSeconds: 200,
    explicit: false,
    previewUrl: PREVIEW_URL,
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  extractMock.mockReset();
  getAudioUrlMock.mockReset();
  convertyMock.mockReset();
  resetStreamResolverCache();
  youtubeRateLimitGuard.reset();
});

describe('resolveUrl', () => {
  it('resolves through the extractor and serves replays from the stream cache', async () => {
    extractMock.mockResolvedValue({
      videoId: 'abcdefghijk',
      url: 'https://rr1---sn-x.googlevideo.com/a',
      userAgent: 'ua-1',
    });

    const first = await resolveUrl(track());
    expect(first).toEqual({ url: 'https://rr1---sn-x.googlevideo.com/a', userAgent: 'ua-1' });
    expect(extractMock).toHaveBeenCalledTimes(1);

    // Second call must not touch the network at all.
    const second = await resolveUrl(track());
    expect(second).toEqual(first);
    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(convertyMock).not.toHaveBeenCalled();
  });

  it('passes the catalog duration to the extractor so the search can score it', async () => {
    extractMock.mockResolvedValue({ videoId: 'abcdefghijk', url: 'https://x/a', userAgent: 'ua' });
    await resolveUrl(track({ durationSeconds: 200 }));
    expect(extractMock).toHaveBeenCalledWith('Blinding Lights', 'The Weeknd', { targetDuration: 200 });
  });

  it('passes null rather than 0 when the catalog does not know the duration', async () => {
    extractMock.mockResolvedValue({ videoId: 'abcdefghijk', url: 'https://x/a', userAgent: 'ua' });
    await resolveUrl(track({ durationSeconds: 0 }));
    expect(extractMock).toHaveBeenCalledWith('Blinding Lights', 'The Weeknd', { targetDuration: null });
  });

  it('ends at the Deezer preview, with the preview CDN User-Agent, when nothing else resolves', async () => {
    extractMock.mockResolvedValue(null);
    convertyMock.mockResolvedValue(null);

    const result = await resolveUrl(track());
    expect(result).toEqual({
      url: PREVIEW_URL,
      // The preview CDN rejects a media-player agent.
      userAgent: expect.stringContaining('Chrome/131'),
    });
  });

  it('returns null when the track has no preview and nothing resolved', async () => {
    extractMock.mockResolvedValue(null);
    expect(await resolveUrl(track({ previewUrl: undefined }))).toBeNull();
  });

  it('refuses to resolve while the rate-limit guard is cooling down', async () => {
    youtubeRateLimitGuard.record(new Error('429 too many requests'));

    expect(await resolveUrl(track())).toBeNull();
    // The gate runs before anything touches the network — including the
    // preview tier, which is the Dart's behaviour too.
    expect(extractMock).not.toHaveBeenCalled();
    expect(convertyMock).not.toHaveBeenCalled();
  });

  it('swallows an extractor throw and still reaches the preview tier', async () => {
    extractMock.mockRejectedValue(new Error('transport exploded'));
    const result = await resolveUrl(track());
    expect(result?.url).toBe(PREVIEW_URL);
  });

  it('does not cache a preview, so a later retry can still find full audio', async () => {
    extractMock.mockResolvedValueOnce(null);
    await resolveUrl(track());

    extractMock.mockResolvedValueOnce({ videoId: 'abcdefghijk', url: 'https://x/full', userAgent: 'ua' });
    const retry = await resolveUrl(track());
    expect(retry?.url).toBe('https://x/full');
  });

  it('re-resolves from the cached video id after forgetStreamUrl', async () => {
    extractMock.mockResolvedValue({ videoId: 'abcdefghijk', url: 'https://x/first', userAgent: 'ua' });
    await resolveUrl(track());

    // The player saw the address 403 before its own expiry.
    forgetStreamUrl(track().id);
    getAudioUrlMock.mockResolvedValue({ url: 'https://x/second', userAgent: 'ua' });

    const second = await resolveUrl(track());
    expect(second?.url).toBe('https://x/second');
    // The video id survived, so no new search was needed.
    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(getAudioUrlMock).toHaveBeenCalledWith('abcdefghijk');
  });
});

describe('youtubeRateLimitGuard', () => {
  it('recognises the bot wall in its several disguises', () => {
    expect(isRateLimitError(new Error('HTTP 429'))).toBe(true);
    expect(isRateLimitError(new Error("Sign in to confirm you're not a bot"))).toBe(true);
    expect(isRateLimitError(new Error('unusual traffic from your network'))).toBe(true);
    expect(isRateLimitError(new Error('player returned LOGIN_REQUIRED'))).toBe(false);
    expect(isRateLimitError(new Error('network unreachable'))).toBe(false);
  });

  it('spaces consecutive low-rate requests by the minimum gap', async () => {
    vi.useFakeTimers();
    try {
      const started: number[] = [];
      const action = () => {
        started.push(Date.now());
        return Promise.resolve(null);
      };

      const first = youtubeRateLimitGuard.runLowRequest(action);
      await vi.advanceTimersByTimeAsync(0);
      await first;

      const second = youtubeRateLimitGuard.runLowRequest(action);
      await vi.advanceTimersByTimeAsync(2000);
      await second;

      expect(started).toHaveLength(2);
      expect(started[1] - started[0]).toBeGreaterThanOrEqual(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a five-minute cooldown when an action is rate-limited', async () => {
    await expect(
      youtubeRateLimitGuard.runLowRequest(() => Promise.reject(new Error('429 too many requests'))),
    ).rejects.toThrow('429');

    expect(youtubeRateLimitGuard.isLimited).toBe(true);
    const remaining = youtubeRateLimitGuard.remainingMs ?? 0;
    expect(remaining).toBeGreaterThan(4 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('does not start a cooldown for an ordinary failure', async () => {
    await expect(
      youtubeRateLimitGuard.runLowRequest(() => Promise.reject(new Error('network unreachable'))),
    ).rejects.toThrow('unreachable');
    expect(youtubeRateLimitGuard.isLimited).toBe(false);
  });

  it('reports a UI-ready message with the remaining wait', () => {
    youtubeRateLimitGuard.record(new Error('429'));
    expect(youtubeRateLimitGuard.userMessage).toMatch(/busy on this network.*retry/i);
  });

  it('clears the cooldown on reset', () => {
    youtubeRateLimitGuard.record(new Error('429'));
    expect(youtubeRateLimitGuard.isLimited).toBe(true);
    youtubeRateLimitGuard.reset();
    expect(youtubeRateLimitGuard.isLimited).toBe(false);
    expect(youtubeRateLimitGuard.remainingMs).toBeNull();
  });
});
