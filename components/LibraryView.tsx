import React, { useMemo, useState } from 'react';
import { ArrowRight, Bookmark, Clock3, Library, Trash2 } from 'lucide-react';
import type { LibraryStatus, MediaItem, WatchProgress } from '../types';
import { ContinueCard, MediaCard } from './MediaCard';
import { readCollections, saveCollections, type Collection } from '../services/collectionsStore';

const STATUS_TABS: Array<{ id: 'all' | LibraryStatus; label: string }> = [
  { id: 'all', label: 'All saved' },
  { id: 'watching', label: 'Watching' },
  { id: 'plan', label: 'Plan to Watch' },
  { id: 'hold', label: 'On Hold' },
  { id: 'completed', label: 'Completed' },
  { id: 'dropped', label: 'Dropped' },
];

const LibraryView: React.FC<{
  watchlist: MediaItem[];
  history: WatchProgress[];
  profileName: string;
  onSelect: (item: MediaItem) => void;
  onPlay: (item: MediaItem) => void;
  onResumeEntry: (entry: WatchProgress) => void;
  onRemoveHistory: (entry: WatchProgress) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  onExplore: () => void;
  onClearHistory: () => void;
  compact: boolean;
}> = ({
  watchlist, history, profileName, onSelect, onPlay, onResumeEntry, onRemoveHistory,
  onToggleWatchlist, onExplore, onClearHistory, compact,
}) => {
  const [tab, setTab] = useState<'watchlist' | 'history'>('watchlist');
  const [statusFilter, setStatusFilter] = useState<'all' | LibraryStatus>('all');
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'added' | 'title' | 'year' | 'rating'>('added');
  // Collections (port of Nuvio's collection folders): named groups over the
  // watchlist, persisted, assignable from the card menu.
  const [collections, setCollections] = useState<Collection[]>(() => readCollections());
  const [collectionFilter, setCollectionFilter] = useState<string>('');

  const persistCollections = (next: Collection[]) => {
    setCollections(next);
    saveCollections(next);
  };

  const assignToCollection = (item: MediaItem, collectionName: string) => {
    const name = collectionName.trim();
    if (!name) return;
    let next = collections.map((entry) => ({
      ...entry,
      ids: entry.ids.filter((id) => id !== item.id || entry.name === name),
    }));
    const existing = next.find((entry) => entry.name === name);
    if (existing) {
      if (!existing.ids.includes(item.id)) existing.ids.push(item.id);
    } else {
      next = [...next, { name, ids: [item.id] }];
    }
    persistCollections(next);
  };

  const collectionNames = collections.map((entry) => entry.name);

  const assignItem = (item: MediaItem) => {
    const list = collectionNames.length ? `Existing: ${collectionNames.join(', ')}\nEnter a collection name (empty cancels):` : 'Enter a new collection name:';
    const answer = window.prompt(list);
    if (answer === null) return;
    assignToCollection(item, answer);
  };

  const visibleWatchlist = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filtered = watchlist.filter((item) => {
      if (collectionFilter && !collections.find((entry) => entry.name === collectionFilter)?.ids.includes(item.id)) return false;
      if (statusFilter !== 'all' && (item.libraryStatus || 'plan') !== statusFilter) return false;
      if (normalizedQuery && !item.title.toLocaleLowerCase().includes(normalizedQuery)) return false;
      return true;
    });

    if (sortBy === 'added') return filtered;
    return [...filtered].sort((a, b) => {
      if (sortBy === 'title') return a.title.localeCompare(b.title);
      if (sortBy === 'year') return (b.year || '').localeCompare(a.year || '') || a.title.localeCompare(b.title);
      return (b.rating || 0) - (a.rating || 0) || a.title.localeCompare(b.title);
    });
  }, [watchlist, statusFilter, query, sortBy, collections, collectionFilter]);

  return (
    <div className="standard-page page-enter">
      <div className="page-heading library-heading">
        <div>
          <span className="page-kicker"><Library size={14} /> {profileName.toUpperCase()} · PERSONAL SPACE</span>
          <h1>My library</h1>
          <p>Keep the stories you love organized by status, and resume any episode right where you stopped.</p>
        </div>
        {tab === 'history' && history.length > 0 && (
          <button className="button button-secondary subtle-danger" onClick={onClearHistory}>
            <Trash2 size={16} /> Clear all history
          </button>
        )}
      </div>

      <div className="library-tabs">
        <button className={tab === 'watchlist' ? 'active' : ''} onClick={() => setTab('watchlist')}>
          <Bookmark size={16} /> Watchlist <span>{watchlist.length}</span>
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <Clock3 size={16} /> Watch history <span>{history.length}</span>
        </button>
      </div>

      {tab === 'watchlist' && (
        <>
          {watchlist.length > 0 && (
            <div className="filter-pills library-status-pills">
              {STATUS_TABS.map((item) => (
                <button
                  key={item.id}
                  className={statusFilter === item.id ? 'active' : ''}
                  onClick={() => setStatusFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
              <span className="library-pill-divider" />
              <button
                className={collectionFilter === '' ? 'active' : ''}
                onClick={() => setCollectionFilter('')}
              >
                All
              </button>
              {collections.map((entry) => (
                <button
                  key={entry.name}
                  className={collectionFilter === entry.name ? 'active' : ''}
                  onClick={() => setCollectionFilter(collectionFilter === entry.name ? '' : entry.name)}
                  title={`${entry.ids.length} items — click to filter, shift-click to delete`}
                  onClickCapture={(event) => {
                    if (event.shiftKey) {
                      persistCollections(collections.filter((candidate) => candidate.name !== entry.name));
                      if (collectionFilter === entry.name) setCollectionFilter('');
                    }
                  }}
                >
                  {entry.name} <small>{entry.ids.length}</small>
                </button>
              ))}
            </div>
          )}

          {watchlist.length > 0 && (
            <div className="discover-select-group library-tools">
              <label className="source-select">
                <input
                  type="search"
                  aria-label="Search saved titles"
                  placeholder="Search your library"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <label className="source-select">
                <select aria-label="Sort library" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>
                  <option value="added">Recently added</option>
                  <option value="title">Title A–Z</option>
                  <option value="year">Newest year</option>
                  <option value="rating">Highest rated</option>
                </select>
              </label>
            </div>
          )}

          {visibleWatchlist.length ? (
            <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
              {visibleWatchlist.map((item) => (
                <div key={item.id} className="library-card-wrap">
                  <MediaCard
                    item={item}
                    onSelect={onSelect}
                    onToggleWatchlist={onToggleWatchlist}
                    inWatchlist
                    compact={compact}
                  />
                  <button
                    className="library-assign"
                    onClick={(event) => { event.stopPropagation(); assignItem(item); }}
                    title="Add to a collection"
                  >
                    ＋ Collection
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state library-empty">
              <span><Bookmark size={28} /></span>
              <h2>{watchlist.length ? 'Nothing in this status list yet' : 'Your watchlist is wide open'}</h2>
              <p>{watchlist.length ? 'Open any title’s details to change its status between Watching, Plan to Watch, On Hold, or Completed.' : 'Tap the + on any title to save it here for the perfect movie night.'}</p>
              <button className="button button-primary" onClick={onExplore}>Discover something new <ArrowRight size={16} /></button>
            </div>
          )}
        </>
      )}

      {tab === 'history' && (history.length ? (
        <div className="library-history-grid">
          {history.map((entry, index) => (
            <ContinueCard
              key={`${entry.media.id}-${entry.season || 0}-${entry.episode || 0}-${index}`}
              entry={entry}
              onPlay={onPlay}
              onResumeEntry={onResumeEntry}
              onRemove={onRemoveHistory}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state library-empty">
          <span><Clock3 size={28} /></span>
          <h2>No watch history yet</h2>
          <p>When you start watching, your exact timestamp and episode progress will appear here.</p>
          <button className="button button-primary" onClick={onExplore}>Start exploring <ArrowRight size={16} /></button>
        </div>
      ))}
    </div>
  );
};

export default LibraryView;
