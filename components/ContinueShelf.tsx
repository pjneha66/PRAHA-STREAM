import React from 'react';
import { BookOpen, Headphones, History, Library, Play, X } from 'lucide-react';
import type { ContinueEntry } from '../services/continueStore';
import { useHoldToSave } from './HoldToSaveButton';

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
interface ShelfProps {
  entries: ContinueEntry[];
  onResume: (entry: ContinueEntry) => void;
  onDismiss: (entry: ContinueEntry) => void;
  onSave?: (entry: ContinueEntry) => void;
  title?: string;
}

const ContinueShelf: React.FC<ShelfProps> = ({ entries, onResume, onDismiss, onSave, title = 'Continue where you left off' }) => {
  if (!entries.length) return null;
  return (
    <section className="continue-shelf" aria-label={title}>
      <h2 className="continue-shelf-title"><History size={14} /> {title}</h2>
      <div className="continue-shelf-row">
        {entries.map((entry) => (
          <ContinueTile key={`${entry.domain}-${entry.id}`} entry={entry} onResume={onResume} onDismiss={onDismiss} onSave={onSave} />
        ))}
      </div>
    </section>
  );
};

function ContinueTile({ entry, onResume, onDismiss, onSave }: Pick<ShelfProps, 'onResume' | 'onDismiss' | 'onSave'> & { entry: ContinueEntry }) {
  const hold = useHoldToSave<HTMLDivElement>(onSave && (() => onSave(entry)));
  return <div {...hold} className="continue-card" onClick={() => onResume(entry)} role="button" tabIndex={0}
    onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === 'Enter') onResume(entry); }}>
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
      onClick={(event) => { event.stopPropagation(); onDismiss(entry); }}
    >
      <X size={12} />
    </button>
  </div>;
}

export default ContinueShelf;
