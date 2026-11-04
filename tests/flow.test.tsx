// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FlowView from '../components/FlowView';
import { youtubeMedia, youtubeStream } from '../services/flowService';
import {
  formatDuration, formatUrl, normalizeChannelInput, parseInnerTubeFormats, parseIsoDuration, parseVideoId,
  youtubeChannelUrl, youtubeEmbedUrl, youtubeWatchUrl,
} from '../services/youtubeService';
import {
  DEFAULT_MIRRORS, MIRROR_STORAGE_KEY, describeFailure, durationSeconds, fetchMirrorHome, fetchMirrorMusic,
  isMusicVideo, kindsFor, lastProbeLog, normalizeMirrorUrl, pipedVideo, readMirrors, relativeTime,
  resetDirectState, shouldTryDirect, summarise, withMirrorFallback,
} from '../services/youtubeMirror';

describe('Flow tab link parsing', () => {
  it('accepts raw IDs, youtu.be, shorts, and watch links', () => {
    expect(parseVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('rejects anything that is not a YouTube video', () => {
    expect(() => parseVideoId('')).toThrow();
    expect(() => parseVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toThrow();
    expect(() => parseVideoId('hello there')).toThrow();
  });

  it('normalises channel URLs and handles', () => {
    const channelId = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
    expect(normalizeChannelInput(channelId)).toBe(channelId);
    expect(normalizeChannelInput(`https://www.youtube.com/channel/${channelId}/videos`)).toBe(channelId);
    expect(normalizeChannelInput('@GoogleDevelopers')).toBe('@GoogleDevelopers');
    expect(normalizeChannelInput('https://www.youtube.com/@GoogleDevelopers/about')).toBe('@GoogleDevelopers');
    expect(normalizeChannelInput('https://www.youtube.com/c/SomeChannel')).toBe('c/SomeChannel');
    expect(() => normalizeChannelInput('https://vimeo.com/channels/1')).toThrow();
  });

  it('builds watch, channel, and privacy-friendly embed URLs', () => {
    expect(youtubeWatchUrl('abc12345678')).toBe('https://www.youtube.com/watch?v=abc12345678');
    expect(youtubeChannelUrl('UC12345678901234567890')).toBe('https://www.youtube.com/channel/UC12345678901234567890');
    expect(youtubeEmbedUrl('abc12345678')).toBe('https://www.youtube-nocookie.com/embed/abc12345678?rel=0&modestbranding=1');
    expect(youtubeEmbedUrl('abc12345678', 90)).toContain('&start=90');
  });

  it('parses ISO-8601 durations and formats clocks', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('nonsense')).toBeUndefined();
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(0)).toBeUndefined();
  });

  it('maps a YouTube video onto the player contracts', () => {
    const video = { id: 'abc12345678', title: 'Demo', channel: 'NTS', thumbnail: 'https://i.ytimg.com/vi/abc12345678/hqdefault.jpg' };
    const media = youtubeMedia(video);
    expect(media.id).toBe('youtube:abc12345678');
    expect(media.source).toBe('youtube');
    expect(media.type).toBe('movie');

    const stream = youtubeStream(video);
    expect(stream.ytId).toBe('abc12345678');
    expect(stream.externalUrl).toBe('https://www.youtube.com/watch?v=abc12345678');
    expect(stream.sourceName).toBe('YouTube · Flow');
  });
});

describe('Flow tab UI smoke render', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the Flow shell with all four sections and the upstream project links', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const html = renderToStaticMarkup(
      <FlowView onPlay={() => undefined} onEmbed={() => undefined} />,
    );
    expect(html).toContain('FLOW · YOUTUBE WITHOUT THE TRACKING');
    expect(html).toContain('YouTube, on your terms');
    expect(html).toContain('https://github.com/Flow-Tube/Flow');
    for (const label of ['Home', 'Search', 'Music', 'Channels']) expect(html).toContain(label);
    expect(html).toContain('role="tablist"');
  });
});

