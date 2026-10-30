import React, { useMemo, useState } from 'react';
import { CircleAlert, Compass, RotateCcw, SearchX, SlidersHorizontal } from 'lucide-react';
import type { MediaItem, MediaType } from '../types';
import { MediaCard } from './MediaCard';
import TmdbSetupCard from './TmdbSetupCard';

const DiscoverView: React.FC<{
  items: MediaItem[];
  loading: boolean;
  error: string;
  query: string;
  watchlist: MediaItem[];
  tmdbReady: boolean;
  onSelect: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  onClearSearch: () => void;
  onOpenSettings: () => void;
  compact: boolean;
}> = ({ items, loading, error, query, watchlist, tmdbReady, onSelect, onToggleWatchlist, onClearSearch, onOpenSettings, compact }) => {
  const [type, setType] = useState<'all' | MediaType>('all');
  const [source, setSource] = useState<'all' | 'tmdb' | 'stremio'>('all');
  const filtered = useMemo(() => items.filter((item) =>
    (type === 'all' || item.type === type) &&
    (source === 'all' || (source === 'tmdb' ? item.source === 'tmdb' : item.source !== 'tmdb')),
  ), [items, type, source]);

  return (
    <div className="standard-page page-enter">
      <div className="page-heading discover-heading">
        <div><span className="page-kicker"><Compass size={14} /> EXPLORE THE CATALOG</span><h1>{query ? `Results for “${query}”` : 'Find your next obsession.'}</h1><p>{query ? `${filtered.length} titles from TMDB and your installed sources.` : 'Fresh stories, hidden gems, and everything your sources have to offer.'}</p></div>
      </div>
      <div className="filter-bar">
        <div className="filter-pills">
          {(['all', 'movie', 'series'] as const).map((value) => <button key={value} className={type === value ? 'active' : ''} onClick={() => setType(value)}>{value === 'all' ? 'All titles' : value === 'movie' ? 'Movies' : 'Series'}</button>)}
        </div>
        <label className="source-select"><SlidersHorizontal size={15} /><select value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="all">All sources</option><option value="tmdb">TMDB catalog</option><option value="stremio">Your sources</option></select></label>
      </div>
      {!tmdbReady ? (
        <TmdbSetupCard
          title={query ? 'Search needs your TMDB key' : 'Discover needs your TMDB key'}
          message={query
            ? 'PRAHA searches TMDB and your installed Stremio addons. Add your free personal API key to search the full TMDB catalog of movies and series.'
            : 'Browse TMDB’s trending, popular, and top-rated catalogues, plus the catalogs of the addons you install. Add your free personal API key to get started.'}
          onOpenSettings={onOpenSettings}
        />
      ) : loading ? (
        <div className="media-grid">{Array.from({ length: 12 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>)}</div>
      ) : error ? (
        <div className="empty-state"><span><CircleAlert size={28} /></span><h2>Search did not finish</h2><p>{error}</p><button className="button button-secondary" onClick={onOpenSettings}>Check your API key</button></div>
      ) : filtered.length ? (
        <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
          {filtered.map((item) => <MediaCard key={`${item.source}-${item.addonUrl || ''}-${item.id}`} item={item} onSelect={onSelect} onToggleWatchlist={onToggleWatchlist} inWatchlist={watchlist.some((entry) => entry.id === item.id)} compact={compact} />)}
        </div>
      ) : (
        <div className="empty-state"><span><SearchX size={28} /></span><h2>No stories found</h2><p>Try a different title or change your filters. Installing more addons can also expand your results.</p>{query && <button className="button button-secondary" onClick={onClearSearch}><RotateCcw size={15} /> Clear search</button>}</div>
      )}
    </div>
  );
};

export default DiscoverView;
