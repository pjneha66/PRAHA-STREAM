import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, ChevronLeft, CircleAlert, ExternalLink, LoaderCircle, Package, RotateCcw, Search, Smartphone, Sparkles,
} from 'lucide-react';
import {
  getCloudStreamEpisodes, getCloudStreamHome, getCloudStreamStreams, searchCloudStreamProvider,
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
  onOpenSettings: () => void;
  onToggleWatchlist: (item: MediaItem) => void;
  onPlay: (media: MediaItem, stream: StreamResult) => void;
  onOpenExtensions: () => void;
}

/**
 * CloudStream's JavaScript contract originally only had search/getEpisodes/
 * getStreams. PRAHA now also calls an optional getHome() so the Home tab can
 * show each extension's own live feed instead of seeding it with fixed titles.
 * Extensions without getHome() fall back to broad search terms.
 */
const FALLBACK_BROWSE_TERMS = ['Popular', 'Latest', 'Anime', 'Movies', 'Series'];

interface BrowseRow {
  provider: CloudStreamProvider;
  repository: CloudStreamRepository;
  items: MediaItem[];
  loading: boolean;
  error?: string;
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
  onOpenSettings, onToggleWatchlist, onPlay, onOpenExtensions,
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
  const cloudStreamRepoLink = active
    ? `https://cs.repo?${active.repository.manifestUrl.replace(/^https?:\/\//, '')}`
    : 'https://github.com/recloudstream/cloudstream';
  const cloudStreamSearchLink = `cloudstreamsearch://${encodeURIComponent(query.trim() || provider?.name || 'CloudStream')}`;

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
  }, [query, view, provider, nativeOnly, tmdbApiKey]);

  // Home carousels: prefer each extension's own getHome() feed. Older JS
  // extensions without getHome() are searched with broad terms. Failures are
  // kept on the row so a dead endpoint no longer looks like "0 titles".
  const loadBrowse = useCallback(async () => {
    const jsProviders = providers.filter((entry) => entry.provider.enabled && !entry.provider.nativeOnly && entry.provider.code);
    setBrowseRows(jsProviders.map((entry) => ({ provider: entry.provider, repository: entry.repository, items: [], loading: true })));
    await Promise.all(jsProviders.map(async (entry) => {
      const seen = new Set<string>();
      const collected: MediaItem[] = [];
      const failures: string[] = [];
      const collect = (items: MediaItem[]) => {
        for (const item of items) {
          if (!seen.has(item.id)) { seen.add(item.id); collected.push(item); }
        }
      };
      try {
        collect(await getCloudStreamHome(entry.provider, tmdbApiKey));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'Home feed failed.');
      }
      if (!collected.length) {
        for (const term of FALLBACK_BROWSE_TERMS) {
          try {
            collect(await searchCloudStreamProvider(entry.provider, term, tmdbApiKey));
          } catch (error) {
            failures.push(error instanceof Error ? error.message : 'Search failed.');
          }
          if (collected.length >= 30) break;
        }
      }
      const firstFailure = failures.find((message) => !message.includes('does not export getHome'));
      setBrowseRows((current) => current.map((row) => row.provider.id === entry.provider.id
        ? { ...row, items: collected, loading: false, error: collected.length ? undefined : firstFailure }
        : row));
    }));
  }, [providers, tmdbApiKey]);

  useEffect(() => { loadBrowse(); }, [loadBrowse]);

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
  }, [provider, tmdbApiKey]);

  const loadEpisodes = useCallback(async (item: MediaItem) => {
    if (!provider) return;
    setEpisodesLoading(true);
    setEpisodes([]);
    setActiveEpisode(null);
    try {
      const list = await getCloudStreamEpisodes(provider, item.providerMediaId || item.id, tmdbApiKey);
      setEpisodes(list);
      if (list.length) {
        setActiveEpisode(list[0].id);
        // The first episode is shown as selected, so resolve its streams too.
        // Previously nothing fetched streams until a chip was clicked, which
        // left the source panel reporting "0 streams found".
        void loadStreams(item, list[0].id, 'series');
      }
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : 'Episode list could not be loaded.');
    } finally {
      setEpisodesLoading(false);
    }
  }, [provider, tmdbApiKey, loadStreams]);

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

  const refreshStreams = useCallback(() => {
    if (!selected) return;
    if (selected.type === 'series') {
      if (activeEpisode) loadStreams(selected, activeEpisode, 'series');
    } else {
      loadStreams(selected, selected.providerMediaId || selected.id, 'movie');
    }
  }, [selected, activeEpisode, loadStreams]);

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

          {!tmdbApiKey && provider?.code?.includes('YOUR_TMDB_API_KEY') && (
            <p className="explore-note"><CircleAlert size={14} /> {provider.name} needs your TMDB API key before it can load titles. <button className="inline-link" onClick={onOpenSettings}>Add your TMDB key</button></p>
          )}

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
                  onRefresh={refreshStreams}
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
                  <div className="section-heading"><div><h2>Browse extensions</h2><p>Live home feeds from your browser-compatible CloudStream extensions</p></div><button className="button button-secondary" onClick={loadBrowse}><RotateCcw size={15} /> Retry</button></div>
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
                        {!row.loading && !row.items.length && (row.error ? (
                          <span className="explore-note"><CircleAlert size={14} /> {row.provider.name}: {row.error}</span>
                        ) : <span className="text-button">This extension returned no titles for its home feed.</span>)}
                      </div>
                    </div>
                  ))}
                </section>
              )}
              {providers.some((entry) => entry.provider.nativeOnly) && (
                <p className="explore-note"><CircleAlert size={14} /> {providers.filter((entry) => entry.provider.nativeOnly).length} of your CloudStream extensions are native .cs3 packages. CloudStream is an Android app and its Kotlin extensions can't execute in a browser — only the JavaScript extensions above can be browsed and played here. <a className="inline-link" href="https://github.com/recloudstream/cloudstream/releases" target="_blank" rel="noreferrer">Get the official CloudStream app</a></p>
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
                  <p>{provider?.name} is a compiled Kotlin .cs3 package for the Android CloudStream app. A browser cannot execute it, so PRAHA can hand the search and repository to the official app instead.</p>
                  <div className="tmdb-setup-actions">
                    <a className="button button-primary" href={cloudStreamSearchLink}><Smartphone size={16} /> Search in CloudStream app</a>
                    <a className="button button-secondary" href={cloudStreamRepoLink}><ExternalLink size={16} /> Add repository in CloudStream</a>
                    <a className="button button-secondary" href="https://github.com/recloudstream/cloudstream/releases" target="_blank" rel="noreferrer">Get CloudStream</a>
                  </div>
                  <button className="text-button" onClick={onOpenExtensions}>Manage extensions</button>
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
