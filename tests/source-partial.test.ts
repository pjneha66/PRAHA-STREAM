import { describe, it, expect, vi } from 'vitest';

// A slow "long lane" source (the shape Movy and Knaben have) plus a fast one.
// The fast answer must reach the UI without waiting for the slow one, or the
// modal sits on "Searching…" for the whole long budget.
const mock = vi.hoisted(() => {
  let releaseSlow: () => void = () => {};
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  return {
    releaseSlow: () => releaseSlow(),
    sources: [
      {
        id: 'fast',
        name: 'Fast',
        note: '',
        scraper: vi.fn(async () => [
          { url: 'https://fast/one.m3u8', server: 'Fast', quality: '1080p', type: 'hls' },
        ]),
      },
      {
        id: 'slow',
        name: 'Slow',
        note: '',
        timeoutMs: 20000,
        scraper: vi.fn(async () => {
          await slowGate;
          return [{ url: 'https://slow/one.m3u8', server: 'Slow', quality: '4K', type: 'hls' }];
        }),
      },
    ],
  };
});

vi.mock('../services/filmSources', () => ({ FILM_SOURCES: mock.sources }));
vi.mock('../services/p2p/torrServerController', () => ({
  torrServerController: { ensureStarted: vi.fn(async () => true), client: vi.fn(() => null) },
}));

import { scrapeFilmSources } from '../services/sourceOrchestrator';

describe('scrapeFilmSources partial publishing', () => {
  it('publishes the fast lane while the long lane is still running', async () => {
    const seen: string[][] = [];
    const finished = scrapeFilmSources(
      { id: '1', title: 'A Film' },
      { onPartial: (partial) => seen.push(partial.streams.map((s) => s.sourceName)) },
    );

    // Let the fast wave land, but keep the slow source blocked.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.flat().some((name) => name.startsWith('Fast'))).toBe(true);
    // The slow source has not reported yet, so it must not be in the partials.
    expect(seen.flat().some((name) => name.startsWith('Slow'))).toBe(false);

    // The result is only complete once the long lane is released.
    mock.releaseSlow();
    const result = await finished;
    expect(result.streams).toHaveLength(2);
  });
});
