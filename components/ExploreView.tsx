import React, { useState } from 'react';
import { ArrowRight, Blocks, LayoutGrid, Zap } from 'lucide-react';
import type {
  InstalledAddon, MediaItem, NuvioRepository, StreamResult,
} from '../types';
import StremioExplorer from './StremioExplorer';
import NuvioExplorer from './NuvioExplorer';

type ExploreTab = 'stremio' | 'nuvio';

interface ExploreViewProps {
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  watchlist: MediaItem[];
  compact: boolean;
  preferredLanguage: string;
  onToggleWatchlist: (item: MediaItem) => void;
  onPlay: (media: MediaItem, stream: StreamResult) => void;
  onOpenExtensions: () => void;
}

const ExploreView: React.FC<ExploreViewProps> = ({
  addons, repositories, watchlist, compact,
  preferredLanguage, onToggleWatchlist, onPlay, onOpenExtensions,
}) => {
  const [tab, setTab] = useState<ExploreTab>('stremio');

  const tabs: Array<{ id: ExploreTab; label: string; subtitle: string; icon: typeof Blocks }> = [
    { id: 'stremio', label: 'Addons', subtitle: 'Stremio catalogs & streams', icon: Blocks },
    { id: 'nuvio', label: 'Plugins', subtitle: 'Nuvio providers', icon: Zap },
  ];

  const counts = { stremio: addons.length, nuvio: repositories.length };

  const emptyTab = (id: ExploreTab) => (
    <div className="empty-state explore-empty">
      <span>{id === 'stremio' ? <Blocks size={28} /> : <Zap size={28} />}</span>
      <h2>{id === 'stremio' ? 'No Stremio addons installed' : 'No Nuvio plugins installed'}</h2>
      <p>{id === 'stremio'
        ? 'Install a Stremio addon to browse its catalogs, metadata, and streams here.'
        : 'Install a Nuvio repository to browse its stream providers here.'}</p>
      <button className="button button-primary" onClick={onOpenExtensions}>Manage sources <ArrowRight size={16} /></button>
    </div>
  );

  return (
    <div className="standard-page explore-page page-enter">
      <div className="page-heading"><div>
        <span className="page-kicker"><LayoutGrid size={14} /> SOURCE BROWSER</span>
        <h1>Explore your sources</h1>
        <p>Browse, load, and play catalogs and streams from all your installed extensions.</p>
      </div></div>

      <div className="explore-tabs" role="tablist" aria-label="Source type">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} role="tab" aria-selected={tab === item.id}
              className={`explore-tab ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>
              <Icon size={18} />
              <span><strong>{item.label}</strong><small>{item.subtitle}</small></span>
              <b>{counts[item.id]}</b>
            </button>
          );
        })}
      </div>

      {tab === 'stremio' && (addons.length
        ? <StremioExplorer addons={addons} watchlist={watchlist} compact={compact} preferredLanguage={preferredLanguage}
            onToggleWatchlist={onToggleWatchlist} onPlay={onPlay} onOpenExtensions={onOpenExtensions} />
        : emptyTab('stremio'))}

      {tab === 'nuvio' && (repositories.length
        ? <NuvioExplorer repositories={repositories} watchlist={watchlist} compact={compact} preferredLanguage={preferredLanguage}
            onToggleWatchlist={onToggleWatchlist} onPlay={onPlay} onOpenExtensions={onOpenExtensions} />
        : emptyTab('nuvio'))}
    </div>
  );
};

export default ExploreView;
