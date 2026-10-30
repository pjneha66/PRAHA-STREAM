import React, { useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Play, Plus, Star } from 'lucide-react';
import type { MediaItem, WatchProgress } from '../types';

export const Artwork: React.FC<{ src?: string; alt: string; className?: string }> = ({ src, alt, className = '' }) => {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <div className={`artwork-fallback ${className}`} role="img" aria-label={alt}><span>{alt}</span></div>;
  }
  return <img src={src} alt={alt} className={className} onError={() => setFailed(true)} loading="lazy" />;
};

interface MediaCardProps {
  item: MediaItem;
  onSelect: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  inWatchlist: boolean;
  compact?: boolean;
}

export const MediaCard: React.FC<MediaCardProps> = ({ item, onSelect, onToggleWatchlist, inWatchlist, compact }) => (
  <article className={`media-card ${compact ? 'compact' : ''}`}>
    <div className="poster-wrap">
      <button className="poster-button" onClick={() => onSelect(item)} aria-label={`View ${item.title}`}>
        <Artwork src={item.poster} alt={item.title} />
        <span className="poster-shade" />
        {item.rating && <span className="rating-badge"><Star size={11} fill="currentColor" />{item.rating.toFixed(1)}</span>}
        <span className="poster-play"><Play size={20} fill="currentColor" /></span>
      </button>
      <button
        className={`watchlist-button ${inWatchlist ? 'selected' : ''}`}
        onClick={() => onToggleWatchlist(item)}
        aria-label={inWatchlist ? `Remove ${item.title} from watchlist` : `Add ${item.title} to watchlist`}
      >
        {inWatchlist ? <Check size={15} /> : <Plus size={16} />}
      </button>
    </div>
    <button className="media-card-copy" onClick={() => onSelect(item)}>
      <strong>{item.title}</strong>
      <span>{item.year || '—'} <i /> {item.type === 'movie' ? 'Movie' : 'Series'}</span>
    </button>
  </article>
);

export const ContinueCard: React.FC<{
  entry: WatchProgress;
  onPlay: (item: MediaItem) => void;
}> = ({ entry, onPlay }) => (
  <button className="continue-card" onClick={() => onPlay(entry.media)}>
    <div className="continue-art">
      <Artwork src={entry.media.backdrop || entry.media.poster} alt="" />
      <span className="continue-shade" />
      <span className="continue-play"><Play size={17} fill="currentColor" /></span>
      <span className="continue-source">{entry.media.source === 'stremio' ? 'ADDON' : entry.media.source === 'nuvio' ? 'NUVIO' : 'TMDB'}</span>
    </div>
    <div className="continue-copy">
      <strong>{entry.media.title}</strong>
      <span>{entry.media.type === 'series' && entry.season ? `S${entry.season} E${entry.episode || 1}` : entry.media.genres.slice(0, 2).join(' • ') || entry.media.year}</span>
    </div>
    <div className="progress-track"><span style={{ width: `${entry.progress}%` }} /></div>
  </button>
);

export const MediaRow: React.FC<{
  title: string;
  subtitle?: string;
  items: MediaItem[];
  onSelect: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  watchlist: MediaItem[];
  compact?: boolean;
}> = ({ title, subtitle, items, onSelect, onToggleWatchlist, watchlist, compact }) => {
  const rowRef = useRef<HTMLDivElement>(null);
  if (!items.length) return null;
  return (
    <section className="media-section">
      <div className="section-heading">
        <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <div className="row-controls">
          <button onClick={() => rowRef.current?.scrollBy({ left: -600, behavior: 'smooth' })} aria-label={`Scroll ${title} left`}><ChevronLeft size={18} /></button>
          <button onClick={() => rowRef.current?.scrollBy({ left: 600, behavior: 'smooth' })} aria-label={`Scroll ${title} right`}><ChevronRight size={18} /></button>
        </div>
      </div>
      <div className="media-row" ref={rowRef}>
        {items.map((item) => (
          <MediaCard key={`${item.source}-${item.id}`} item={item} onSelect={onSelect} onToggleWatchlist={onToggleWatchlist}
            inWatchlist={watchlist.some((entry) => entry.id === item.id)} compact={compact} />
        ))}
      </div>
    </section>
  );
};
