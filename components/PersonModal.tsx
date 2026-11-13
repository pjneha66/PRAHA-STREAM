import React, { useEffect, useState } from 'react';
import { LoaderCircle, MapPin, Cake, X } from 'lucide-react';
import { tmdbService } from '../services/tmdbService';
import type { MediaItem } from '../types';
import { Artwork, MediaCard } from './MediaCard';

/**
 * Person detail page (port of Nuvio's PersonDetailScreen): photo, short bio,
 * and a "known for" grid of TMDB combined credits. Opened from cast chips.
 */
const PersonModal: React.FC<{
  personId: number;
  name?: string;
  onClose: () => void;
  onSelect: (item: MediaItem) => void;
  watchlist: MediaItem[];
  onToggleWatchlist: (item: MediaItem) => void;
  compact?: boolean;
}> = ({ personId, name, onClose, onSelect, watchlist, onToggleWatchlist, compact }) => {
  const [person, setPerson] = useState<Awaited<ReturnType<typeof tmdbService.getPerson>>>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    tmdbService.getPerson(personId)
      .then((result) => { if (active) setPerson(result); })
      .catch(() => undefined)
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [personId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    document.body.classList.add('modal-open');
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.classList.remove('modal-open');
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop person-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="person-modal" role="dialog" aria-modal="true" aria-label={person?.name || name || 'Person'}>
        <button className="modal-close" onClick={onClose} aria-label="Close person page"><X size={18} /></button>
        {loading ? (
          <div className="empty-state"><LoaderCircle size={26} className="spin" /><p>Loading person…</p></div>
        ) : !person ? (
          <div className="empty-state"><h2>Person not found</h2><p>TMDB person data is unavailable for this credit.</p></div>
        ) : (
          <>
            <header className="person-head">
              <Artwork src={person.profile} alt={person.name} />
              <div>
                <h2>{person.name}</h2>
                <p className="person-meta">
                  {person.birthday && <span><Cake size={12} /> {person.birthday}</span>}
                  {person.placeOfBirth && <span><MapPin size={12} /> {person.placeOfBirth}</span>}
                </p>
                {person.biography && <p className="person-bio">{person.biography}</p>}
              </div>
            </header>
            {person.knownFor.length > 0 && (
              <section className="details-section">
                <div className="details-section-head"><h3>Known for</h3></div>
                <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
                  {person.knownFor.map((item) => (
                    <MediaCard
                      key={item.id}
                      item={item}
                      onSelect={onSelect}
                      onToggleWatchlist={onToggleWatchlist}
                      inWatchlist={watchlist.some((entry) => entry.id === item.id)}
                      compact
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </section>
    </div>
  );
};

export default PersonModal;
