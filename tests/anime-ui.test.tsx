import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AnimeView from '../components/AnimeView';
import AnimeDiscussion from '../components/AnimeDiscussion';
import DetailsModal from '../components/DetailsModal';
import { DEFAULT_SETTINGS } from '../data/defaults';
import type { MediaItem } from '../types';

const animeItem: MediaItem = {
  id: 'anicore:sousou-no-frieren',
  tmdbId: 209867,
  type: 'series',
  title: 'Frieren: Beyond Journey’s End',
  overview: 'An elf mage learns what living means.',
  poster: 'https://img/poster.jpg',
  backdrop: 'https://img/banner.jpg',
  year: '2023',
  rating: 9.2,
  genres: ['Adventure', 'Fantasy'],
  source: 'anicore',
  anime: {
    slug: 'sousou-no-frieren',
    malId: 52991,
    anilistId: 154587,
    tmdbId: 209867,
    format: 'TV',
    status: 'FINISHED',
    episodeCount: 28,
    studios: ['Madhouse'],
    sources: ['kitsu', 'anilist', 'mal'],
  } as MediaItem['anime'],
};

describe('anime UI smoke renders', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the Anime tab shell without a browser or network', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const html = renderToStaticMarkup(
      <AnimeView
        query=""
        watchlist={[]}
        compact={false}
        imdx={DEFAULT_SETTINGS.imdx}
        onSelect={() => undefined}
        onPlay={() => undefined}
        onEmbeddedPlayers={() => undefined}
        onToggleWatchlist={() => undefined}
        onOpenSettings={() => undefined}
        onClearSearch={() => undefined}
      />,
    );
    expect(html).toContain('Anime, indexed.');
    expect(html).toContain('AniCore');
    expect(html).toContain('Anikura');
    expect(html).toContain('IMDx · Tiffara');
    expect(html).toContain('Browse the full index');
  });

  it('renders the search state of the Anime tab', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const html = renderToStaticMarkup(
      <AnimeView
        query="frieren"
        watchlist={[]}
        compact
        imdx={{ enabled: true, baseUrl: DEFAULT_SETTINGS.imdx.baseUrl, apiKey: '' }}
        onSelect={() => undefined}
        onPlay={() => undefined}
        onEmbeddedPlayers={() => undefined}
        onToggleWatchlist={() => undefined}
        onOpenSettings={() => undefined}
        onClearSearch={() => undefined}
      />,
    );
    expect(html).toContain('ANIME SEARCH');
    expect(html).toContain('frieren');
  });

  it('renders the Anikura discussion panel and the anime details modal', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const discussion = renderToStaticMarkup(<AnimeDiscussion item={animeItem} />);
    expect(discussion).toContain('Episode discussion');
    expect(discussion).toContain('Powered by Anikura');

    const details = renderToStaticMarkup(
      <DetailsModal
        item={animeItem}
        watchlist={[]}
        history={[]}
        onClose={() => undefined}
        onPlay={() => undefined}
        onEmbeddedPlayers={() => undefined}
        onSelectRecommendation={() => undefined}
        onToggleWatchlist={() => undefined}
        onUpdateStatus={() => undefined}
        inWatchlist={false}
      />,
    );
    expect(details).toContain('FROM THE ANIME INDEX');
    expect(details).toContain('MAL 52991');
    expect(details).toContain('anime-detail-strip');
    expect(details).toContain('Episode discussion');
  });
});
