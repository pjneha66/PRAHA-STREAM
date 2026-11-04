// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FlowView from '../components/FlowView';
import { youtubeMedia, youtubeStream } from '../services/flowService';
import {
  formatDuration, normalizeChannelInput, parseIsoDuration, parseVideoId, youtubeChannelUrl,
  youtubeEmbedUrl, youtubeWatchUrl,
} from '../services/youtubeService';
import {
  DEFAULT_MIRRORS, MIRROR_STORAGE_KEY, describeFailure, durationSeconds, isMusicVideo, normalizeMirrorUrl,
  pipedVideo, readMirrors, relativeTime, withMirrorFallback,
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
    await expect(withMirrorFallback(direct, mirror)).rejects.toThrow('YouTube responded with 500. Mirrors: mirror down.');
  });

  it('turns opaque browser network errors into an explanation', () => {
    expect(describeFailure(new TypeError('Failed to fetch'))).toBe('the request was blocked before it reached the server (CORS or offline)');
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
