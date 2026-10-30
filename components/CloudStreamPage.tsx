import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, ChevronLeft, CircleAlert, LoaderCircle, Package, Search, Sparkles,
} from 'lucide-react';
import {
  getCloudStreamEpisodes, getCloudStreamStreams, searchCloudStreamProvider,
  type CloudStreamEpisode,
} from '../services/cloudstreamService';
import type {
  CloudStreamProvider, CloudStreamRepository, MediaItem, SourceError, StreamResult, WatchProgress,
} from '../types';
import { MediaCard } from './MediaCard';
import SourcePanel from './SourcePanel';

type CSView = 'home' | 'search';

interface CloudStreamPageProps {
  repositories: CloudStreamRepository[];
  history: WatchProgress[];
  watchlist: MediaItem[];
  compact: boolean;
  preferredLanguage: string;
  tmdbApiKey: string;
  onToggleWatchlist: (item: MediaItem) => void;
  onPlay: (media: MediaItem, stream: StreamResult) => void;
  onOpenExtensions: () => void;
}

/**
 * Popular titles used to seed each extension's Home carousel. CloudStream's
 * JavaScript contract is search-only (search/getEpisodes/getStreams), so the
 * Home screen can't browse a catalog — these trending queries are the only
 * way to surface "content from source" without a user query.
 */
const TRENDING_QUERIES = [
  'Avatar', 'Dune', 'Spider-Man', 'The Batman', 'Interstellar',
  'Stranger Things', 'Attack on Titan', 'Dandadan', 'Solo Leveling', 'Demon Slayer',
];

interface BrowseRow {
  provider: CloudStreamProvider;
  repository: CloudStreamRepository;
  items: MediaItem[];
  loading: boolean;
}

/**
 * A faithful, in-browser replica of the CloudStream app experience.
 *
 * Mirrors the CloudStream Win app: a "CloudStream" title, a horizontal row of
 * plugin pills (one active extension), a Home screen (Continue Watching +
 * My Library) and a Search screen (plugin + query + results). Opening a title
 * drops into an inline source panel that resolves and PLAYs the extension's
 * own streams — just like the CloudStream app itself.
 */
