import { describe, expect, it } from 'vitest';
import { streamPriority, filterAndSortStreams } from '../services/sourcePreferences';
import { EMBED_PRESETS, buildEmbedUrl, validateEmbedTemplate } from '../services/embedProviders';
import { findPlayTorrioStreams } from '../services/playtorrioScrapers';
import type { StreamResult, MediaItem } from '../types';

describe('PlayTorrio VOD Scrapers & 4KHDHub Priority', () => {
  it('prioritizes 4KHDHub 4K UHD stream at the absolute top of results', () => {
    const streams: StreamResult[] = [
      {
        id: '1',
        title: 'Movie 1080p Stremio Addon',
        url: 'https://stream.example.com/1080p.m3u8',
        sourceName: 'Torrentio',
        sourceType: 'stremio',
        quality: '1080p',
        seeders: 150,
      },
      {
        id: '2',
        title: 'Movie 4K Random Provider',
        url: 'https://stream.example.com/4k.m3u8',
        sourceName: 'Random4K',
        sourceType: 'stremio',
        quality: '4K',
        seeders: 50,
      },
      {
        id: '3',
        title: '4KHDHub · 4K UHD · HubCloud',
        url: 'https://hubcloud.example.com/stream-4k.mp4',
        sourceName: '4KHDHub',
        sourceType: 'playtorrio',
        quality: '4K',
        provider: '4KHDHub (PlayTorrio)',
        seeders: 0,
      },
      {
        id: '4',
        title: 'Movie 720p',
        url: 'https://stream.example.com/720p.m3u8',
        sourceName: 'FastStream',
        sourceType: 'nuvio',
        quality: '720p',
      },
    ];

    expect(streamPriority(streams[2])).toBe(100); // 4KHDHub 4K = 100
    expect(streamPriority(streams[1])).toBe(80);  // Other 4K = 80
    expect(streamPriority(streams[0])).toBe(60);  // 1080p = 60
    expect(streamPriority(streams[3])).toBe(40);  // 720p = 40

    const sorted = filterAndSortStreams(streams, {
      quality: 'all',
      provider: 'all',
      language: 'all',
      codec: 'all',
      subtitles: 'all',
    }, '', 'en');

    // 4KHDHub 4K MUST be first
    expect(sorted[0].sourceName).toBe('4KHDHub');
    expect(sorted[0].quality).toBe('4K');
    expect(sorted[1].quality).toBe('4K');
    expect(sorted[2].quality).toBe('1080p');
  });

  it('embed presets include 4KHDHub at the top and all 9 playtorrio embed providers', () => {
    expect(EMBED_PRESETS[0].id).toBe('fourkhdhub');
    expect(EMBED_PRESETS[0].name).toContain('4KHD Hub');

    const providerIds = EMBED_PRESETS.map((p) => p.id);
    expect(providerIds).toContain('fourkhdhub');
    expect(providerIds).toContain('movienight');
    expect(providerIds).toContain('videasy');
    expect(providerIds).toContain('vidcore');
    expect(providerIds).toContain('flystream');
    expect(providerIds).toContain('multiembed');
    expect(providerIds).toContain('vidsrc-me');
    expect(providerIds).toContain('xdownloader');

    // Test URL generation for movie and series on 4KHDHub
    const media: MediaItem = {
      id: 'movie-1',
      title: 'Dune: Part Two',
      type: 'movie',
      tmdbId: 693134,
      overview: 'Mythic journey of Paul Atreides.',
      poster: 'https://image.tmdb.org/t/p/w500/dune.jpg',
      genres: ['Sci-Fi', 'Adventure'],
      source: 'tmdb',
    };
    const movieUrl = buildEmbedUrl(EMBED_PRESETS[0], media);
    expect(movieUrl).toBe('https://4khdhub.one/embed/movie/693134');

    const seriesMedia: MediaItem = {
      id: 'series-1',
      title: 'Fallout',
      type: 'series',
      tmdbId: 106379,
      overview: 'In a future post-apocalyptic Los Angeles.',
      poster: 'https://image.tmdb.org/t/p/w500/fallout.jpg',
      genres: ['Sci-Fi', 'Action'],
      source: 'tmdb',
    };
    const seriesUrl = buildEmbedUrl(EMBED_PRESETS[0], seriesMedia, 1, 2);
    expect(seriesUrl).toBe('https://4khdhub.one/embed/tv/106379/1/2');

    // Verify all templates pass validation
    for (const preset of EMBED_PRESETS) {
      expect(() => validateEmbedTemplate(preset.movie, 'movie')).not.toThrow();
      expect(() => validateEmbedTemplate(preset.series, 'series')).not.toThrow();
    }
  });

  it('findPlayTorrioStreams runs scrapers and handles empty search safely', async () => {
    const results = await findPlayTorrioStreams('', 'movie');
    expect(Array.isArray(results)).toBe(true);
  }, 15000);
});
