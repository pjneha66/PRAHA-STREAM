import React, { useEffect } from 'react';
import { Blocks, Check, Play, Plus, Star, X } from 'lucide-react';
import type { MediaItem } from '../types';
import { Artwork } from './MediaCard';

const DetailsModal: React.FC<{
  item: MediaItem;
  onClose: () => void;
  onPlay: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  inWatchlist: boolean;
}> = ({ item, onClose, onPlay, onToggleWatchlist, inWatchlist }) => {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', handler); document.body.classList.remove('modal-open'); };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="details-modal" role="dialog" aria-modal="true" aria-label={item.title}>
        <button className="modal-close floating" onClick={onClose} aria-label="Close details"><X size={20} /></button>
        <div className="details-backdrop">
          <Artwork src={item.backdrop || item.poster} alt="" />
          <div />
        </div>
        <div className="details-body">
          <div className="details-poster"><Artwork src={item.poster} alt={item.title} /></div>
          <div className="details-copy">
            <span className="details-kicker">{item.source === 'stremio' ? 'FROM YOUR ADDON' : item.type === 'movie' ? 'FEATURE FILM' : 'SERIES'}</span>
            <h2>{item.title}</h2>
            <div className="details-meta">
              {item.rating && <span className="hero-rating"><Star size={13} fill="currentColor" />{item.rating.toFixed(1)}</span>}
              <span>{item.year || '—'}</span>{item.runtime && <><i /><span>{item.runtime}</span></>}
              {item.maturity && <span className="maturity-badge">{item.maturity}</span>}
            </div>
            <div className="genre-list">{item.genres.map((genre) => <span key={genre}>{genre}</span>)}</div>
            <p className="details-overview">{item.overview || 'No description is available for this title yet.'}</p>
            <div className="details-actions">
              <button className="button button-primary" onClick={() => onPlay(item)}><Play size={18} fill="currentColor" /> Find sources</button>
              <button className={`button button-secondary ${inWatchlist ? 'is-saved' : ''}`} onClick={() => onToggleWatchlist(item)}>
                {inWatchlist ? <Check size={18} /> : <Plus size={18} />}{inWatchlist ? 'In your library' : 'Add to library'}
              </button>
            </div>
            <div className="details-source-note"><Blocks size={15} /><span>Streams are provided by your installed Stremio addons and Nuvio plugins.</span></div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default DetailsModal;
