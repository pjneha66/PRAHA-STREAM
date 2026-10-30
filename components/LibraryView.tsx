import React, { useState } from 'react';
import { ArrowRight, Bookmark, Clock3, Library, Trash2 } from 'lucide-react';
import type { MediaItem, WatchProgress } from '../types';
import { ContinueCard, MediaCard } from './MediaCard';

const LibraryView: React.FC<{
  watchlist: MediaItem[];
  history: WatchProgress[];
  onSelect: (item: MediaItem) => void;
  onPlay: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  onExplore: () => void;
  onClearHistory: () => void;
  compact: boolean;
}> = ({ watchlist, history, onSelect, onPlay, onToggleWatchlist, onExplore, onClearHistory, compact }) => {
  const [tab, setTab] = useState<'watchlist' | 'history'>('watchlist');
  return (
    <div className="standard-page page-enter">
      <div className="page-heading library-heading">
        <div><span className="page-kicker"><Library size={14} /> YOUR PERSONAL SPACE</span><h1>My library</h1><p>Keep the stories you love close, and the ones you started closer.</p></div>
        {tab === 'history' && history.length > 0 && <button className="button button-secondary subtle-danger" onClick={onClearHistory}><Trash2 size={16} /> Clear history</button>}
      </div>
      <div className="library-tabs">
        <button className={tab === 'watchlist' ? 'active' : ''} onClick={() => setTab('watchlist')}><Bookmark size={16} /> Watchlist <span>{watchlist.length}</span></button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><Clock3 size={16} /> Watch history <span>{history.length}</span></button>
      </div>
      {tab === 'watchlist' && (watchlist.length ? (
        <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>{watchlist.map((item) => <MediaCard key={item.id} item={item} onSelect={onSelect} onToggleWatchlist={onToggleWatchlist} inWatchlist compact={compact} />)}</div>
      ) : (
        <div className="empty-state library-empty"><span><Bookmark size={28} /></span><h2>Your watchlist is wide open</h2><p>Tap the + on any title to save it here for the perfect movie night.</p><button className="button button-primary" onClick={onExplore}>Discover something new <ArrowRight size={16} /></button></div>
      ))}
      {tab === 'history' && (history.length ? (
        <div className="library-history-grid">{history.map((entry, index) => <ContinueCard key={`${entry.media.id}-${index}`} entry={entry} onPlay={onPlay} />)}</div>
      ) : (
        <div className="empty-state library-empty"><span><Clock3 size={28} /></span><h2>No watch history yet</h2><p>When you start watching, your progress will appear here.</p><button className="button button-primary" onClick={onExplore}>Start exploring <ArrowRight size={16} /></button></div>
      ))}
    </div>
  );
};

export default LibraryView;