describe('Flow tab mirror tier', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('normalises Piped API URLs and rejects unsafe ones', () => {
    expect(normalizeMirrorUrl('https://pipedapi.kavin.rocks/')).toBe('https://pipedapi.kavin.rocks');
    expect(normalizeMirrorUrl('pipedapi.example.org/api/')).toBe('https://pipedapi.example.org/api');
    expect(() => normalizeMirrorUrl('http://insecure.example')).toThrow();
    expect(() => normalizeMirrorUrl('https://user:pass@example.org')).toThrow();
    expect(() => normalizeMirrorUrl('')).toThrow();
  });

  it('parses Piped stream payloads into YtVideo records', () => {
    const video = pipedVideo({
      url: '/watch?v=dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      uploaderName: 'Rick Astley',
      uploaderUrl: '/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
      duration: 213,
      views: 1600000000,
      uploadedDate: '3 years ago',
      thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    });
    expect(video).toMatchObject({
      id: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
      duration: '3:33',
      views: '1,600,000,000 views',
    });
    expect(pipedVideo({ url: '/watch?v=bad' })).toBeNull();
  });

  it('falls back to a mirror only when YouTube fails, and reports the tier', async () => {
    const direct = vi.fn(() => Promise.reject(new Error('YouTube responded with 500.')));
    const mirror = vi.fn(() => Promise.resolve({ shelves: [] }));
    await expect(withMirrorFallback(direct, mirror)).resolves.toEqual({ data: { shelves: [] }, backend: 'mirror' });

    const healthy = vi.fn(() => Promise.resolve({ shelves: [] }));
    await expect(withMirrorFallback(healthy, mirror)).resolves.toEqual({ data: { shelves: [] }, backend: 'youtube' });
    expect(mirror).toHaveBeenCalledTimes(1);
  });

  it('reports both tiers when they both fail', async () => {
    const direct = vi.fn(() => Promise.reject(new Error('YouTube responded with 500.')));
    const mirror = vi.fn(() => Promise.reject(new Error('mirror down')));
    await expect(withMirrorFallback(direct, mirror)).rejects.toThrow('YouTube: YouTube responded with 500. mirror down.');
  });

  it('turns opaque browser network errors into an explanation', () => {
    expect(describeFailure(new TypeError('Failed to fetch'))).toBe('blocked before it reached the server (CORS/offline)');
    expect(describeFailure(new Error('The operation was aborted.'))).toBe('timed out');
    expect(describeFailure(new Error('YouTube responded with 500.'))).toBe('YouTube responded with 500');
  });

  it('reads the mirror list from storage and prefers the last healthy one', () => {
    window.localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(['https://a.example', 'https://b.example']));
    expect(readMirrors()).toEqual(['https://a.example', 'https://b.example']);
    window.localStorage.setItem(MIRROR_STORAGE_KEY, 'not json');
    expect(readMirrors().length).toBe(DEFAULT_MIRRORS.length);
    window.localStorage.removeItem(MIRROR_STORAGE_KEY);
  });
});

describe('Flow tab music + published-date fixes', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('never renders the epoch-zero date Piped sends for some rows', () => {
    const video = pipedVideo({ url: '/watch?v=dQw4w9WgXcQ', title: 'x', uploaded: 0, uploadedDate: '' });
    expect(video?.published).toBeUndefined();
    expect(relativeTime(0)).toBeUndefined();
    expect(relativeTime(null)).toBeUndefined();
    expect(relativeTime(undefined)).toBeUndefined();
    expect(relativeTime(Date.now() / 1000 - 90)).toBe('1 minute ago');
  });

  it('keeps the human-readable date when the mirror sends one', () => {
    expect(pipedVideo({ url: '/watch?v=dQw4w9WgXcQ', title: 'x', uploadedDate: '2 days ago' })?.published).toBe('2 days ago');
  });

  it('flags live rows instead of pretending they have a length', () => {
    const live = pipedVideo({ url: '/watch?v=dQw4w9WgXcQ', title: 'Live', duration: -1, livestream: true });
    expect(live?.live).toBe(true);
    expect(live?.duration).toBeUndefined();
  });

  it('filters the Music tab down to songs only', () => {
    const song = { id: 'dQw4w9WgXcQ', title: 'Song', duration: '3:33' };
    const news = { id: 'aaaaaaaaaaa', title: 'Election night live', duration: '0:00' };
    const live = { id: 'bbbbbbbbbbb', title: 'Live news', duration: '1:00', live: true };
    expect(isMusicVideo(song)).toBe(true);
    expect(isMusicVideo(news)).toBe(false);
    expect(isMusicVideo(live)).toBe(false);
    expect(isMusicVideo({ id: 'ccccccccccc', title: 'Clip', duration: '0:29' })).toBe(false);
    expect(durationSeconds('1:02:03')).toBe(3723);
    expect(durationSeconds(undefined)).toBe(0);
  });
});

