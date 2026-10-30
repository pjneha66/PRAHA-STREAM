import React from 'react';
import { ExternalLink, KeyRound, RotateCcw } from 'lucide-react';

/**
 * Shown wherever the catalog would be when no TMDB API key is saved. PRAHA does
 * not bundle a catalog or a shared key, so this is the entry point to both.
 */
const TmdbSetupCard: React.FC<{
  title?: string;
  message?: string;
  onOpenSettings: () => void;
  onRetry?: () => void;
  compact?: boolean;
}> = ({
  title = 'Connect TMDB to load the catalog',
  message = 'Every title in PRAHA comes live from TMDB — nothing is bundled in the app. Paste your free personal API key and the home screen, discover, and search fill up instantly.',
  onOpenSettings,
  onRetry,
  compact,
}) => (
  <div className={`empty-state tmdb-setup ${compact ? 'compact' : ''}`}>
    <span><KeyRound size={26} /></span>
    <h2>{title}</h2>
    <p>{message}</p>
    <ol className="tmdb-steps">
      <li><b>1.</b> Create a free TMDB account and copy your <em>API Key</em> (v3) or <em>read access token</em> (v4).</li>
      <li><b>2.</b> Open <button type="button" className="inline-link" onClick={onOpenSettings}>Settings → TMDB API</button> and paste it.</li>
      <li><b>3.</b> Verify and save — the key stays in this browser and is sent only to TMDB.</li>
    </ol>
    <div className="tmdb-setup-actions">
      <button className="button button-primary" onClick={onOpenSettings}><KeyRound size={16} /> Add your TMDB key</button>
      <a className="button button-secondary" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">Get a free key <ExternalLink size={14} /></a>
      {onRetry && <button className="button button-glass" onClick={onRetry}><RotateCcw size={15} /> Retry</button>}
    </div>
  </div>
);

export default TmdbSetupCard;
