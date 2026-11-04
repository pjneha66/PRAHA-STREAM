// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FlowView, { youtubeMedia, youtubeStream } from '../components/FlowView';
import {
  formatDuration, normalizeChannelInput, parseIsoDuration, parseVideoId, youtubeChannelUrl,
  youtubeEmbedUrl, youtubeWatchUrl,
} from '../services/youtubeService';

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