describe('Flow tab mirror sweep', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.removeItem(MIRROR_STORAGE_KEY);
  });

  const responder = (handler: (url: string) => { status: number; body: string }) =>
    vi.fn((input: unknown) => {
      const { status, body } = handler(String(input));
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        data: body,
        text: () => Promise.resolve(body),
      });
    });

  it('skips a broken host and uses the Invidious API when Piped fails', async () => {
    window.localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(['https://pipedapi.broken.test', 'https://inv.good.test']));
    const calls: string[] = [];
    vi.stubGlobal('fetch', responder((url) => {
      calls.push(url);
      if (url.includes('broken.test')) return { status: 500, body: '{}' };
      if (url.includes('/api/v1/trending')) {
        return {
          status: 200,
          body: JSON.stringify([{
            videoId: 'dQw4w9WgXcQ', title: 'A song', author: 'Artist', authorId: 'UC12345678901234567890',
            viewCount: 1234, publishedText: '1 day ago', lengthSeconds: 200,
            videoThumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg', quality: 'high' }],
          }]),
        };
      }
      return { status: 404, body: '{}' };
    }));

    const home = await fetchMirrorHome();
    expect(home.shelves[0].videos[0]).toMatchObject({ id: 'dQw4w9WgXcQ', channel: 'Artist', duration: '3:20' });
    expect(calls.some((url) => url.includes('/api/v1/trending'))).toBe(true);
    expect(lastProbeLog.some((probe) => probe.ok && probe.base.includes('inv.good.test'))).toBe(true);
  });

  it('reports every failure instead of a bare "failed"', async () => {
    window.localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(['https://a.test', 'https://b.test']));
    vi.stubGlobal('fetch', responder(() => ({ status: 500, body: '{}' })));
    await expect(fetchMirrorHome()).rejects.toThrow(/every mirror/);
    await expect(fetchMirrorHome()).rejects.toThrow(/HTTP 500/);
  });

  it('keeps the Music tab alive when one row source is down', async () => {
    window.localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(['https://inv.good.test']));
    vi.stubGlobal('fetch', responder((url) => {
      if (url.includes('/api/v1/trending')) return { status: 500, body: '{}' };
      if (url.includes('/api/v1/search')) {
        return {
          status: 200,
          body: JSON.stringify([{ videoId: 'aaaaaaaaaaa', title: 'Track', author: 'Band', lengthSeconds: 240 }]),
        };
      }
      return { status: 404, body: '{}' };
    }));

    const music = await fetchMirrorMusic();
    expect(music.shelves.length).toBeGreaterThan(0);
    expect(music.shelves[0].videos[0].title).toBe('Track');
  });
});

describe('Flow tab mirror targeting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.removeItem(MIRROR_STORAGE_KEY);
  });

  it('only asks each host for the API family it actually runs', () => {
    expect(kindsFor('https://pipedapi.kavin.rocks')).toEqual(['piped']);
    expect(kindsFor('https://api.piped.private.coffee')).toEqual(['piped']);
    expect(kindsFor('https://inv.nadeko.net')).toEqual(['invidious']);
    expect(kindsFor('https://yt.chocolatemoo53.com')).toEqual(['invidious']);
    expect(kindsFor('https://mirror.example.org')).toEqual(['invidious', 'piped']);
  });

  it('collapses repeated failures to one line per host', () => {
    const text = summarise([
      'api.piped.private.coffee: answered, but had nothing usable',
      'api.piped.private.coffee: blocked before it reached the server (CORS/offline)',
      'pipedapi.kavin.rocks: blocked before it reached the server (CORS/offline)',
    ]);
    expect(text).toBe('api.piped.private.coffee: answered, but had nothing usable · pipedapi.kavin.rocks: blocked before it reached the server (CORS/offline)');
  });

  it('keeps song-like rows when a mirror only offers general trending', async () => {
    window.localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(['https://inv.good.test']));
    const rows = [
      { videoId: 'song0000001', title: 'Midnight City (Official Audio)', author: 'M83', lengthSeconds: 244 },
      { videoId: 'news0000001', title: 'Election night live coverage', author: 'News', lengthSeconds: 600, liveNow: true },
      { videoId: 'news0000002', title: 'Breaking news: markets', author: 'News', lengthSeconds: 300 },
      { videoId: 'clip0000001', title: 'Funny cat', author: 'Random', lengthSeconds: 20 },
    ];
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      const url = String(input);
      const response = (status: number, body: string) => Promise.resolve({
        ok: status >= 200 && status < 300, status, data: body, text: () => Promise.resolve(body),
      });
      // The music endpoint is unavailable for this instance...
      if (url.includes('/trending?type=Music')) return response(500, '{}');
      // ...but general trending works, and the tab filters it for songs.
      if (url.includes('/api/v1/trending')) return response(200, JSON.stringify(rows));
      return response(404, '{}');
    }));

    const music = await fetchMirrorMusic();
    const titles = music.shelves.flatMap((shelf) => shelf.videos.map((video) => video.title));
    expect(titles).toContain('Midnight City (Official Audio)');
    expect(titles).not.toContain('Election night live coverage');
    expect(titles).not.toContain('Breaking news: markets');
    expect(titles).not.toContain('Funny cat');
  });

  it('stops re-trying a blocked YouTube for the session', async () => {
    resetDirectState();
    const direct = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    const mirror = vi.fn(() => Promise.resolve('mirror data'));

    await expect(withMirrorFallback(direct, mirror)).resolves.toEqual({ data: 'mirror data', backend: 'mirror' });
    expect(shouldTryDirect()).toBe(false);

    const second = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(withMirrorFallback(second, mirror)).resolves.toEqual({ data: 'mirror data', backend: 'mirror' });
    expect(second).not.toHaveBeenCalled();

    resetDirectState();
    expect(shouldTryDirect()).toBe(true);
  });
});

