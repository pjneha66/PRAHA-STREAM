import React, { useMemo } from 'react';
import {
  ChevronDown, CircleAlert, Compass, Library, LoaderCircle, Music2, RotateCcw, SearchX, SlidersHorizontal,
} from 'lucide-react';
import { DEFAULT_DISCOVER_FILTERS } from '../data/defaults';
import { DISCOVER_GENRE_OPTIONS } from '../services/tmdbService';
import type { MusicTrack } from '../services/musicService';
import type { DiscoverFilters, MediaItem } from '../types';
import type { BookItem } from '../services/archiveService';
import { MediaCard } from './MediaCard';
import TmdbSetupCard from './TmdbSetupCard';
import { readSearchHistory, clearSearchHistory } from '../services/searchHistory';

/** Cross-tab universal-search section: matches living in other PRAHA tabs. */
const CrossTabResults: React.FC<{
  query: string;
  music: MusicTrack[];
  books: BookItem[];
  onOpenInTab: (target: 'music' | 'books') => void;
}> = ({ query, music, books, onOpenInTab }) => {
  if (!music.length && !books.length) return null;
  return (
    <div className="discover-crosstab">
      <h2 className="discover-crosstab-title">More matches in your other tabs</h2>
      {music.length > 0 && (
        <section className="discover-crosstab-card">
          <header>
            <Music2 size={15} />
            <strong>Music</strong>
            <span className="discover-crosstab-count">{music.length}+ tracks</span>
            <button className="button button-secondary button-small" onClick={() => onOpenInTab('music')}>
              Search “{query}” in Music
            </button>
          </header>
          <ul>
            {music.slice(0, 4).map((track) => (
              <li key={track.id}>
                {track.coverUrl
                  ? <img src={track.coverUrl} alt="" loading="lazy" />
                  : <span className="discover-crosstab-thumb-fallback"><Music2 size={12} /></span>}
                <div>
                  <strong>{track.title}</strong>
                  <small>{track.artist}</small>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {books.length > 0 && (
        <section className="discover-crosstab-card">
          <header>
            <Library size={15} />
            <strong>Books & Comics</strong>
            <span className="discover-crosstab-count">{books.length} items</span>
            <button className="button button-secondary button-small" onClick={() => onOpenInTab('books')}>
              Search “{query}” in Books
            </button>
          </header>
          <ul>
            {books.slice(0, 4).map((book) => (
              <li key={book.id}>
                {book.coverUrl
                  ? <img src={book.coverUrl} alt="" loading="lazy" />
                  : <span className="discover-crosstab-thumb-fallback"><Library size={12} /></span>}
                <div>
                  <strong>{book.title}</strong>
                  <small>{book.authors?.[0] || book.year || 'archive.org'}</small>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

const YEARS = Array.from({ length: 37 }, (_, idx) => String(2026 - idx));

const DiscoverView: React.FC<{
  items: MediaItem[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string;
  query: string;
  filters: DiscoverFilters;
  onFiltersChange: (next: DiscoverFilters) => void;
  onLoadMore: () => void;
  watchlist: MediaItem[];
  tmdbReady: boolean;
  imdxEnabled?: boolean;
  onSelect: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  onClearSearch: () => void;
  onOpenSettings: () => void;
  compact: boolean;
  musicResults?: MusicTrack[];
  bookResults?: BookItem[];
  onOpenInTab?: (target: 'music' | 'books') => void;
  onPrefillSearch?: (term: string) => void;
}> = ({
  items, loading, loadingMore, hasMore, error, query, filters, onFiltersChange, onLoadMore,
  watchlist, tmdbReady, imdxEnabled = false, onSelect, onToggleWatchlist, onClearSearch, onOpenSettings, compact,
  musicResults, bookResults, onOpenInTab, onPrefillSearch,
}) => {
  const [recentSearches, setRecentSearches] = React.useState<string[]>(() => readSearchHistory());
  const metadataReady = tmdbReady || imdxEnabled;
  const update = <K extends keyof DiscoverFilters>(key: K, value: DiscoverFilters[K]) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  const isFiltered =
    filters.type !== 'all' ||
    filters.source !== 'all' ||
    filters.genre !== 'all' ||
    filters.year !== 'all' ||
    filters.minRating > 0 ||
    filters.language !== 'all' ||
    filters.sortBy !== 'popularity.desc';

  const filtered = useMemo(() => items.filter((item) => {
    if (filters.type !== 'all' && item.type !== filters.type) return false;
    if (filters.source === 'tmdb' && item.source !== 'tmdb') return false;
    if (filters.source === 'imdx' && item.source !== 'imdx') return false;
    if (filters.source === 'stremio' && item.source === 'tmdb') return false;
    if (query && filters.minRating > 0 && (item.rating || 0) < filters.minRating) return false;
    if (query && filters.year !== 'all' && item.year !== filters.year) return false;
    return true;
  }), [items, filters, query]);

  return (
    <div className="standard-page page-enter">
      <div className="page-heading discover-heading">
        <div>
          <span className="page-kicker"><Compass size={14} /> EXPLORE THE CATALOG</span>
          <h1>{query ? `Results for “${query}”` : 'Find your next obsession.'}</h1>
          <p>{query ? `${filtered.length} titles from TMDB, AniCore, IMDb-style IMDx results and your installed sources.` : 'Filter by genre, year, rating, and language across TMDB, AniCore, IMDx and your addons.'}</p>
        </div>
      </div>

      <div className="filter-bar discover-filter-bar">
        <div className="filter-pills">
          {(['all', 'movie', 'series'] as const).map((value) => (
            <button key={value} className={filters.type === value ? 'active' : ''} onClick={() => update('type', value)}>
              {value === 'all' ? 'All titles' : value === 'movie' ? 'Movies' : 'Series'}
            </button>
          ))}
        </div>

        <div className="discover-select-group">
          <label className="source-select">
            <SlidersHorizontal size={14} />
            <select aria-label="Genre filter" value={filters.genre} onChange={(e) => update('genre', e.target.value)}>
              <option value="all">All genres</option>
              {DISCOVER_GENRE_OPTIONS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
            </select>
          </label>

          <label className="source-select">
            <select aria-label="Year filter" value={filters.year} onChange={(e) => update('year', e.target.value)}>
              <option value="all">Any year</option>
              {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>

          <label className="source-select">
            <select aria-label="Minimum rating" value={filters.minRating} onChange={(e) => update('minRating', Number(e.target.value))}>
              <option value={0}>Any rating</option>
              <option value={6}>6.0+ ★</option>
              <option value={7}>7.0+ ★</option>
              <option value={8}>8.0+ ★</option>
            </select>
          </label>

          <label className="source-select">
            <select aria-label="Original language" value={filters.language} onChange={(e) => update('language', e.target.value)}>
              <option value="all">All languages</option>
              <option value="en">English</option>
              <option value="hi">Hindi</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
            </select>
          </label>

          <label className="source-select">
            <select aria-label="Sort by" value={filters.sortBy} onChange={(e) => update('sortBy', e.target.value as DiscoverFilters['sortBy'])}>
              <option value="popularity.desc">Most popular</option>
              <option value="vote_average.desc">Highest rated</option>
              <option value="primary_release_date.desc">Newest first</option>
              <option value="revenue.desc">Top box office</option>
            </select>
          </label>

          <label className="source-select">
            <select aria-label="Source filter" value={filters.source} onChange={(e) => update('source', e.target.value as DiscoverFilters['source'])}>
              <option value="all">All sources</option>
              <option value="tmdb">TMDB catalog</option>
              <option value="imdx">IMDx · Tiffara</option>
              <option value="stremio">Your sources</option>
            </select>
          </label>

          {isFiltered && (
            <button className="button button-secondary compact-btn" onClick={() => onFiltersChange(DEFAULT_DISCOVER_FILTERS)}>
              <RotateCcw size={14} /> Reset
            </button>
          )}
        </div>
      </div>

      {!metadataReady && !filtered.length && !loading && filters.source !== 'stremio' && filters.source !== 'imdx' ? (
        <TmdbSetupCard
          title={query ? 'Search needs a metadata source' : 'Discover needs a metadata source'}
          message={query
            ? 'PRAHA searches TMDB, AniCore and your installed Stremio addons. Add your free personal TMDB API key — or switch on the optional IMDx (Tiffara) provider in the Settings → Metadata card.'
            : 'Browse TMDB’s trending, popular, and filtered catalogues, the AniCore anime index, and the catalogs of the addons you install. Add your free personal TMDB key — or enable IMDx (Tiffara) — to get started.'}
          onOpenSettings={onOpenSettings}
        />
      ) : loading ? (
        <div className="media-grid">{Array.from({ length: 12 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>)}</div>
      ) : error ? (
        <div className="empty-state"><span><CircleAlert size={28} /></span><h2>Search did not finish</h2><p>{error}</p><button className="button button-secondary" onClick={onOpenSettings}>Check your API key</button></div>
      ) : filtered.length ? (
        <>
          <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
            {filtered.map((item) => (
              <MediaCard
                key={`${item.source}-${item.addonUrl || ''}-${item.id}`}
                item={item}
                onSelect={onSelect}
                onToggleWatchlist={onToggleWatchlist}
                inWatchlist={watchlist.some((entry) => entry.id === item.id)}
                compact={compact}
              />
            ))}
          </div>
          {hasMore && (
            <div className="discover-load-more">
              <button className="button button-secondary" onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? <LoaderCircle size={16} className="spin" /> : <ChevronDown size={16} />}
                {loadingMore ? 'Loading more titles…' : 'Load more titles'}
              </button>
            </div>
          )}
          {query && onOpenInTab && (
            <CrossTabResults
              query={query}
              music={musicResults || []}
              books={bookResults || []}
              onOpenInTab={onOpenInTab}
            />
          )}
        </>
      ) : !query && recentSearches.length ? (
        <div className="discover-recent">
          <div className="discover-recent-head">
            <h2>Recent searches</h2>
            <button className="text-button" onClick={() => { clearSearchHistory(); setRecentSearches([]); }}>Clear</button>
          </div>
          <div className="filter-pills">
            {recentSearches.map((term) => (
              <button key={term} onClick={() => onPrefillSearch?.(term)}>{term}</button>
            ))}
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <span><SearchX size={28} /></span>
          <h2>No stories found</h2>
          <p>Try a different title or relax your filters. Installing more addons can also expand your results.</p>
          {(query || isFiltered) && (
            <button
              className="button button-secondary"
              onClick={() => {
                onClearSearch();
                onFiltersChange(DEFAULT_DISCOVER_FILTERS);
              }}
            >
              <RotateCcw size={15} /> Clear search & filters
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default DiscoverView;
