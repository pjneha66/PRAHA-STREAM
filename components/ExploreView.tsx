import React, { useEffect, useState } from 'react';
import { ArrowRight, Blocks, LayoutGrid, Sparkles, Zap } from 'lucide-react';
import type {
  InstalledAddon, MediaItem, NuvioRepository, StreamResult,
} from '../types';
import StremioExplorer from './StremioExplorer';
import NuvioExplorer from './NuvioExplorer';
import EcosystemExplorer from './EcosystemExplorer';
import { ecosystemExtensions } from '../services/ecosystems/store';

type ExploreTab = 'stremio' | 'nuvio' | 'ecosystems';

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
  const [ecosystemCount, setEcosystemCount] = useState(0);

  useEffect(() => {
    const refresh = () => setEcosystemCount(
      ecosystemExtensions('sora')
        .concat(ecosystemExtensions('skystream'), ecosystemExtensions('zangetsu'), ecosystemExtensions('anymex'))
        .filter((entry) => entry.enabled).length,
    );
    refresh();
    window.addEventListener('praha:ecosystems-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('praha:ecosystems-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const tabs: Array<{ id: ExploreTab; label: string; subtitle: string; icon: typeof Blocks }> = [
    { id: 'stremio', label: 'Addons', subtitle: 'Stremio catalogs & streams', icon: Blocks },
    { id: 'nuvio', label: 'Plugins', subtitle: 'Nuvio providers', icon: Zap },
    // The extension ecosystems: movies/series catalogs with their own rows and
    // search, beside the addon and plugin browsers.
    { id: 'ecosystems', label: 'Extensions', subtitle: 'Sora · SkyStream · Zangetsu · AnymeX', icon: Sparkles },
  ];

  const counts = { stremio: addons.length, nuvio: repositories.length, ecosystems: ecosystemCount };

  const emptyTab = (id: ExploreTab) => (
    <div className="empty-state explore-empty">
      <span>{id === 'stremio' ? <Blocks size={28} /> : id === 'nuvio' ? <Zap size={28} /> : <Sparkles size={28} />}</span>
      <h2>{id === 'stremio' ? 'No Stremio addons installed' : id === 'nuvio' ? 'No Nuvio plugins installed' : 'No extension sources installed'}</h2>
      <p>{id === 'stremio'
        ? 'Install a Stremio addon to browse its catalogs, metadata, and streams here.'
        : id === 'nuvio'
          ? 'Install a Nuvio repository to browse its stream providers here.'
          : 'Install Sora, SkyStream, Zangetsu or AnymeX extensions to browse their catalogs here.'}</p>
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

      {tab === 'ecosystems' && <EcosystemExplorer watchlist={watchlist} compact={compact}
        onToggleWatchlist={onToggleWatchlist} onPlay={onPlay} onOpenExtensions={onOpenExtensions} />}
    </div>
  );
};

export default ExploreView;