const CloudStreamPage: React.FC<CloudStreamPageProps> = ({
  repositories, history, watchlist, compact, preferredLanguage, tmdbApiKey,
  onToggleWatchlist, onPlay, onOpenExtensions,
}) => {
  const providers = useMemo(() => repositories
    .filter((repo) => repo.enabled)
    .flatMap((repo) => repo.providers
      .filter((provider) => provider.enabled)
      .map((provider) => ({ provider, repository: repo }))),
  [repositories]);

  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [view, setView] = useState<CSView>('home');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [streams, setStreams] = useState<StreamResult[]>([]);
  const [errors, setErrors] = useState<SourceError[]>([]);
  const [loading, setLoading] = useState(false);
  const [episodes, setEpisodes] = useState<CloudStreamEpisode[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [activeEpisode, setActiveEpisode] = useState<string | null>(null);
  const [browseRows, setBrowseRows] = useState<BrowseRow[]>([]);

  const active = useMemo(
    () => providers.find((item) => item.provider.id === activeProviderId) || null,
    [providers, activeProviderId],
  );
  const provider = active?.provider;
  const nativeOnly = Boolean(provider?.nativeOnly);

  useEffect(() => {
    if (!activeProviderId && providers.length) setActiveProviderId(providers[0].provider.id);
    else if (activeProviderId && !providers.some((item) => item.provider.id === activeProviderId)) {
      setActiveProviderId(providers[0]?.provider.id || null);
    }
  }, [providers, activeProviderId]);

  useEffect(() => {
    setQuery('');
    setResults([]);
    setSearchError('');
    setSelected(null);
    setView('home');
  }, [activeProviderId]);

  useEffect(() => {
    const term = query.trim();
    if (view !== 'search' || !term || !provider || nativeOnly || !provider.code) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError('');
    const timer = window.setTimeout(async () => {
      try {
          const items = await searchCloudStreamProvider(provider, term, tmdbApiKey);
        if (!cancelled) setResults(items);
      } catch (error) {
        if (!cancelled) {
          setResults([]);
          setSearchError(error instanceof Error ? error.message : 'Search failed.');
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, view, provider, nativeOnly]);

  // Home carousels: search each JavaScript extension with trending titles so
  // the Home screen shows content without the user having to search first.
  const loadBrowse = useCallback(async () => {
    const jsProviders = providers.filter((entry) => entry.provider.enabled && !entry.provider.nativeOnly && entry.provider.code);
    setBrowseRows(jsProviders.map((entry) => ({ provider: entry.provider, repository: entry.repository, items: [], loading: true })));
    await Promise.all(jsProviders.map(async (entry) => {
      const seen = new Set<string>();
      const collected: MediaItem[] = [];
      for (const term of TRENDING_QUERIES) {
        try {
          const items = await searchCloudStreamProvider(entry.provider, term);
          for (const item of items) {
            if (!seen.has(item.id)) { seen.add(item.id); collected.push(item); }
          }
        } catch { /* extension failed for this term — skip */ }
        if (collected.length >= 30) break;
      }
      setBrowseRows((current) => current.map((row) => row.provider.id === entry.provider.id ? { ...row, items: collected, loading: false } : row));
    }));
  }, [providers]);

  useEffect(() => { loadBrowse(); }, [loadBrowse]);

  const loadEpisodes = useCallback(async (item: MediaItem) => {
    if (!provider) return;
    setEpisodesLoading(true);
    setEpisodes([]);
    setActiveEpisode(null);
    try {
      const list = await getCloudStreamEpisodes(provider, item.providerMediaId || item.id, tmdbApiKey);
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
      const result = await getCloudStreamStreams(provider, mediaId, mediaType, tmdbApiKey);
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

  const cloudstreamHistory = history.filter((entry) => entry.media.source === 'cloudstream');
  const cloudstreamLibrary = watchlist.filter((item) => item.source === 'cloudstream');

  return (
    <div className="standard-page cloudstream-page page-enter">
      <header className="cs-header">
        <div>
          <span className="page-kicker"><Package size={14} /> CLOUDSTREAM APP</span>
          <h1>CloudStream</h1>
          <p>Your CloudStream extensions, loaded and played like the CloudStream app — in their own tab.</p>
        </div>
        {providers.length > 0 && (
          <div className="cs-segment" role="tablist" aria-label="CloudStream view">
            <button role="tab" aria-selected={view === 'home'} className={view === 'home' ? 'active' : ''} onClick={() => setView('home')}>Home</button>
            <button role="tab" aria-selected={view === 'search'} className={view === 'search' ? 'active' : ''} onClick={() => setView('search')}>Search</button>
          </div>
        )}
      </header>

      {providers.length === 0 ? (
        <div className="empty-state explore-empty">
          <span><Package size={28} /></span>
          <h2>No CloudStream extensions installed</h2>
          <p>Add a CloudStream repository to load its extensions and start browsing.</p>
          <button className="button button-primary" onClick={onOpenExtensions}>Manage extensions <ChevronLeft size={16} style={{ transform: 'rotate(180deg)' }} /></button>
        </div>
      ) : (
        <>
          <div className="cs-pills" role="tablist" aria-label="CloudStream extension">
            {providers.map(({ provider: p, repository }) => (
              <button key={p.id} className={`cs-pill ${activeProviderId === p.id ? 'active' : ''}`}
                onClick={() => { setActiveProviderId(p.id); setView('search'); }}
                title={`${repository.name} · ${p.supportedTypes.join(' & ')}`}>
                {p.iconUrl ? <img src={p.iconUrl.replace('%size%', '64')} alt="" className="cs-pill-icon" /> : <Package size={15} />}
                <span>{p.name}</span>
                {p.nativeOnly && <span className="native-badge">CS3</span>}
                {activeProviderId === p.id && <Check size={14} />}
              </button>
            ))}
          </div>

          {selected ? (
            <div className="cs-detail page-enter">
              <button className="text-button" onClick={() => setSelected(null)}><ChevronLeft size={15} /> Back to {view === 'search' ? 'results' : 'CloudStream'}</button>
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
          ) : view === 'home' ? (
            <div className="cs-home">
              {cloudstreamHistory.length > 0 && (
                <section className="cs-section">
                  <div className="section-heading"><div><h2>Continue Watching</h2><p>{cloudstreamHistory.length} item{cloudstreamHistory.length === 1 ? '' : 's'}</p></div></div>
                  <div className="cs-continue-grid">
                    {cloudstreamHistory.map((entry) => (
                      <button key={entry.media.id} className="cs-continue-card" onClick={() => openMedia(entry.media)}>
                        <span className="cs-continue-poster">
                          {entry.media.poster || entry.media.backdrop ? (
                            <img src={entry.media.poster || entry.media.backdrop} alt="" />
                          ) : <Package size={18} />}
                        </span>
                        <div className="cs-continue-body">
                          <strong>{entry.media.title}</strong>
                          {entry.episode ? <small>S{entry.season || 1} E{entry.episode}</small> : <small>Movie</small>}
                          <div className="cs-progress"><span style={{ width: `${Math.min(100, Math.max(0, entry.progress * 100))}%` }} /></div>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {browseRows.length > 0 && (
                <section className="cs-section">
                  <div className="section-heading"><div><h2>Browse extensions</h2><p>Trending titles from your CloudStream extensions</p></div></div>
                  {browseRows.map((row) => (
                    <div className="cs-carousel" key={row.provider.id}>
                      <div className="cs-carousel-head">
                        <h3>{row.provider.name}</h3>
                        <span>{row.loading ? 'Loading…' : `${row.items.length} titles`}</span>
                      </div>
                      <div className="media-row">
                        {row.loading ? Array.from({ length: 8 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>) : row.items.map((item) => (
                          <MediaCard key={item.id} item={item} onSelect={openMedia}
                            onToggleWatchlist={onToggleWatchlist} inWatchlist={watchlist.some((entry) => entry.id === item.id)} compact={compact} />
                        ))}
                        {!row.loading && !row.items.length && <span className="text-button">No trending results from this extension.</span>}
                      </div>
                    </div>
                  ))}
                </section>
              )}
              {providers.some((entry) => entry.provider.nativeOnly) && (
                <p className="explore-note"><CircleAlert size={14} /> {providers.filter((entry) => entry.provider.nativeOnly).length} of your CloudStream extensions are native .cs3 packages. They run inside the CloudStream app and can't load content in a browser — only the JavaScript extensions above can be browsed and played here.</p>
              )}

              <section className="cs-section">
                <div className="section-heading"><div><h2>My Library</h2><p>{cloudstreamLibrary.length} saved</p></div></div>
                {cloudstreamLibrary.length ? (
                  <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
                    {cloudstreamLibrary.map((item) => (
                      <MediaCard key={item.id} item={item} onSelect={openMedia}
                        onToggleWatchlist={onToggleWatchlist} inWatchlist={watchlist.some((entry) => entry.id === item.id)} compact={compact} />
                    ))}
                  </div>
                ) : (
                  <div className="empty-state explore-empty">
                    <span><Sparkles size={26} /></span>
                    <h2>Your library is empty</h2>
                    <p>Search with a CloudStream extension and save titles to watch them here.</p>
                    <button className="button button-primary" onClick={() => setView('search')}>Search <Search size={16} /></button>
                  </div>
                )}
              </section>
            </div>
          ) : (
            <div className="cs-search">
              {nativeOnly ? (
                <div className="empty-state explore-empty">
                  <span><Package size={26} /></span>
                  <h2>Native CloudStream extension</h2>
                  <p>{provider?.name} is a compiled .cs3 package. It runs inside the CloudStream app and cannot resolve streams in a browser. Pick a CloudStream JavaScript extension to search and play here.</p>
                </div>
              ) : (
                <>
                  <form className="cs-search-form" onSubmit={(event) => { event.preventDefault(); setView('search'); }}>
                    <div className="explore-search">
                      <Search size={16} />
                      <input value={query} onChange={(event) => setQuery(event.target.value)}
                        placeholder={`Search with ${provider?.name || 'CloudStream'}…`} aria-label={`Search with ${provider?.name}`} />
                      {query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Clear search">×</button>}
                    </div>
                  </form>
                  {searchError && <p className="explore-note"><CircleAlert size={14} />{searchError}</p>}

                  {searching ? (
                    <div className="media-grid">{Array.from({ length: 12 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>)}</div>
                  ) : results.length ? (
                    <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
                      {results.map((item) => (
                        <MediaCard key={item.id} item={item} onSelect={openMedia}
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
          )}
        </>
      )}
    </div>
  );
};

export default CloudStreamPage;
