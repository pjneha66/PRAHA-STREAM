import React, { useMemo, useState } from 'react';
import { ArrowRight, Bookmark, Clock3, Library, Trash2 } from 'lucide-react';
import type { LibraryStatus, MediaItem, WatchProgress } from '../types';
import { ContinueCard, MediaCard } from './MediaCard';

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

  const visibleWatchlist = useMemo(() => {
    if (statusFilter === 'all') return watchlist;
    return watchlist.filter((item) => (item.libraryStatus || 'plan') === statusFilter);
  }, [watchlist, statusFilter]);

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
            </div>
          )}

          {visibleWatchlist.length ? (
            <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
              {visibleWatchlist.map((item) => (
                <MediaCard
                  key={item.id}
                  item={item}
                  onSelect={onSelect}
                  onToggleWatchlist={onToggleWatchlist}
                  inWatchlist
                  compact={compact}
                />
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
