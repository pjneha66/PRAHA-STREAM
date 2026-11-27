import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two catalog/fallback clients ported from VyseTV:
 *
 *  - `deezerApiClient` is the primary metadata source, and its `fromJson` chains
 *    are what let one parser serve chart, search, album and playlist payloads.
 *  - `convertytmp3Client` is the mp3 mirror used when YouTube refuses, and its
 *    handshake has to be followed exactly or it returns nothing.
 */

const fetchMock = vi.fn();

vi.mock('../services/androidBridge', () => ({
  nativeFetchText: (...args: unknown[]) => fetchMock(...args),
}));

import * as deezer from '../services/music/deezerApiClient';
import { getStreamUrl } from '../services/music/convertytmp3Client';
import { musicTrackFromJson, formattedDuration } from '../services/music/musicTrack';
import { OctaveMusicService } from '../services/musicService';

function ok(value: unknown) {
  return { ok: true, status: 200, data: JSON.stringify(value) };
}

function status(code: number, data = '') {
  return { ok: code >= 200 && code < 300, status: code, data };
}

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

beforeEach(() => {
  fetchMock.mockReset();
});

it('fills the Tracks section when Deezer only returns artists', async () => {
  fetchMock.mockImplementation(async (target: string) => {
    const url = new URL(target);
    if (url.hostname === 'itunes.apple.com') {
      return ok({ results: [
        { kind: 'song', trackId: 7, trackName: 'One More Time', artistName: 'Daft Punk', trackTimeMillis: 320000,
          trackViewUrl: 'https://music.apple.com/us/album/discovery/1?i=7',
          previewUrl: 'https://audio-ssl.itunes.apple.com/example.m4a' },
        { kind: 'song', trackId: 8, trackName: 'One More Time', artistName: 'Daft Punk',
          trackViewUrl: 'https://music.apple.com/us/album/discovery/1?i=8' },
      ] });
    }
    if (url.pathname === '/search/artist') return ok({ data: [{ id: 27, name: 'Daft Punk' }] });
    return ok({ data: [] });
  });
  const data = await OctaveMusicService.searchFull('Daft Punk');
  expect(data.artists[0]?.name).toBe('Daft Punk');
  expect(data.tracks).toEqual([expect.objectContaining({
    id: 'itunes:7', title: 'One More Time', artist: 'Daft Punk', duration: 320,
    previewUrl: 'https://audio-ssl.itunes.apple.com/example.m4a',
  })]);
});

it('keeps the primary tracks and skips the fallback when Deezer returns songs', async () => {
  fetchMock.mockImplementation(async (target: string) => ok({
    data: new URL(target).pathname === '/search' ? [{ id: 12, title: 'Track', artist: { name: 'Artist' } }] : [],
  }));
  const data = await OctaveMusicService.searchFull('Track');
  expect(data.tracks[0]?.id).toBe('12');
  expect(requestedUrls().some((url) => url.includes('itunes.apple.com'))).toBe(false);
});

