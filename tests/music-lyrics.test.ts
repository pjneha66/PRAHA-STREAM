import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The lyrics service, ported from VyseTV's `lyrics_service.dart`. What matters
 * is the cascade: an exact `/api/get` with album and duration, then a second
 * `/api/get` with the *cleaned* title/artist, then `/api/search`. The cleaning
 * is what makes a catalog title like "Blinding Lights (Official Audio)" match.
 */

const fetchMock = vi.fn();

vi.mock('../services/androidBridge', () => ({
  nativeFetchText: (...args: unknown[]) => fetchMock(...args),
}));

import {
  activeLyricIndex,
  EMPTY_LYRICS,
  fetchLyrics,
  parseLrc,
  resetLyricsCache,
} from '../services/music/lyricsService';

function body(value: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, data: JSON.stringify(value) };
}

function notFound() {
  return { ok: false, status: 404, data: '' };
}

function urls(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

const SYNCED = '[00:12.50]I been on my own\n[00:15.00]For a long time\n[00:20.00]';

beforeEach(() => {
  fetchMock.mockReset();
  resetLyricsCache();
});

describe('parseLrc', () => {
  it('parses timestamps and text, sorted ascending', () => {
    expect(parseLrc('[00:20.00]second\n[00:12.50]first')).toEqual([
      { time: 12.5, text: 'first' },
      { time: 20, text: 'second' },
    ]);
  });

  it('treats a two-digit fraction as centiseconds and three as milliseconds', () => {
    expect(parseLrc('[00:01.05]a')[0].time).toBeCloseTo(1.05, 5);
    expect(parseLrc('[00:01.005]b')[0].time).toBeCloseTo(1.005, 5);
  });

  it('keeps an empty timestamped line, so instrumentals keep their spacing', () => {
    expect(parseLrc('[00:30.00]')).toEqual([{ time: 30, text: '' }]);
  });

  it('ignores lines with no timestamp', () => {
    expect(parseLrc('[ar:Some Artist]\nplain text\n[00:05.00]real')).toEqual([
      { time: 5, text: 'real' },
    ]);
  });
});

describe('activeLyricIndex', () => {
  const lines = parseLrc('[00:10.00]a\n[00:20.00]b\n[00:30.00]c');

  it('is -1 before the first line', () => {
    expect(activeLyricIndex(lines, 5)).toBe(-1);
  });

  it('returns the last line at or before the position', () => {
    expect(activeLyricIndex(lines, 10)).toBe(0);
    expect(activeLyricIndex(lines, 25)).toBe(1);
    expect(activeLyricIndex(lines, 999)).toBe(2);
  });
});

describe('fetchLyrics', () => {
  it('uses the exact match first, with album and duration', async () => {
    fetchMock.mockResolvedValue(body({ syncedLyrics: SYNCED, plainLyrics: 'plain' }));

    const result = await fetchLyrics({
      id: 'track-1',
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      album: 'After Hours',
      duration: 200,
    });

    const [url] = urls();
    expect(url).toContain('https://lrclib.net/api/get?');
    expect(url).toContain('track_name=Blinding+Lights');
    expect(url).toContain('artist_name=The+Weeknd');
    expect(url).toContain('album_name=After+Hours');
    expect(url).toContain('duration=200');
    expect(result.isSynced).toBe(true);
    // Three timestamps, the last of which is an intentional blank line.
    expect(result.syncedLines).toHaveLength(3);
    expect(result.plainLyrics).toBe('plain');
  });

  it('omits album_name when the album is the placeholder "Single"', async () => {
    fetchMock.mockResolvedValue(body({ syncedLyrics: SYNCED }));
    await fetchLyrics({ id: 't', title: 'x', artist: 'y', album: 'Single', duration: 0 });
    expect(urls()[0]).not.toContain('album_name');
    expect(urls()[0]).not.toContain('duration');
  });

  it('retries with the cleaned title and artist when the exact lookup misses', async () => {
    fetchMock.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(body({ syncedLyrics: SYNCED }));

    const result = await fetchLyrics({
      id: 'track-2',
      title: 'Blinding Lights (Official Audio)',
      artist: 'The Weeknd feat. Someone',
      album: 'After Hours',
      duration: 200,
    });

    expect(urls()).toHaveLength(2);
    expect(urls()[1]).toContain('track_name=Blinding+Lights');
    expect(urls()[1]).toContain('artist_name=The+Weeknd');
    // The retry deliberately drops album and duration.
    expect(urls()[1]).not.toContain('album_name');
    expect(urls()[1]).not.toContain('duration=');
    expect(result.isSynced).toBe(true);
  });

  it('falls back to a free-text search over "artist title"', async () => {
    fetchMock
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(body([{ syncedLyrics: SYNCED }]));

    const result = await fetchLyrics({ id: 'track-3', title: 'Blinding Lights', artist: 'The Weeknd' });

    expect(urls()[2]).toBe('https://lrclib.net/api/search?q=The%20Weeknd%20Blinding%20Lights');
    expect(result.isSynced).toBe(true);
  });

  it('returns plain lyrics unhighlighted when lrclib has no timestamps', async () => {
    fetchMock.mockResolvedValue(body({ plainLyrics: 'just words\nno timing' }));

    const result = await fetchLyrics({ id: 'track-4', title: 'x', artist: 'y' });
    expect(result).toMatchObject({ isSynced: false, plainLyrics: 'just words\nno timing' });
    expect(result.syncedLines).toEqual([]);
  });

  it('returns EMPTY_LYRICS after all three attempts miss', async () => {
    fetchMock.mockResolvedValue(notFound());
    const result = await fetchLyrics({ id: 'track-5', title: 'x', artist: 'y' });
    expect(result).toEqual(EMPTY_LYRICS);
    expect(urls()).toHaveLength(3);
  });

  it('caches a hit so a repeat call makes no request', async () => {
    fetchMock.mockResolvedValue(body({ syncedLyrics: SYNCED }));

    await fetchLyrics({ id: 'track-6', title: 'x', artist: 'y' });
    const afterFirst = urls().length;
    await fetchLyrics({ id: 'track-6', title: 'x', artist: 'y' });

    expect(urls()).toHaveLength(afterFirst);
  });

  it('caches a miss too, so an absent song is not re-fetched', async () => {
    fetchMock.mockResolvedValue(notFound());
    await fetchLyrics({ id: 'track-7', title: 'x', artist: 'y' });
    const afterFirst = urls().length;
    await fetchLyrics({ id: 'track-7', title: 'x', artist: 'y' });
    expect(urls()).toHaveLength(afterFirst);
  });

  it('never throws when the transport fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await fetchLyrics({ id: 'track-8', title: 'x', artist: 'y' })).toEqual(EMPTY_LYRICS);
  });

  it('identifies itself with the VyseTV User-Agent', async () => {
    fetchMock.mockResolvedValue(body({ syncedLyrics: SYNCED }));
    await fetchLyrics({ id: 't', title: 'x', artist: 'y' });

    const [, options] = fetchMock.mock.calls[0] as [string, { headers?: Record<string, string> }];
    expect(options.headers?.['User-Agent']).toBe('VyseTV/1.0.0');
  });
});