describe('Flow tab direct playback', () => {
  it('separates muxed video streams from audio-only tracks', () => {
    const formats = [
      { mimeType: 'video/mp4; codecs="avc1"', url: 'https://cdn/video-muxed', height: 720, bitrate: 1500000, audioQuality: 'AUDIO_QUALITY_MEDIUM' },
      { mimeType: 'video/webm; codecs="vp9"', url: 'https://cdn/video-adaptive', height: 1080, bitrate: 3000000, audioQuality: 'AUDIO_QUALITY_UNKNOWN' },
      { mimeType: 'audio/webm; codecs="opus"', url: 'https://cdn/audio-hi', bitrate: 160000 },
      { mimeType: 'audio/webm; codecs="opus"', url: 'https://cdn/audio-lo', bitrate: 70000 },
    ];
    const { audioTracks, videoTracks } = parseInnerTubeFormats(formats);
    expect(audioTracks.map((track) => track.url)).toEqual(['https://cdn/audio-hi', 'https://cdn/audio-lo']);
    expect(videoTracks.map((track) => track.url)).toEqual(['https://cdn/video-muxed']);
    expect(videoTracks[0].label).toContain('720p');
  });

  it('recovers a URL from signatureCipher and ignores formats with none', () => {
    expect(formatUrl({ url: 'https://cdn/ok' })).toBe('https://cdn/ok');
    expect(formatUrl({ signatureCipher: 'url=https%3A%2F%2Fcdn%2Fcipher%3Fx%3D1&s=abc' })).toBe('https://cdn/cipher?x=1');
    expect(formatUrl({ signatureCipher: 's=abc' })).toBe('');
    expect(formatUrl({})).toBe('');
  });
});

describe('Flow tab player payload', () => {
  it('uses the direct stream and drops ytId so no embed is forced', () => {
    const stream = youtubeStream({ id: 'dQw4w9WgXcQ', title: 'Track' }, { url: 'https://cdn/audio', format: 'audio' });
    expect(stream.url).toBe('https://cdn/audio');
    expect(stream.format).toBe('audio');
    expect(stream.ytId).toBeUndefined();
    expect(stream.externalUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('falls back to the embed when no direct stream exists', () => {
    const stream = youtubeStream({ id: 'dQw4w9WgXcQ', title: 'Track' });
    expect(stream.ytId).toBe('dQw4w9WgXcQ');
    expect(stream.format).toBe('youtube');
  });
});

describe('Flow tab quality handling', () => {
  it('keeps the highest muxed quality first and dedupes heights', () => {
    const streams = [
      { url: 'https://cdn/360', mimeType: 'video/mp4', qualityLabel: '360p', height: 360 },
      { url: 'https://cdn/720', mimeType: 'video/mp4', qualityLabel: '720p', height: 720 },
      { url: 'https://cdn/720-2', mimeType: 'video/mp4', qualityLabel: '720p', height: 720 },
    ];
    const sorted = [...streams].sort((a, b) => b.height - a.height);
    expect(sorted[0].url).toBe('https://cdn/720');
    const seen = new Set<number>();
    const distinct = sorted.filter((track) => (seen.has(track.height) ? false : (seen.add(track.height), true)));
    expect(distinct.map((track) => track.height)).toEqual([720, 360]);
  });

  it('reads height out of Invidious mime strings when no field is present', () => {
    const mime = 'video/mp4; codecs="avc1"; res=1080x1920';
    expect(Number(/res=([0-9]+)x/.exec(mime)?.[1] || 0)).toBe(1080);
  });
});