describe('musicTrackFromJson', () => {
  it('reads the nested album/artist shape a search row uses', () => {
    const track = musicTrackFromJson({
      id: 908604612,
      title: 'Blinding Lights',
      duration: 200,
      explicit_lyrics: true,
      preview: 'https://cdnt-preview.dzcdn.net/x.mp3',
      artist: { id: 4050205, name: 'The Weeknd' },
      album: { id: 115243282, title: 'After Hours', cover_big: 'https://cdn/cover-big.jpg' },
    });

    expect(track).toMatchObject({
      id: '908604612',
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      artistId: '4050205',
      album: 'After Hours',
      albumId: '115243282',
      durationSeconds: 200,
      explicit: true,
      coverUrl: 'https://cdn/cover-big.jpg',
      previewUrl: 'https://cdnt-preview.dzcdn.net/x.mp3',
    });
  });

  it('prefers cover_xl over the smaller sizes', () => {
    const track = musicTrackFromJson({
      id: 1,
      title: 'x',
      duration: 1,
      album: { cover_small: 'https://cdn/s.jpg', cover_xl: 'https://cdn/xl.jpg' },
    });
    expect(track.coverUrl).toBe('https://cdn/xl.jpg');
  });

  it('upgrades an http cover to https', () => {
    const track = musicTrackFromJson({ id: 1, title: 'x', duration: 1, cover_big: 'http://cdn/c.jpg' });
    expect(track.coverUrl).toBe('https://cdn/c.jpg');
  });

  it('falls back to the flat shape and then to safe defaults', () => {
    expect(musicTrackFromJson({ id: 2, title_short: 'Short', duration: '90' })).toMatchObject({
      title: 'Short',
      artist: 'Unknown Artist',
      album: 'Single',
      durationSeconds: 90,
    });
    expect(musicTrackFromJson({})).toMatchObject({ title: 'Unknown Track', durationSeconds: 0 });
  });

  it('treats explicit: 1 as explicit', () => {
    expect(musicTrackFromJson({ id: 1, title: 'x', duration: 1, explicit: 1 }).explicit).toBe(true);
    expect(musicTrackFromJson({ id: 1, title: 'x', duration: 1, explicit: 0 }).explicit).toBe(false);
  });

  it('formats a duration, or shows --:-- when unknown', () => {
    expect(formattedDuration({ durationSeconds: 200 })).toBe('03:20');
    expect(formattedDuration({ durationSeconds: 0 })).toBe('--:--');
  });
});

describe('deezerApiClient', () => {
  it('builds the search URL with the query and limit', async () => {
    fetchMock.mockResolvedValue(ok({ data: [] }));
    await deezer.searchTracks('blinding lights', 30);

    const [url] = requestedUrls();
    expect(url).toBe('https://api.deezer.com/search?q=blinding%20lights&limit=30');
  });

  it('skips the request entirely for a blank query', async () => {
    expect(await deezer.searchTracks('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty list on a non-200 or a malformed body', async () => {
    fetchMock.mockResolvedValueOnce(status(500));
    expect(await deezer.searchTracks('x')).toEqual([]);

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, data: 'not json' });
    expect(await deezer.searchTracks('x')).toEqual([]);
  });

  it('maps chart tracks and honours the limit', async () => {
    fetchMock.mockResolvedValue(ok({ data: [{ id: 1, title: 'A', duration: 100 }] }));
    const tracks = await deezer.getChartTracks(25);
    expect(tracks).toHaveLength(1);
    expect(requestedUrls()[0]).toBe('https://api.deezer.com/chart/0/tracks?limit=25');
  });

  it('drops the pseudo-genre with id 0', async () => {
    fetchMock.mockResolvedValue(
      ok({ data: [{ id: 0, name: 'All' }, { id: 132, name: 'Pop' }] }),
    );
    const genres = await deezer.getGenres();
    expect(genres.map((genre) => genre.id)).toEqual(['132']);
  });

  it('backfills album art on album tracks that omit their album', async () => {
    fetchMock.mockResolvedValue(
      ok({
        id: 5,
        title: 'After Hours',
        cover_big: 'https://cdn/after-hours.jpg',
        tracks: { data: [{ id: 1, title: 'Blinding Lights', duration: 200 }] },
      }),
    );

    const details = await deezer.getAlbumDetails('5');
    expect(details?.tracks[0].album).toBe('After Hours');
    expect(details?.tracks[0].coverUrl).toBe('https://cdn/after-hours.jpg');
  });

  it('falls back to the separate tracks endpoint when the album omits them', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ id: 5, title: 'Album', cover_big: 'https://cdn/a.jpg' }))
      .mockResolvedValueOnce(ok({ data: [{ id: 9, title: 'Song', duration: 120 }] }));

    const details = await deezer.getAlbumDetails('5');
    expect(details?.tracks).toHaveLength(1);
    expect(requestedUrls()[1]).toBe('https://api.deezer.com/album/5/tracks?limit=100');
  });

  it('returns null when the album payload has no id', async () => {
    fetchMock.mockResolvedValue(ok({ error: 'no data' }));
    expect(await deezer.getAlbumDetails('nope')).toBeNull();
  });

  it('fetches artist details, top tracks, albums and related in one pass', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/artist/42')) return Promise.resolve(ok({ id: 42, name: 'Artist' }));
      if (url.includes('/top')) return Promise.resolve(ok({ data: [{ id: 1, title: 'Top', duration: 60 }] }));
      if (url.includes('/albums')) return Promise.resolve(ok({ data: [{ id: 2, title: 'Album' }] }));
      if (url.includes('/related')) return Promise.resolve(ok({ data: [{ id: 3, name: 'Related' }] }));
      return Promise.resolve(status(404));
    });

    const details = await deezer.getArtistDetails('42');
    expect(details?.artist.name).toBe('Artist');
    expect(details?.topTracks).toHaveLength(1);
    expect(details?.albums).toHaveLength(1);
    expect(details?.relatedArtists[0].name).toBe('Related');
  });
});

