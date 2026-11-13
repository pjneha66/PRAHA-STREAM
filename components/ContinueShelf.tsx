import React from 'react';
import { BookOpen, Headphones, History, Library, Play, X } from 'lucide-react';
import type { ContinueEntry } from '../services/continueStore';

const DOMAIN_META: Record<ContinueEntry['domain'], { label: string; icon: React.ReactNode }> = {
  book: { label: 'Book', icon: <BookOpen size={12} /> },
  comic: { label: 'Comic', icon: <Library size={12} /> },
  audiobook: { label: 'Audiobook', icon: <Headphones size={12} /> },
};

/**
 * One "Continue" shelf shared by Books, Comics and Audiobooks: the last
 * opened items with a one-tap resume. Consistent language across the three
 * reading tabs — the empty first screen gets something alive.
 */
const ContinueShelf: React.FC<{
  entries: ContinueEntry[];
  onResume: (entry: ContinueEntry) => void;
  onDismiss: (entry: ContinueEntry) => void;
  title?: string;
}> = ({ entries, onResume, onDismiss, title = 'Continue where you left off' }) => {
  if (!entries.length) return null;
  return (
    <section className="continue-shelf" aria-label={title}>
      <h2 className="continue-shelf-title"><History size={14} /> {title}</h2>
      <div className="continue-shelf-row">
        {entries.map((entry) => (
          <div key={`${entry.domain}-${entry.id}`} className="continue-card" onClick={() => onResume(entry)} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onResume(entry); }}>
            {entry.cover
              ? <img src={entry.cover} alt="" loading="lazy" />
              : <span className="continue-card-fallback">{DOMAIN_META[entry.domain].icon}</span>}
            <div className="continue-card-body">
              <small className="continue-card-domain">{DOMAIN_META[entry.domain].label}</small>
              <strong>{entry.title}</strong>
              {entry.detail && <small className="continue-card-detail">{entry.detail}</small>}
              <span className="continue-card-resume"><Play size={11} fill="currentColor" /> Resume</span>
            </div>
            <button
              className="continue-card-dismiss"
              aria-label={`Remove ${entry.title} from Continue`}
              onClick={(e) => { e.stopPropagation(); onDismiss(entry); }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
};

export default ContinueShelf;
