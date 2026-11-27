import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Play, Plus, Star, X } from 'lucide-react';
import type { MediaItem, WatchProgress } from '../types';
import { formatTime } from './player/format';
import { buildImageCandidates } from '../services/androidBridge';
import HoldToSaveButton from './HoldToSaveButton';

export const Artwork = React.memo(function Artwork({ src, fallback, ...props }: {
  src?: string; fallback?: string; alt: string; className?: string; priority?: boolean; directFirst?: boolean;
}) {
  return <ArtworkCandidates key={JSON.stringify([src, fallback])} src={src} fallback={fallback} {...props} />;
});

function ArtworkCandidates({ src, fallback, alt, className = '', priority = false, directFirst = false }: {
  src?: string; fallback?: string; alt: string; className?: string; priority?: boolean; directFirst?: boolean;
}) {
  const candidates = useMemo(() => {
    const primary = buildImageCandidates(src);
    const alternate = buildImageCandidates(fallback);
    const direct = directFirst && src && primary.includes(src) ? [src] : [];
    return [...new Set([...direct, ...primary.slice(0, 2), ...alternate.slice(0, 2), ...primary.slice(2), ...alternate.slice(2)])];
  }, [src, fallback, directFirst]);
  const [failedCount, setFailedCount] = useState(0);
  const [loaded, setLoaded] = useState('');
  const imageRef = useRef<HTMLImageElement>(null);
  const candidate = candidates[failedCount];
  const eager = priority || className.includes('hero-art');
  const tryNext = () => setFailedCount((count) => count === failedCount ? count + 1 : count);
  useEffect(() => {
    const image = imageRef.current;
    if (!image || loaded === candidate) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      timer ??= setTimeout(() => setFailedCount((count) => count === failedCount ? count + 1 : count), 5000);
    };
    const observer = !eager && typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); watch(); }
      })
      : null;
    if (observer) observer.observe(image);
    else if (eager) watch();
    return () => { observer?.disconnect(); clearTimeout(timer); };
  }, [eager, candidate, failedCount, loaded]);
  if (!candidate) {
    return <div className={`artwork-fallback ${className}`} role="img" aria-label={alt}><span>{alt}</span></div>;
  }
  return (
    <img
      key={candidate}
      ref={imageRef}
      src={candidate}
      alt={alt}
      className={className}
      style={loaded === candidate ? undefined : { opacity: 0 }}
      decoding="async"
      onLoad={(event) => {
        const image = event.currentTarget;
        if (image.naturalWidth <= 2) { tryNext(); return; }
        if (!image.decode) { setLoaded(candidate); return; }
        void image.decode().then(() => {
          if (imageRef.current === image) setLoaded(candidate);
        }).catch(tryNext);
      }}
      onError={tryNext}
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
      referrerPolicy="no-referrer"
    />
  );
}

interface MediaCardProps {
  item: MediaItem;
  onSelect: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  inWatchlist: boolean;
  compact?: boolean;
}

export const MediaCard = React.memo(function MediaCard({ item, onSelect, onToggleWatchlist, inWatchlist, compact }: MediaCardProps) {
  const save = () => { if (!inWatchlist) onToggleWatchlist(item); };
  return (
    <article className={`media-card ${compact ? 'compact' : ''}`}>
      <div className="poster-wrap">
        <HoldToSaveButton className="poster-button" onSave={save} onClick={() => onSelect(item)} aria-label={`View ${item.title}`}>
          <Artwork src={item.poster} fallback={item.anime?.alternatePoster || item.backdrop} alt={item.title} />
          <span className="poster-shade" />
          {item.rating && <span className="rating-badge"><Star size={11} fill="currentColor" />{item.rating.toFixed(1)}</span>}
          <span className="poster-play"><Play size={20} fill="currentColor" /></span>
        </HoldToSaveButton>
        <button
          className={`watchlist-button ${inWatchlist ? 'selected' : ''}`}
          onClick={() => onToggleWatchlist(item)}
          aria-label={inWatchlist ? `Remove ${item.title} from watchlist` : `Add ${item.title} to watchlist`}
        >
          {inWatchlist ? <Check size={15} /> : <Plus size={16} />}
        </button>
      </div>
      <HoldToSaveButton className="media-card-copy" onSave={save} onClick={() => onSelect(item)}>
        <strong>{item.title}</strong>
        <span>{item.year || '—'} <i /> {item.type === 'movie' ? 'Movie' : 'Series'}</span>
      </HoldToSaveButton>
    </article>
  );
});

export const ContinueCard = React.memo(function ContinueCard({ entry, onPlay, onResumeEntry, onRemove, onSave }: {
  entry: WatchProgress;
  onPlay: (item: MediaItem) => void;
  onResumeEntry?: (entry: WatchProgress) => void;
  onRemove?: (entry: WatchProgress) => void;
  onSave?: () => void;
}) {
  const episodeLabel = entry.media.type === 'series' && entry.season
    ? `S${entry.season} E${entry.episode || 1}${entry.episodeTitle ? ` · ${entry.episodeTitle}` : ''}`
    : entry.media.genres.slice(0, 2).join(' • ') || entry.media.year || '';

  const timeLabel = entry.currentTime && entry.duration
    ? `${formatTime(entry.currentTime)} / ${formatTime(entry.duration)}`
    : `${Math.max(1, Math.min(100, Math.round(entry.progress)))}%`;

  return (
    <article className="continue-card-wrap">
      <HoldToSaveButton
        className="continue-card"
        onSave={onSave}
        onClick={() => (onResumeEntry ? onResumeEntry(entry) : onPlay(entry.media))}
      >
        <div className="continue-art">
          <Artwork src={entry.media.backdrop || entry.media.poster} alt="" />
          <span className="continue-shade" />
          <span className="continue-play"><Play size={17} fill="currentColor" /></span>
          <span className="continue-source">
            {entry.media.source === 'stremio'
              ? 'ADDON'
              : entry.media.source === 'nuvio'
                ? 'NUVIO'
                : entry.media.source === 'anicore'
                  ? 'ANIME'
                  : entry.media.source === 'imdx'
                    ? 'IMDX'
                    : entry.media.source === 'youtube'
                      ? 'FLOW'
                      : entry.media.source === 'cloudstream'
                        ? 'CLOUDSTREAM'
                        : 'TMDB'}
          </span>
          <span className="continue-timestamp">{timeLabel}</span>
        </div>
        <div className="continue-copy">
          <strong>{entry.media.title}</strong>
          <span>{episodeLabel}</span>
        </div>
        <div className="progress-track"><span style={{ width: `${Math.max(2, Math.min(100, entry.progress))}%` }} /></div>
      </HoldToSaveButton>
      {onRemove && (
        <button
          type="button"
          className="continue-remove"
          onClick={(event) => {
            event.stopPropagation();
            onRemove(entry);
          }}
          aria-label={`Remove ${entry.media.title} from Continue Watching`}
          title="Remove from Continue Watching"
        >
          <X size={13} />
        </button>
      )}
    </article>
  );
});

export const MediaRow = React.memo(function MediaRow({ title, subtitle, items, onSelect, onToggleWatchlist, watchlist, compact }: {
  title: string;
  subtitle?: string;
  items: MediaItem[];
  onSelect: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  watchlist: MediaItem[];
  compact?: boolean;
}) {
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
});
