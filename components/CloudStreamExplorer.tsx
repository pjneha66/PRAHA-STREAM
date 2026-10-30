import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, ChevronLeft, CircleAlert, LoaderCircle, Package, Play, Search,
} from 'lucide-react';
import {
  getCloudStreamEpisodes, getCloudStreamStreams, searchCloudStreamProvider,
  type CloudStreamEpisode,
} from '../services/cloudstreamService';
import type {
  CloudStreamRepository, MediaItem, SourceError, StreamResult,
} from '../types';
import { MediaCard } from './MediaCard';
import SourcePanel from './SourcePanel';

interface CloudStreamExplorerProps {
  cloudstreamRepositories: CloudStreamRepository[];
  watchlist: MediaItem[];
  compact: boolean;
  preferredLanguage: string;
  onToggleWatchlist: (item: MediaItem) => void;
  onPlay: (media: MediaItem, stream: StreamResult) => void;
  onOpenExtensions: () => void;
}

const CloudStreamExplorer: React.FC<CloudStreamExplorerProps> = ({
  cloudstreamRepositories, watchlist, compact, preferredLanguage, onToggleWatchlist, onPlay, onOpenExtensions,
}) => {
  const providers = useMemo(() => cloudstreamRepositories
    .filter((repo) => repo.enabled)
    .flatMap((repo) => repo.providers.filter((provider) => provider.enabled).map((provider) => ({ provider, repository: repo }))), [cloudstreamRepositories]);

  const [providerId, setProviderId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [episodes, setEpisodes] = useState<CloudStreamEpisode[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [activeEpisode, setActiveEpisode] = useState<string | null>(null);
  const [streams, setStreams] = useState<StreamResult[]>([]);
  const [errors, setErrors] = useState<SourceError[]>([]);
  const [loading, setLoading] = useState(false);

  const active = useMemo(() => providers.find((item) => item.provider.id === providerId) || null, [providers, providerId]);
  const provider = active?.provider;
  const nativeOnly = Boolean(provider?.nativeOnly);

  useEffect(() => {
    if (!providerId && providers.length) setProviderId(providers[0].provider.id);
    else if (providerId && !providers.some((item) => item.provider.id === providerId)) setProviderId(providers[0]?.provider.id || null);
  }, [providers, providerId]);

  useEffect(() => {
    setSelected(null);
    setQuery('');
    setResults([]);
    setSearchError('');
  }, [providerId]);

  useEffect(() => {
    const term = query.trim();
    if (!term || !provider || nativeOnly || !provider.code) { setResults([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    setSearchError('');
    const timer = window.setTimeout(async () => {
      try {
        const items = await searchCloudStreamProvider(provider, term);
        if (!cancelled) setResults(items);
      } catch (error) {
        if (!cancelled) {
          setResults([]);
          setSearchError(error instanceof Error ? error.message : 'Search failed.');
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 450);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, provider, nativeOnly]);

  const loadEpisodes = useCallback(async (item: MediaItem) => {
    if (!provider) return;
    setEpisodesLoading(true);
    setEpisodes([]);
    setActiveEpisode(null);
    try {
      const list = await getCloudStreamEpisodes(provider, item.providerMediaId || item.id);
      setEpisodes(list);
      if (list.length) setActiveEpisode(list[0].id);
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : 'Episode list could not be loaded.');
    } finally {
      setEpisodesLoading(false);
    }
  }, [provider]);

  const loadStreams = useCallback(async (item: MediaItem, mediaId: string, mediaType: 'movie' | 'series') => {
    if (!provider) return;
    setLoading(true);
    setErrors([]);
    setStreams([]);
    try {
      const result = await getCloudStreamStreams(provider, mediaId, mediaType);
      setStreams(result);
      if (!result.length) setErrors([{ sourceName: provider.name, message: 'This extension returned no streams for this title.' }]);
    } catch (error) {
      setErrors([{ sourceName: provider.name, message: error instanceof Error ? error.message : 'Unable to resolve streams.' }]);
    } finally {
      setLoading(false);
    }
  }, [provider]);

  const openMedia = (item: MediaItem) => {
    setSelected(item);
    setStreams([]);
    setErrors([]);
    setActiveEpisode(null);
    if (item.type === 'series') {
      loadEpisodes(item);
    } else {
      loadStreams(item, item.providerMediaId || item.id, 'movie');
    }
  };

  const playEpisode = (episode: CloudStreamEpisode) => {
    if (!selected) return;
    setActiveEpisode(episode.id);
    loadStreams(selected, episode.id, 'series');
  };

  return (
    <div className="explorer">
      <aside className="explorer-sources">
        <p className="explore-list-label">CloudStream extensions</p>
        {providers.map(({ provider: p, repository }) => (
          <button key={p.id} className={`explore-source-card ${providerId === p.id ? 'active' : ''} ${!p.enabled ? 'disabled' : ''}`}
            onClick={() => setProviderId(p.id)}>
            <span className="explore-source-icon cloudstream">{p.iconUrl ? <img src={p.iconUrl.replace('%size%', '64')} alt="" /> : <Package size={20} />}</span>
            <span className="explorer-source-copy">
              <strong>{p.name}</strong>
              <small>{repository.name} · {p.supportedTypes.join('/')}</small>
            </span>
            {p.nativeOnly && <span className="native-badge" title="Runs only in the native CloudStream app">CS3</span>}
            {providerId === p.id && <Check size={16} />}
          </button>
        ))}
      </aside>

      <section className="explorer-content">
        {selected ? (
          <div className="explorer-detail page-enter">
            <button className="text-button" onClick={() => setSelected(null)}><ChevronLeft size={15} /> Back to {provider?.name || 'extensions'}</button>
            <div className="source-panel-card">
              <SourcePanel
                media={selected}
                streams={streams}
                loading={loading}
                errors={errors}
                providerCount={1}
                preferredLanguage={preferredLanguage}
                onPlay={(stream) => onPlay(selected, stream)}
                onOpenExtensions={onOpenExtensions}
              />
              {selected.type === 'series' && (
                <div className="episode-strip">
                  {episodesLoading ? <span className="text-button"><LoaderCircle size={13} className="spin" /> Loading episodes…</span> : episodes.map((episode) => (
                    <button key={episode.id} className={`episode-chip ${episode.id === activeEpisode ? 'active' : ''}`} onClick={() => playEpisode(episode)}>
                      <span>S{episode.season} E{episode.episode}</span>
                      <small>{episode.title}</small>
                    </button>
                  ))}
                  {!episodesLoading && !episodes.length && <span className="text-button">No episodes were returned for this series.</span>}
                </div>
              )}
            </div>
          </div>
        ) : provider ? (
          <div className="explorer-detail page-enter">
            <header className="explorer-source-header">
              <span className="explore-source-icon large cloudstream">{provider.iconUrl ? <img src={provider.iconUrl.replace('%size%', '64')} alt="" /> : <Package size={26} />}</span>
              <div>
                <span className="page-kicker">CLOUDSTREAM EXTENSION</span>
                <h2>{provider.name}</h2>
                <p>{provider.description || `${active?.repository.name} · ${provider.supportedTypes.join(' & ')}`}</p>
              </div>
              <span className={`source-state ${provider.enabled ? 'online' : 'paused'}`}>{provider.enabled ? 'Ready' : 'Paused'}</span>
            </header>

            {nativeOnly ? (
              <div className="empty-state explore-empty">
                <span><Package size={26} /></span>
                <h2>Native CloudStream extension</h2>
                <p>{provider.name} is a compiled .cs3 package. PRAHA lists it here, but it runs inside the CloudStream app and cannot resolve streams in a browser. Install a CloudStream JavaScript extension to search and play in PRAHA.</p>
              </div>
            ) : (
              <>
                <div className="provider-tags explorer-provider-tags">
                  {provider.supportedTypes.map((type) => <span key={type}>{type === 'movie' ? 'Movies' : 'Series'}</span>)}
                  {provider.language ? <span>{provider.language.toUpperCase()}</span> : null}
                  {Array.isArray(provider.authors) && provider.authors.length ? <span>{provider.authors.join(', ')}</span> : null}
                </div>

                <div className="explorer-toolbar">
                  <div className="explore-search">
                    <Search size={16} />
                    <input value={query} onChange={(event) => setQuery(event.target.value)}
                      placeholder={`Search with ${provider.name}…`} aria-label={`Search with ${provider.name}`} />
                    {query && <button className="search-clear" onClick={() => setQuery('')} aria-label="Clear search">×</button>}
                  </div>
                </div>
                {searchError && <p className="explore-note"><CircleAlert size={14} />{searchError}</p>}

                {searching ? (
                  <div className="media-grid">{Array.from({ length: 12 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>)}</div>
                ) : results.length ? (
                  <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
                    {results.map((item) => (
                      <MediaCard key={`${item.source}-${item.providerId || ''}-${item.id}`} item={item} onSelect={openMedia}
                        onToggleWatchlist={onToggleWatchlist} inWatchlist={watchlist.some((entry) => entry.id === item.id)} compact={compact} />
                    ))}
                  </div>
                ) : (
                  <div className="empty-state explore-empty">
                    <span><Search size={26} /></span>
                    <h2>{query ? 'No results' : 'Search to find something to watch'}</h2>
                    <p>{query ? 'Try a different title, or pick another extension.' : `Search this CloudStream extension to browse and play its sources.`}</p>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="empty-state explore-empty"><span><Package size={26} /></span><h2>No extension selected</h2><p>Choose a CloudStream extension to search and play.</p></div>
        )}
      </section>
    </div>
  );
};

export default CloudStreamExplorer;
