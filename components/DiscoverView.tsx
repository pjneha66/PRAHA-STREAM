import React, { useMemo } from 'react';
import {
  ChevronDown, CircleAlert, Compass, LoaderCircle, RotateCcw, SearchX, SlidersHorizontal,
} from 'lucide-react';
import { DEFAULT_DISCOVER_FILTERS } from '../data/defaults';
import { DISCOVER_GENRE_OPTIONS } from '../services/tmdbService';
import type { DiscoverFilters, MediaItem } from '../types';
import { MediaCard } from './MediaCard';
import TmdbSetupCard from './TmdbSetupCard';

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
  onSelect: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  onClearSearch: () => void;
  onOpenSettings: () => void;
  compact: boolean;
}> = ({
  items, loading, loadingMore, hasMore, error, query, filters, onFiltersChange, onLoadMore,
  watchlist, tmdbReady, onSelect, onToggleWatchlist, onClearSearch, onOpenSettings, compact,
}) => {
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
          <p>{query ? `${filtered.length} titles from TMDB and your installed sources.` : 'Filter by genre, year, rating, and language across TMDB and your addons.'}</p>
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

      {!tmdbReady && filters.source !== 'stremio' ? (
        <TmdbSetupCard
          title={query ? 'Search needs your TMDB key' : 'Discover needs your TMDB key'}
          message={query
            ? 'PRAHA searches TMDB and your installed Stremio addons. Add your free personal API key to search the full TMDB catalog of movies and series.'
            : 'Browse TMDB’s trending, popular, and filtered catalogues, plus the catalogs of the addons you install. Add your free personal API key to get started.'}
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
        </>
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
