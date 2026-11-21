import { describe, it, expect, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  sources: [
    { id: 'a', name: 'Source A', note: '', scraper: vi.fn(async () => [{ url: 'https://a/one.m3u8', server: 'A', quality: '1080p', type: 'hls' }]) },
    { id: 'b', name: 'Source B', note: '', scraper: vi.fn(async () => []) },
    { id: 'c', name: 'Source C', note: '', scraper: vi.fn(async () => { throw new Error('down'); }) },
  ],
}));

vi.mock('../services/filmSources', () => ({ FILM_SOURCES: mock.sources }));
vi.mock('../services/p2p/torrServerController', () => ({
  torrServerController: { ensureStarted: vi.fn(async () => true), client: vi.fn(() => null) },
}));

import { rankStreams, scrapeFilmSources, filmQueryFromMedia } from '../services/sourceOrchestrator';
import type { StreamResult } from '../types';

function stream(sourceType: StreamResult['sourceType'], id: string): StreamResult {
  return { id, url: `https://${id}`, title: id, sourceName: id, sourceType };
}

describe('source priority chain', () => {
  it('sorts scrapers before debrid, TorrServer, addons and embeds', () => {
    const ranked = rankStreams([
      stream('embed', 'embed'),
      stream('stremio', 'stremio'),
      stream('playtorrio', 'playtorrio'),
      stream('torrserver', 'torr'),
      stream('debrid', 'debrid'),
      stream('scraper', 'scraper'),
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual([
      'scraper', 'debrid', 'torr', 'stremio', 'playtorrio', 'embed',
    ]);
  });

  it('keeps the provider order for streams on the same stage', () => {
    const ranked = rankStreams([stream('scraper', 'b'), stream('scraper', 'a')]);
    expect(ranked.map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('collects scraper results in FILM_SOURCES order and records failures', async () => {
    const result = await scrapeFilmSources({ id: '123', title: 'A Film' });
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]).toMatchObject({
      sourceType: 'scraper',
      sourceName: 'Source A · A',
      url: 'https://a/one.m3u8',
      quality: '1080p',
      format: 'hls',
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ source: 'Source C', message: 'down' });
  });

  it('honours enabledIds filtering', async () => {
    mock.sources[0].scraper.mockClear();
    const result = await scrapeFilmSources(
      { id: '123', title: 'A Film' },
      { enabledIds: ['b'] },
    );
    expect(result.streams).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
    expect(mock.sources[0].scraper).not.toHaveBeenCalled();
  });

  it('builds a FilmQuery from a media item', () => {
    expect(filmQueryFromMedia({
      id: 'tmdb:42', title: 'Show', type: 'series', tmdbId: 42,
    } as never, 2, 5)).toMatchObject({
      id: '42', title: 'Show', season: 2, episode: 5,
    });
  });
});
