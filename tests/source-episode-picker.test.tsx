// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MediaItem, StreamResult } from '../types';

/**
 * Season switching has to re-resolve the episode, not replay the old number.
 *
 * The episode effect deliberately does not depend on `episode`, so the previous
 * implementation read it from the effect's closure: after switching from season
 * 2 (episode 5) to season 1, the episode box kept "5" — a number that may not
 * exist in the new season, and which the source lookup then used.
 *
 * The other mocked providers return nothing, so this exercises only the picker.
 */
const seasons: Record<number, Array<{ id: number; season: number; episode: number; title: string; overview: string }>> = {
  1: [
    { id: 11, season: 1, episode: 1, title: 'S1E1', overview: '' },
    { id: 12, season: 1, episode: 2, title: 'S1E2', overview: '' },
    { id: 13, season: 1, episode: 3, title: 'S1E3', overview: '' },
  ],
  2: [
    { id: 21, season: 2, episode: 1, title: 'S2E1', overview: '' },
    { id: 22, season: 2, episode: 2, title: 'S2E2', overview: '' },
  ],
};

const tmdb = vi.hoisted(() => ({
  getSeason: vi.fn(async (_id: number | string, season: number) => [] as unknown[]),
  enrich: vi.fn(async (media: unknown) => media),
  resolveIds: vi.fn(async () => ({ tmdbId: 1, imdbId: '' })),
}));
const film = vi.hoisted(() => ({
  scrape: vi.fn(async (_query: unknown, _options: unknown) => ({ streams: [] as StreamResult[], failures: [] })),
}));

vi.mock('../services/tmdbService', () => ({ tmdbService: tmdb }));
vi.mock('../services/animeService', () => ({ animeService: { getEpisodes: async () => [] } }));
vi.mock('../services/stremioService', () => ({
  findStremioStreams: async () => [],
  supportsResource: () => false,
}));
vi.mock('../services/nuvioService', () => ({ findNuvioStreams: async () => [] }));
vi.mock('../services/playtorrioScrapers', () => ({ findPlayTorrioStreams: async () => [] }));
vi.mock('../services/cloudstreamService', () => ({
  cloudStreamAvailable: () => false,
  getLinks: async () => null,
  prefetch: async () => undefined,
  toStreamResults: () => [],
}));
vi.mock('../services/sourceOrchestrator', () => ({
  filmQueryFromMedia: () => ({ title: 'T', year: '2020' }),
  rankStreams: (streams: unknown[]) => streams,
  scrapeFilmSources: film.scrape,
}));

import SourceModal from '../components/SourceModal';

const media: MediaItem = {
  id: 'tv:1',
  tmdbId: 1,
  type: 'series',
  title: 'Test Show',
  overview: '',
  poster: '',
  genres: [],
  source: 'tmdb',
  seasons: [
    { id: 1, seasonNumber: 1, name: 'Season 1', episodeCount: 3 },
    { id: 2, seasonNumber: 2, name: 'Season 2', episodeCount: 2 },
  ],
};

function renderModal(overrides: Partial<React.ComponentProps<typeof SourceModal>> = {}) {
  return render(
    <SourceModal
      media={media}
      addons={[]}
      repositories={[]}
      nuvioSettings={{}}
      preferredLanguage="en"
      preferredSource=""
      onPreferredSourceChange={() => undefined}
      onClose={() => undefined}
      onOpenExtensions={() => undefined}
      onPlay={() => undefined}
      {...overrides}
    />,
  );
}

const seasonSelect = () => screen.getByLabelText('Season') as HTMLSelectElement;
const episodeSelect = () => screen.getByLabelText('Episode') as HTMLSelectElement;

beforeEach(() => {
  tmdb.getSeason.mockImplementation(async (_id, season) => (seasons[season] ?? []) as never);
});

afterEach(() => {
  cleanup();
  film.scrape.mockReset();
  vi.clearAllMocks();
});

it('resumes the same movie source with its refreshed link while other searches are pending', async () => {
  const saved: StreamResult = {
    id: 'saved',
    title: '1080p',
    url: 'https://old.example/video.m3u8',
    sourceType: 'scraper',
    sourceName: 'Movy · Boise',
  };
  const replacement = { ...saved, id: 'fresh', url: 'https://new.example/video.m3u8' };
  const onResume = vi.fn();
  let publish!: (result: { streams: StreamResult[] }) => void;
  let finish!: () => void;
  film.scrape.mockImplementationOnce(async (_query, options) => {
    publish = (options as { onPartial: typeof publish }).onPartial;
    await new Promise<void>((resolve) => { finish = resolve; });
    return { streams: [replacement], failures: [] };
  });

  renderModal({ media: { ...media, type: 'movie' }, retryStream: saved, onResume });
  await act(async () => publish({ streams: [saved, { ...replacement, sourceName: 'Movy · Vegas' }] }));
  expect(onResume).not.toHaveBeenCalled();
  await act(async () => publish({ streams: [replacement] }));
  expect(onResume).toHaveBeenCalledExactlyOnceWith(replacement);
  await act(async () => finish());
  expect(onResume).toHaveBeenCalledTimes(1);
});

describe('SourceModal season/episode picker', () => {
  it('resets the episode to one that exists in the new season', async () => {
    renderModal();
    await waitFor(() => expect(episodeSelect().options.length).toBe(3));

    // Pick episode 3 of season 1, then switch to the two-episode season 2.
    fireEvent.change(episodeSelect(), { target: { value: '3' } });
    expect(episodeSelect().value).toBe('3');

    fireEvent.change(seasonSelect(), { target: { value: '2' } });
    await waitFor(() => expect(episodeSelect().options.length).toBe(2));
    expect(episodeSelect().value).toBe('1');
  });

  it('never leaves an episode selected that does not exist in the new season', async () => {
    renderModal();
    await waitFor(() => expect(episodeSelect().options.length).toBe(3));

    // Season 2 has only two episodes, so episode 3 must not survive the switch.
    fireEvent.change(episodeSelect(), { target: { value: '3' } });
    fireEvent.change(seasonSelect(), { target: { value: '2' } });
    await waitFor(() => expect(episodeSelect().options.length).toBe(2));

    const selected = Number(episodeSelect().value);
    const available = Array.from(episodeSelect().options).map((option) => Number(option.value));
    expect(available).toContain(selected);

    // And back again, to a season that does contain it.
    fireEvent.change(seasonSelect(), { target: { value: '1' } });
    await waitFor(() => expect(episodeSelect().options.length).toBe(3));
    expect(Array.from(episodeSelect().options).map((option) => Number(option.value)))
      .toContain(Number(episodeSelect().value));
  });

  it('starts on the episode the modal was opened with', async () => {
    render(
      <SourceModal
        media={media}
        initialSeason={2}
        initialEpisode={2}
        addons={[]}
        repositories={[]}
        nuvioSettings={{}}
        preferredLanguage="en"
        preferredSource=""
        onPreferredSourceChange={() => undefined}
        onClose={() => undefined}
        onOpenExtensions={() => undefined}
        onPlay={() => undefined}
      />,
    );
    await waitFor(() => expect(episodeSelect().value).toBe('2'));
  });
});
