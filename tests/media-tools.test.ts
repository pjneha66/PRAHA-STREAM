// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaItem, StreamResult } from '../types';
import { prahaRpc } from '../services/androidBridge';
import { parseDubCues } from '../services/dubbing';
import { parseTelegramPage, telegramChannel, telegramLink } from '../services/telegramStreams';
import { canDownloadVideo, matchEpisodeDownload, planVideoDownload, queueVideoDownloads, videoDownloads } from '../services/videoDownloads';

vi.mock('../services/androidBridge', () => ({ prahaRpc: vi.fn() }));

const episode: MediaItem = { id: 'show', title: 'Example show', source: 'tmdb', type: 'series', genres: [], overview: '', poster: '' };
const stream: StreamResult = {
  id: 'stream', title: '1080p', sourceName: 'Source', sourceType: 'scraper', url: 'https://example.com/video.mkv?signed=1',
};

beforeEach(() => localStorage.clear());

describe('video downloads', () => {
  it('matches the provider and quality without switching the selected audio language', () => {
    const chosen = { ...stream, language: 'Hindi' };
    const mirror = { ...stream, id: 'mirror', language: 'Hindi', sourceName: 'Mirror' };
    const lower = { ...chosen, id: 'lower', title: '720p' };
    expect(matchEpisodeDownload([{ ...stream, language: 'English' }, mirror, lower], chosen)).toBe(lower);
    expect(matchEpisodeDownload([{ ...stream, language: 'English' }], chosen)).toBeUndefined();
  });

  it('keeps successful queue entries and returns only failed episodes for retry', async () => {
    vi.mocked(prahaRpc).mockResolvedValueOnce('hikari-41').mockResolvedValueOnce('');
    const first = planVideoDownload(episode, { ...stream, referer: 'https://example.com/' }, 2, 3);
    const second = planVideoDownload(episode, stream, 2, 4);

    expect(await queueVideoDownloads([first, second])).toEqual([second]);
    const [method, [body]] = vi.mocked(prahaRpc).mock.calls[0];
    expect(method).toBe('queueHikariDownload');
    expect(JSON.parse(body as string)).toMatchObject({ title: 'Example show S2E3', url: stream.url, headers: { Referer: 'https://example.com/' } });
    expect(videoDownloads()).toEqual([]);
    expect(canDownloadVideo({ ...stream, url: 'https://example.com/master.m3u8?x=1' })).toBe(true);
    expect(canDownloadVideo({ ...stream, url: 'https://example.com/master.mpd' })).toBe(false);
  });
});

describe('subtitle dubbing', () => {
  it('preserves the cue timing for SRT and strips subtitle markup from speech', () => {
    expect(parseDubCues('1\n00:00:01,200 --> 00:00:03,100\n<i>Hello</i>\nworld')).toEqual([
      { start: 1.2, end: 3.1, text: 'Hello world' },
    ]);
  });
});

describe('Telegram public previews', () => {
  it('opens the requested post only and reports videos without a public media URL', () => {
    const link = telegramLink('https://t.me/example/20');
    expect(link).toEqual({ channel: 'example', post: 20 });
    const html = `<div class="tgme_widget_message" data-post="example/19"><video src="https://video.example.com/other.mp4"></video></div>
      <div class="tgme_widget_message" data-post="example/20"><div class="message_media_not_supported"></div></div>`;
    expect(parseTelegramPage(html, 'example', link?.post)).toMatchObject({ before: 0, videos: [], withheld: 1 });
  });

  it('accepts public channel links and extracts direct video posts with a pagination cursor', () => {
    expect(telegramChannel('https://t.me/s/example/20')).toBe('example');
    expect(telegramChannel('https://example.com/s/example')).toBe('');
    const page = parseTelegramPage(`
      <div class="tgme_widget_message" data-post="example/19"></div>
      <div class="tgme_widget_message" data-post="example/20">
        <video src="https://video.example.com/sample.mp4"></video>
        <div class="tgme_widget_message_text">Video title</div>
      </div>
    `, 'example');
    expect(page.before).toBe(19);
    expect(page.videos).toEqual([{ id: 20, title: 'Video title', url: 'https://video.example.com/sample.mp4', duration: '' }]);
  });
});