describe('convertytmp3Client.getStreamUrl', () => {
  /** Wires the auth → init → convert handshake. */
  function handshake(options: {
    convert?: unknown;
    progress?: unknown[];
    progressStatus?: number[];
  }) {
    let progressIndex = 0;
    fetchMock.mockImplementation((url: string) => {
      const target = String(url);
      if (target.includes('/api/v1/auth')) return Promise.resolve(ok({ key: 'token-abc' }));
      if (target.includes('/api/v1/init')) return Promise.resolve(ok({ convertURL: 'https://epsilon.example/convert' }));
      if (target.includes('/convert')) return Promise.resolve(ok(options.convert ?? {}));
      if (target.includes('/progress')) {
        const index = Math.min(progressIndex, (options.progress ?? []).length - 1);
        progressIndex += 1;
        const code = options.progressStatus?.[index] ?? 200;
        if (code !== 200) return Promise.resolve(status(code));
        return Promise.resolve(ok((options.progress ?? [])[index] ?? {}));
      }
      return Promise.resolve(status(404));
    });
  }

  it('returns a downloadURL handed back directly', async () => {
    handshake({ convert: { downloadURL: 'https://files.example/song.mp3' } });
    expect(await getStreamUrl('abcdefghijk')).toBe('https://files.example/song.mp3');
  });

  it('follows a redirect chain before reading the result', async () => {
    let converts = 0;
    fetchMock.mockImplementation((url: string) => {
      const target = String(url);
      if (target.includes('/api/v1/auth')) return Promise.resolve(ok({ key: 'token-abc' }));
      if (target.includes('/api/v1/init')) return Promise.resolve(ok({ convertURL: 'https://epsilon.example/convert' }));
      if (target.includes('/convert')) {
        converts += 1;
        if (converts === 1) {
          return Promise.resolve(ok({ redirect: 1, redirectURL: 'https://epsilon.example/convert?step=2' }));
        }
        return Promise.resolve(ok({ downloadURL: 'https://files.example/after-redirect.mp3' }));
      }
      return Promise.resolve(status(404));
    });

    expect(await getStreamUrl('abcdefghijk')).toBe('https://files.example/after-redirect.mp3');
    expect(converts).toBe(2);
  });

  it('polls progressURL until status 3 delivers the download URL', async () => {
    vi.useFakeTimers();
    try {
      handshake({
        convert: { progressURL: 'https://epsilon.example/progress' },
        progress: [{ status: 1 }, { status: 2 }, { status: 3, downloadURL: 'https://files.example/polled.mp3' }],
      });

      const pending = getStreamUrl('abcdefghijk');
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBe('https://files.example/polled.mp3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after ten progress polls', async () => {
    vi.useFakeTimers();
    try {
      handshake({
        convert: { progressURL: 'https://epsilon.example/progress' },
        progress: [{ status: 1 }],
      });

      const pending = getStreamUrl('abcdefghijk');
      await vi.advanceTimersByTimeAsync(20000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when a negative progress status reports failure', async () => {
    vi.useFakeTimers();
    try {
      handshake({
        convert: { progressURL: 'https://epsilon.example/progress' },
        progress: [{ status: -1 }],
      });

      const pending = getStreamUrl('abcdefghijk');
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when the auth handshake fails', async () => {
    fetchMock.mockResolvedValue(status(403));
    expect(await getStreamUrl('abcdefghijk')).toBeNull();
  });

  it('returns null for an empty video id without any request', async () => {
    expect(await getStreamUrl('')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
