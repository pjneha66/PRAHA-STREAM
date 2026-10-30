import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark, Check, ChevronDown, ChevronLeft, CircleAlert, ExternalLink, Film,
  Info, LoaderCircle, Package, Play, Plus, RefreshCw, Search, Smartphone, Star,
} from 'lucide-react';
import {
  getCloudStreamEpisodes, getCloudStreamHome, getCloudStreamStreams, searchCloudStreamProvider,
  type CloudStreamEpisode,
} from '../services/cloudstreamService';
import {
  fetchServerLinks, fetchServerMainPage, loadServerTitle, resolveServerProviderName, searchServerProvider,
  type ServerMainPageRow,
} from '../services/cloudstreamServerService';
import type {
  CloudStreamProvider, CloudStreamRepository, MediaItem, SourceError, StreamResult, WatchProgress,
} from '../types';
import { MediaCard } from './MediaCard';

type CSView = 'home' | 'search';

interface CloudStreamPageProps {
  repositories: CloudStreamRepository[];
  history: WatchProgress[];
  watchlist: MediaItem[];
  compact: boolean;
  preferredLanguage: string;
  tmdbApiKey: string;
  /** Optional plugin server that executes native .cs3 providers. */
  cloudstreamServerUrl: string;
  onOpenSettings: () => void;
  onToggleWatchlist: (item: MediaItem) => void;
  onPlay: (media: MediaItem, stream: StreamResult) => void;
  onOpenExtensions: () => void;
}

/**
 * Extensions without getHome() are searched with broad terms for their home
 * feed. Failures are kept on the row so a dead endpoint no longer looks like
 * an empty catalog.
 */
const FALLBACK_BROWSE_TERMS = ['Popular', 'Latest', 'Anime', 'Movies', 'Series'];

/** Bookmark lists shown on the app's home screen. PRAHA stores one list, so
 * everything saved lands under "Watching"; the other lists exist for parity. */
const BOOKMARK_LISTS = ['Watching', 'Plan to Watch', 'On Hold', 'Dropped', 'Completed'] as const;

interface BrowseRow {
  provider: CloudStreamProvider;
  repository: CloudStreamRepository;
  items: MediaItem[];
  loading: boolean;
  error?: string;
}

/**
 * A same-to-same web replica of the CloudStream Android app
 * (github.com/recloudstream/cloudstream), driven by the extensions installed
 * in PRAHA:
 *
 * - Home: full-bleed preview hero with Play / My List / Info, a provider
 *   selector in the top bar, Continue Watching, bookmark lists with chips,
 *   then the selected provider's home-page rows.
 * - Search: a search field with type chips and a poster grid, like the app's
 *   search screen.
 * - Result: backdrop header with poster, meta and tags, a season selector and
 *   episode list for series, and the resolved links underneath.
 *
 * Native .cs3 extensions are Kotlin Android packages and cannot execute in a
 * browser; selecting one offers the official app's deep links instead.
 */
const CloudStreamPage: React.FC<CloudStreamPageProps> = ({
  repositories, history, watchlist, compact, preferredLanguage, tmdbApiKey,
  cloudstreamServerUrl, onOpenSettings, onToggleWatchlist, onPlay, onOpenExtensions,
}) => {
  const providers = useMemo(() => repositories
    .filter((repo) => repo.enabled)
    .flatMap((repo) => repo.providers
      .filter((provider) => provider.enabled)
      .map((provider) => ({ provider, repository: repo }))),
  [repositories]);

  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [view, setView] = useState<CSView>('home');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'movie' | 'series'>('all');
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
  const [season, setSeason] = useState(1);
  const [browseRows, setBrowseRows] = useState<BrowseRow[]>([]);
  const [bookmarkList, setBookmarkList] = useState<(typeof BOOKMARK_LISTS)[number]>('Watching');
  const [heroIndex, setHeroIndex] = useState(0);
  const [nativeQuery, setNativeQuery] = useState('');
  const [remoteRows, setRemoteRows] = useState<ServerMainPageRow[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const active = useMemo(
    () => providers.find((item) => item.provider.id === activeProviderId) || null,
    [providers, activeProviderId],
  );
  const provider = active?.provider;
  const nativeOnly = Boolean(provider?.nativeOnly);
  const showRemoteHome = nativeOnly && Boolean(cloudstreamServerUrl);
  const showNativePage = nativeOnly && !cloudstreamServerUrl;
  const cloudStreamRepoLink = active
    ? `https://cs.repo?${active.repository.manifestUrl.replace(/^https?:\/\//, '')}`
    : 'https://github.com/recloudstream/cloudstream';
  const cloudStreamSearchLink = `cloudstreamsearch://${encodeURIComponent(query.trim() || provider?.name || 'CloudStream')}`;

  useEffect(() => {
    // Default to a browser-playable provider. Native .cs3 extensions can be
    // picked explicitly, but they must never be the landing provider — the
    // app replica would otherwise open on the Android-handoff screen.
    const preferred = providers.find((item) => !item.provider.nativeOnly) || providers[0];
    if (!activeProviderId && providers.length) setActiveProviderId(preferred.provider.id);
    else if (activeProviderId && !providers.some((item) => item.provider.id === activeProviderId)) {
      setActiveProviderId(preferred?.provider.id || null);
    }
  }, [providers, activeProviderId]);

  useEffect(() => {
    // Note: do not clear `selected` here. Opening a title from another
    // provider's row switches the active provider and selects the title in
    // the same update; clearing the selection would close the result screen
    // before its streams load. The provider menu closes it explicitly.
    setResults([]);
    setSearchError('');
    setHeroIndex(0);
  }, [activeProviderId]);

  useEffect(() => {
    if (view === 'search') searchInputRef.current?.focus();
  }, [view]);

  /* ------------------------------- search ------------------------------- */
  useEffect(() => {
    const term = query.trim();
    const canSearch = Boolean(provider) && (nativeOnly ? Boolean(cloudstreamServerUrl) : Boolean(provider?.code));
    if (view !== 'search' || !term || !provider || !canSearch) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError('');
    const timer = window.setTimeout(async () => {
      try {
        const items = nativeOnly
          ? await searchServerProvider(cloudstreamServerUrl, await resolveServerProviderName(cloudstreamServerUrl, provider.name), term, provider)
          : await searchCloudStreamProvider(provider, term, tmdbApiKey);
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
  }, [query, view, provider, nativeOnly, tmdbApiKey, cloudstreamServerUrl]);

  const filteredResults = useMemo(
    () => (typeFilter === 'all' ? results : results.filter((item) => item.type === typeFilter)),
    [results, typeFilter],
  );

  /* ------------------------------ home feeds ----------------------------- */
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

  useEffect(() => {
    if (!showRemoteHome || !provider) {
      setRemoteRows([]);
      setRemoteError('');
      return;
    }
    let cancelled = false;
    setRemoteLoading(true);
    setRemoteError('');
    (async () => {
      try {
        const serverName = await resolveServerProviderName(cloudstreamServerUrl, provider.name);
        const rows = await fetchServerMainPage(cloudstreamServerUrl, serverName, provider);
        if (!cancelled) setRemoteRows(rows);
      } catch (error) {
        if (!cancelled) {
          setRemoteRows([]);
          setRemoteError(error instanceof Error ? error.message : 'The CloudStream server could not load this provider.');
        }
      } finally {
        if (!cancelled) setRemoteLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [showRemoteHome, provider, cloudstreamServerUrl]);

  const remoteItems = useMemo(() => remoteRows.flatMap((row) => row.items), [remoteRows]);
  const remoteHero = remoteItems.length ? remoteItems[heroIndex % remoteItems.length] : undefined;

  const activeRow = useMemo(
    () => browseRows.find((row) => row.provider.id === activeProviderId) || null,
    [browseRows, activeProviderId],
  );
  const heroItems = useMemo(() => (activeRow?.items || []).slice(0, 5), [activeRow]);
  const hero = heroItems[heroIndex % Math.max(1, heroItems.length)];

  useEffect(() => {
    if (heroItems.length < 2) return;
    const timer = window.setInterval(() => setHeroIndex((index) => (index + 1) % heroItems.length), 7000);
    return () => window.clearInterval(timer);
  }, [heroItems.length]);

  /* ------------------------------ result page ---------------------------- */
  const selectedProvider = useMemo(
    () => providers.find((entry) => entry.provider.id === selected?.providerId)?.provider || provider,
    [providers, selected, provider],
  );

  const loadStreams = useCallback(async (
    item: MediaItem,
    mediaId: string,
    mediaType: 'movie' | 'series',
    targetProvider: CloudStreamProvider | undefined = provider,
  ) => {
    if (!targetProvider) return;
    setLoading(true);
    setErrors([]);
    setStreams([]);
    try {
      let result: StreamResult[];
      if (targetProvider.nativeOnly) {
        if (!cloudstreamServerUrl) throw new Error('Connect a CloudStream server in Settings to load this provider in the browser.');
        const serverName = await resolveServerProviderName(cloudstreamServerUrl, targetProvider.name);
        // Movies resolve links from the load response's dataUrl; episodes
        // pass their own data straight to loadLinks.
        const data = mediaType === 'movie'
          ? (await loadServerTitle(cloudstreamServerUrl, serverName, mediaId)).dataUrl || mediaId
          : mediaId;
        result = await fetchServerLinks(cloudstreamServerUrl, serverName, data, targetProvider);
      } else {
        result = await getCloudStreamStreams(targetProvider, mediaId, mediaType, tmdbApiKey);
      }
      setStreams(result);
      if (!result.length) setErrors([{ sourceName: targetProvider.name, message: 'This extension returned no streams for this title.' }]);
    } catch (error) {
      setErrors([{ sourceName: targetProvider.name, message: error instanceof Error ? error.message : 'Unable to resolve streams.' }]);
    } finally {
      setLoading(false);
    }
  }, [provider, tmdbApiKey, cloudstreamServerUrl]);

  const loadEpisodes = useCallback(async (
    item: MediaItem,
    targetProvider: CloudStreamProvider | undefined = provider,
  ) => {
    if (!targetProvider) return;
    setEpisodesLoading(true);
    setEpisodes([]);
    setActiveEpisode(null);
    try {
      const list = targetProvider.nativeOnly
        ? (await (async () => {
            if (!cloudstreamServerUrl) throw new Error('Connect a CloudStream server in Settings to load this provider in the browser.');
            const serverName = await resolveServerProviderName(cloudstreamServerUrl, targetProvider.name);
            return (await loadServerTitle(cloudstreamServerUrl, serverName, item.providerMediaId || item.id)).episodes;
          })())
        : await getCloudStreamEpisodes(targetProvider, item.providerMediaId || item.id, tmdbApiKey);
      setEpisodes(list);
      if (list.length) {
        setSeason(list[0].season || 1);
        setActiveEpisode(list[0].id);
        // The first episode is shown as selected, so resolve its streams too.
        void loadStreams(item, list[0].id, 'series', targetProvider);
      }
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : 'Episode list could not be loaded.');
    } finally {
      setEpisodesLoading(false);
    }
  }, [provider, tmdbApiKey, loadStreams, cloudstreamServerUrl]);

  const openMedia = (item: MediaItem) => {
    // A title must always be resolved by the provider that produced it.
    // Using the currently selected provider here breaks source loading when
    // a title is opened from another provider's row (setState has not yet
    // switched providers), e.g. from the native-provider home banner rows.
    const itemProvider = providers.find((entry) => entry.provider.id === item.providerId)?.provider || provider;
    if (itemProvider && itemProvider.id !== activeProviderId) setActiveProviderId(itemProvider.id);
    setSelected(item);
    setStreams([]);
    setErrors([]);
    setActiveEpisode(null);
    setSeason(1);
    if (item.type === 'series') void loadEpisodes(item, itemProvider);
    else void loadStreams(item, item.providerMediaId || item.id, 'movie', itemProvider);
  };

  const playEpisode = (episode: CloudStreamEpisode) => {
    if (!selected) return;
    setActiveEpisode(episode.id);
    void loadStreams(selected, episode.id, 'series', selectedProvider);
  };

  const refreshStreams = useCallback(() => {
    if (!selected) return;
    if (selected.type === 'series') {
      if (activeEpisode) void loadStreams(selected, activeEpisode, 'series', selectedProvider);
    } else {
      void loadStreams(selected, selected.providerMediaId || selected.id, 'movie', selectedProvider);
    }
  }, [selected, activeEpisode, loadStreams, selectedProvider]);

  const seasons = useMemo(
    () => [...new Set<number>(episodes.map((episode) => episode.season || 1))].sort((a, b) => a - b),
    [episodes],
  );
  const seasonEpisodes = useMemo(
    () => episodes.filter((episode) => (episode.season || 1) === season),
    [episodes, season],
  );

  const cloudstreamHistory = history.filter((entry) => entry.media.source === 'cloudstream');
  const cloudstreamLibrary = watchlist.filter((item) => item.source === 'cloudstream');
  const inList = (item: MediaItem) => watchlist.some((entry) => entry.id === item.id);

  /* -------------------------------- render ------------------------------- */
  if (providers.length === 0) {
    return (
      <div className="standard-page cloudstream-page page-enter">
        <div className="empty-state explore-empty">
          <span><Package size={28} /></span>
          <h2>No CloudStream extensions installed</h2>
          <p>Add a CloudStream repository to load its extensions and start browsing.</p>
          <button className="button button-primary" onClick={onOpenExtensions}>Manage extensions</button>
        </div>
      </div>
    );
  }

  return (
    <div className="standard-page cloudstream-page csx page-enter">
      {/* Top bar, mirroring the app: search, provider selector, reload. */}
      <div className="csx-topbar">
        {selected ? (
          <button className="csx-back" onClick={() => setSelected(null)}><ChevronLeft size={18} /> Back</button>
        ) : (
          <button className="csx-searchbar" onClick={() => setView('search')}>
            <Search size={16} /><span>Search movies, shows, anime…</span>
          </button>
        )}
        <div className="csx-topbar-actions">
          <div className="csx-provider-wrap">
            <button className="csx-provider-button" onClick={() => setProviderMenuOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={providerMenuOpen}>
              {provider?.iconUrl ? <img src={provider.iconUrl.replace('%size%', '64')} alt="" /> : <Package size={15} />}
              <span>{provider?.name || 'Select provider'}</span>
              <ChevronDown size={15} />
            </button>
            {providerMenuOpen && (
              <div className="csx-provider-menu" role="listbox" aria-label="CloudStream provider">
                <p className="csx-menu-label">Play in browser</p>
                {providers.filter((entry) => !entry.provider.nativeOnly).map(({ provider: p, repository }) => (
                  <button key={p.id} role="option" aria-selected={activeProviderId === p.id}
                    className={activeProviderId === p.id ? 'active' : ''}
                    onClick={() => { setActiveProviderId(p.id); setProviderMenuOpen(false); setView('home'); setSelected(null); }}>
                    {p.iconUrl ? <img src={p.iconUrl.replace('%size%', '64')} alt="" /> : <Package size={15} />}
                    <span><strong>{p.name}</strong><small>{repository.name}</small></span>
                    {p.nativeOnly && <span className="native-badge">CS3</span>}
                    {activeProviderId === p.id && <Check size={15} />}
                  </button>
                ))}
                <p className="csx-menu-label">CloudStream app (.cs3)</p>
                {providers.filter((entry) => entry.provider.nativeOnly).map(({ provider: p, repository }) => (
                  <button key={p.id} role="option" aria-selected={activeProviderId === p.id}
                    className={activeProviderId === p.id ? 'active' : ''}
                    onClick={() => { setActiveProviderId(p.id); setProviderMenuOpen(false); setView('home'); setSelected(null); }}>
                    {p.iconUrl ? <img src={p.iconUrl.replace('%size%', '64')} alt="" /> : <Package size={15} />}
                    <span><strong>{p.name}</strong><small>{repository.name}</small></span>
                    <span className="native-badge">CS3</span>
                    {activeProviderId === p.id && <Check size={15} />}
                  </button>
                ))}
                <button className="csx-provider-manage" onClick={() => { setProviderMenuOpen(false); onOpenExtensions(); }}>
                  <Package size={15} /><span><strong>Manage extensions</strong><small>Repositories &amp; providers</small></span>
                </button>
              </div>
            )}
          </div>
          <button className="icon-button" onClick={loadBrowse} aria-label="Reload provider" title="Reload provider"><RefreshCw size={16} /></button>
        </div>
      </div>

      {!tmdbApiKey && provider?.code?.includes('YOUR_TMDB_API_KEY') && (
        <p className="explore-note"><CircleAlert size={14} /> {provider.name} needs your TMDB API key before it can load titles. <button className="inline-link" onClick={onOpenSettings}>Add your TMDB key</button></p>
      )}

      {selected ? (
        /* ------------------------- Result screen ------------------------- */
        <div className="csx-result page-enter">
          <div className="csx-result-hero">
            {(selected.backdrop || selected.poster) && <img className="csx-result-backdrop" src={selected.backdrop || selected.poster} alt="" />}
            <div className="csx-result-shade" />
            <div className="csx-result-head">
              {selected.poster ? <img className="csx-result-poster" src={selected.poster} alt="" /> : <span className="csx-result-poster csx-no-poster"><Film size={28} /></span>}
              <div className="csx-result-meta">
                <span className="page-kicker">{selectedProvider?.name}</span>
                <h1>{selected.title}</h1>
                <div className="csx-meta-row">
                  {selected.year && <span>{selected.year}</span>}
                  <span>{selected.type === 'series' ? 'TV Series' : 'Movie'}</span>
                  {typeof selected.rating === 'number' && selected.rating > 0 && <span className="csx-rating"><Star size={12} fill="currentColor" /> {selected.rating.toFixed(1)}</span>}
                </div>
                {selected.genres.length > 0 && (
                  <div className="csx-tags">{selected.genres.map((genre) => <span key={genre}>{genre}</span>)}</div>
                )}
                {selected.overview && <p className="csx-overview">{selected.overview}</p>}
                <div className="csx-result-actions">
                  <button className="csx-play" disabled={loading || !streams.length} onClick={() => streams[0] && onPlay(selected, streams[0])}>
                    <Play size={17} fill="currentColor" /> Play
                  </button>
                  <button className="csx-ghost-action" onClick={() => onToggleWatchlist(selected)}>
                    {inList(selected) ? <Check size={16} /> : <Plus size={16} />} My List
                  </button>
                </div>
              </div>
            </div>
          </div>

          {selected.type === 'series' && (
            <section className="csx-episodes">
              <div className="csx-episodes-head">
                <h2>Episodes</h2>
                {seasons.length > 1 && (
                  <label className="csx-season-select">
                    <select value={season} onChange={(event) => setSeason(Number(event.target.value))} aria-label="Season">
                      {seasons.map((value) => <option key={value} value={value}>Season {value}</option>)}
                    </select>
                    <ChevronDown size={14} />
                  </label>
                )}
              </div>
              {episodesLoading ? (
                <span className="text-button"><LoaderCircle size={14} className="spin" /> Loading episodes…</span>
              ) : seasonEpisodes.length ? (
                <div className="csx-episode-list">
                  {seasonEpisodes.map((episode) => (
                    <button key={episode.id} className={`csx-episode ${episode.id === activeEpisode ? 'active' : ''}`} onClick={() => playEpisode(episode)}>
                      <span className="csx-episode-play"><Play size={14} fill="currentColor" /></span>
                      <span className="csx-episode-number">{episode.episode}</span>
                      <span className="csx-episode-title">{episode.title}</span>
                      {episode.id === activeEpisode && loading && <LoaderCircle size={14} className="spin" />}
                    </button>
                  ))}
                </div>
              ) : <span className="text-button">No episodes were returned for this series.</span>}
            </section>
          )}

          <section className="csx-links">
            <div className="csx-links-head">
              <h2>Links</h2>
              <span>{loading ? 'Loading…' : `${streams.length} link${streams.length === 1 ? '' : 's'}`}</span>
              <button className="icon-button" onClick={refreshStreams} disabled={loading} aria-label="Reload links"><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
            </div>
            {loading ? (
              <div className="csx-link-skeletons">{[0, 1, 2].map((index) => <span key={index} />)}</div>
            ) : streams.length ? (
              <div className="csx-link-list">
                {streams.map((stream) => (
                  <article className="csx-link" key={stream.id}>
                    <button className="stream-play" onClick={() => onPlay(selected, stream)} aria-label={`Play ${stream.title}`}><Play size={17} fill="currentColor" /></button>
                    <div className="csx-link-main">
                      <strong>{stream.title}</strong>
                      <small>{stream.sourceName}{stream.language ? ` · ${stream.language}` : ''}</small>
                    </div>
                    <span className="quality-badge">{stream.quality || 'AUTO'}</span>
                    <button className="button button-small button-primary" onClick={() => onPlay(selected, stream)}>Play <Play size={13} fill="currentColor" /></button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state source-empty">
                <span><Film size={26} /></span>
                <h2>No links found</h2>
                <p>{selected.type === 'series' ? 'Pick another episode, or try another provider.' : 'This provider returned no links for this title. Try another provider.'}</p>
              </div>
            )}
            {errors.length > 0 && !loading && (
              <details className="source-errors">
                <summary><CircleAlert size={14} /> {errors.length} source{errors.length === 1 ? '' : 's'} couldn’t respond</summary>
                {errors.map((error, index) => <p key={`${error.sourceName}-${index}`}><strong>{error.sourceName}</strong>{error.message}</p>)}
              </details>
            )}
          </section>
        </div>
      ) : view === 'home' ? (
        /* -------------------------- Home screen -------------------------- */
        <div className="csx-home">
          {showRemoteHome ? (
            <>
              {remoteHero && (
                <div className="csx-hero">
                  {(remoteHero.backdrop || remoteHero.poster) && <img src={remoteHero.backdrop || remoteHero.poster} alt="" />}
                  <div className="csx-hero-shade" />
                  <div className="csx-hero-copy">
                    <span className="page-kicker">{provider?.name} · CloudStream server</span>
                    <h1>{remoteHero.title}</h1>
                    <div className="csx-meta-row">
                      {remoteHero.year && <span>{remoteHero.year}</span>}
                      <span>{remoteHero.type === 'series' ? 'TV Series' : 'Movie'}</span>
                    </div>
                    <div className="csx-hero-actions">
                      <button className="csx-list-action" onClick={() => onToggleWatchlist(remoteHero)}>
                        {inList(remoteHero) ? <Check size={19} /> : <Plus size={19} />}<small>My List</small>
                      </button>
                      <button className="csx-play" onClick={() => openMedia(remoteHero)}><Play size={17} fill="currentColor" /> Play</button>
                      <button className="csx-list-action" onClick={() => openMedia(remoteHero)}>
                        <Info size={19} /><small>Info</small>
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {remoteLoading && <p className="explore-note"><LoaderCircle size={14} className="spin" /> Loading {provider?.name} from your CloudStream server…</p>}
              {remoteError && (
                <p className="explore-note"><CircleAlert size={14} /> {remoteError} <button className="inline-link" onClick={onOpenSettings}>Server settings</button></p>
              )}
              {!remoteLoading && !remoteError && !remoteRows.length && (
                <p className="csx-empty-note">Your CloudStream server returned no home-page rows for {provider?.name}.</p>
              )}
              {remoteRows.map((row) => (
                <section className="csx-section" key={row.name}>
                  <div className="csx-row-head">
                    <h2 className="csx-row-title">{row.name}</h2>
                    <span>{row.items.length} titles</span>
                  </div>
                  <div className="media-row">
                    {row.items.map((item) => (
                      <MediaCard key={item.id} item={item} onSelect={openMedia}
                        onToggleWatchlist={onToggleWatchlist} inWatchlist={inList(item)} compact={compact} />
                    ))}
                  </div>
                </section>
              ))}
            </>
          ) : showNativePage ? (
            <div className="csx-native-page">
              <div className="csx-native-hero">
                {provider?.iconUrl
                  ? <img className="csx-native-logo" src={provider.iconUrl.replace('%size%', '200')} alt="" />
                  : <span className="csx-native-logo csx-no-poster"><Package size={30} /></span>}
                <div className="csx-native-headline">
                  <span className="page-kicker">{active?.repository.name}</span>
                  <h1>{provider?.name}</h1>
                  {provider?.description && <p>{provider.description}</p>}
                  <div className="csx-native-chips">
                    {provider?.language && <span>{provider.language.toUpperCase()}</span>}
                    {(provider?.tvTypes?.length ? provider.tvTypes : provider?.supportedTypes || []).map((type) => <span key={type}>{type}</span>)}
                    {provider?.version !== undefined && <span>v{provider.version}</span>}
                    {typeof provider?.fileSize === 'number' && provider.fileSize > 0 && <span>{(provider.fileSize / 1024).toFixed(0)} KB</span>}
                    <span className="native-badge">CS3 · Android</span>
                  </div>
                  {Array.isArray(provider?.authors) && provider.authors.length > 0 && (
                    <p className="csx-native-authors">By {provider.authors.join(', ')}</p>
                  )}
                </div>
              </div>

              <div className="csx-native-search">
                <div className="explore-search">
                  <Search size={16} />
                  <input value={nativeQuery} onChange={(event) => setNativeQuery(event.target.value)}
                    placeholder={`Search ${provider?.name || 'this provider'} in the CloudStream app…`}
                    aria-label={`Search ${provider?.name || 'provider'} in the CloudStream app`} />
                </div>
                <a className="button button-primary" href={`cloudstreamsearch://${encodeURIComponent(nativeQuery.trim() || provider?.name || 'CloudStream')}`}>
                  <Smartphone size={16} /> Search in CloudStream app
                </a>
              </div>

              <div className="csx-native-actions">
                <a className="button button-secondary" href={cloudStreamRepoLink}><ExternalLink size={15} /> Add repository in CloudStream</a>
                {provider?.repositoryUrl && <a className="button button-secondary" href={provider.repositoryUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Provider source</a>}
                {provider?.url && <a className="button button-secondary" href={provider.url} target="_blank" rel="noreferrer"><Package size={15} /> .cs3 package</a>}
                <a className="button button-secondary" href="https://github.com/recloudstream/cloudstream/releases" target="_blank" rel="noreferrer">Get CloudStream</a>
                <button className="button button-secondary" onClick={onOpenExtensions}>Manage extensions</button>
              </div>

              <p className="explore-note"><CircleAlert size={14} /> This provider's catalog and streams are generated by its compiled Android plugin at runtime. To load them here, connect a CloudStream plugin server in Settings — it executes .cs3 providers (the same working logic as the app) and PRAHA will show this provider's home page, search, episodes, and links in this tab. <button className="inline-link" onClick={onOpenSettings}>Connect a server</button></p>
            </div>
          ) : (
            <>
              {hero && (
                <div className="csx-hero">
                  {(hero.backdrop || hero.poster) && <img src={hero.backdrop || hero.poster} alt="" />}
                  <div className="csx-hero-shade" />
                  <div className="csx-hero-copy">
                    <span className="page-kicker">{provider?.name}</span>
                    <h1>{hero.title}</h1>
                    <div className="csx-meta-row">
                      {hero.year && <span>{hero.year}</span>}
                      <span>{hero.type === 'series' ? 'TV Series' : 'Movie'}</span>
                      {typeof hero.rating === 'number' && hero.rating > 0 && <span className="csx-rating"><Star size={12} fill="currentColor" /> {hero.rating.toFixed(1)}</span>}
                    </div>
                    {hero.overview && <p>{hero.overview}</p>}
                    <div className="csx-hero-actions">
                      <button className="csx-list-action" onClick={() => onToggleWatchlist(hero)}>
                        {inList(hero) ? <Check size={19} /> : <Plus size={19} />}<small>My List</small>
                      </button>
                      <button className="csx-play" onClick={() => openMedia(hero)}><Play size={17} fill="currentColor" /> Play</button>
                      <button className="csx-list-action" onClick={() => openMedia(hero)}>
                        <Info size={19} /><small>Info</small>
                      </button>
                    </div>
                  </div>
                  {heroItems.length > 1 && (
                    <div className="csx-hero-dots">
                      {heroItems.map((item, index) => (
                        <button key={item.id} className={index === heroIndex % heroItems.length ? 'active' : ''} onClick={() => setHeroIndex(index)} aria-label={`Preview ${item.title}`} />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {cloudstreamHistory.length > 0 && (
                <section className="csx-section">
                  <h2 className="csx-row-title">Continue Watching</h2>
                  <div className="media-row">
                    {cloudstreamHistory.map((entry) => (
                      <button key={entry.media.id} className="csx-continue" onClick={() => openMedia(entry.media)}>
                        <span className="csx-continue-poster">
                          {entry.media.poster || entry.media.backdrop ? <img src={entry.media.poster || entry.media.backdrop} alt="" /> : <Package size={18} />}
                        </span>
                        <span className="csx-continue-body">
                          <strong>{entry.media.title}</strong>
                          <small>{entry.episode ? `S${entry.season || 1} E${entry.episode}` : 'Movie'}</small>
                          <span className="cs-progress"><span style={{ width: `${Math.min(100, Math.max(0, entry.progress * 100))}%` }} /></span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section className="csx-section">
                <h2 className="csx-row-title"><Bookmark size={16} /> Bookmarked</h2>
                <div className="csx-chips">
                  {BOOKMARK_LISTS.map((list) => (
                    <button key={list} className={bookmarkList === list ? 'active' : ''} onClick={() => setBookmarkList(list)}>{list}</button>
                  ))}
                </div>
                {bookmarkList === 'Watching' && cloudstreamLibrary.length ? (
                  <div className="media-row">
                    {cloudstreamLibrary.map((item) => (
                      <MediaCard key={item.id} item={item} onSelect={openMedia}
                        onToggleWatchlist={onToggleWatchlist} inWatchlist compact={compact} />
                    ))}
                  </div>
                ) : (
                  <p className="csx-empty-note">Nothing in {bookmarkList} yet. Use “My List” on a title to put it here.</p>
                )}
              </section>

              {activeRow && (
                <section className="csx-section">
                  <div className="csx-row-head">
                    <h2 className="csx-row-title">{provider?.name}</h2>
                    <span>{activeRow.loading ? 'Loading…' : `${activeRow.items.length} titles`}</span>
                  </div>
                  <div className="media-row">
                    {activeRow.loading ? Array.from({ length: 8 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>) : activeRow.items.map((item) => (
                      <MediaCard key={item.id} item={item} onSelect={openMedia}
                        onToggleWatchlist={onToggleWatchlist} inWatchlist={inList(item)} compact={compact} />
                    ))}
                    {!activeRow.loading && !activeRow.items.length && (activeRow.error ? (
                      <span className="explore-note"><CircleAlert size={14} /> {activeRow.provider.name}: {activeRow.error}</span>
                    ) : <span className="text-button">This provider returned no titles for its home page.</span>)}
                  </div>
                  {!activeRow.loading && activeRow.items.length > 12 && (
                    <>
                      <h3 className="csx-row-subtitle">More from {provider?.name}</h3>
                      <div className="media-row">
                        {activeRow.items.slice(12).map((item) => (
                          <MediaCard key={item.id} item={item} onSelect={openMedia}
                            onToggleWatchlist={onToggleWatchlist} inWatchlist={inList(item)} compact={compact} />
                        ))}
                      </div>
                    </>
                  )}
                </section>
              )}

              {providers.some((entry) => entry.provider.nativeOnly) && (
                <p className="explore-note"><CircleAlert size={14} /> {providers.filter((entry) => entry.provider.nativeOnly).length} of your CloudStream extensions are native .cs3 packages. CloudStream is an Android app and its Kotlin extensions can't execute in a browser — pick one above to open it in the official app. <a className="inline-link" href="https://github.com/recloudstream/cloudstream/releases" target="_blank" rel="noreferrer">Get the official CloudStream app</a></p>
              )}
            </>
          )}
        </div>
      ) : (
        /* ------------------------- Search screen ------------------------- */
        <div className="csx-search">
          {showNativePage ? (
            <div className="empty-state explore-empty">
              <span><Package size={26} /></span>
              <h2>Native CloudStream extension</h2>
              <p>{provider?.name} is a compiled Kotlin .cs3 package for the Android CloudStream app. A browser cannot execute it, so PRAHA can hand the search and repository to the official app instead.</p>
              <div className="tmdb-setup-actions">
                <a className="button button-primary" href={cloudStreamSearchLink}><Smartphone size={16} /> Search in CloudStream app</a>
                <a className="button button-secondary" href={cloudStreamRepoLink}><ExternalLink size={16} /> Add repository in CloudStream</a>
                <a className="button button-secondary" href="https://github.com/recloudstream/cloudstream/releases" target="_blank" rel="noreferrer">Get CloudStream</a>
              </div>
            </div>
          ) : (
            <>
              <div className="explore-search csx-search-input">
                <Search size={17} />
                <input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)}
                  placeholder={`Search with ${provider?.name || 'CloudStream'}…`} aria-label="Search" />
                {query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Clear search">×</button>}
              </div>
              <div className="csx-chips">
                {([['all', 'All'], ['movie', 'Movies'], ['series', 'TV Series']] as const).map(([value, label]) => (
                  <button key={value} className={typeFilter === value ? 'active' : ''} onClick={() => setTypeFilter(value)}>{label}</button>
                ))}
                <span className="csx-search-provider">{provider?.name}</span>
              </div>
              {searchError && <p className="explore-note"><CircleAlert size={14} />{searchError}</p>}
              {searching ? (
                <div className="media-grid">{Array.from({ length: 12 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>)}</div>
              ) : filteredResults.length ? (
                <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
                  {filteredResults.map((item) => (
                    <MediaCard key={item.id} item={item} onSelect={openMedia}
                      onToggleWatchlist={onToggleWatchlist} inWatchlist={inList(item)} compact={compact} />
                  ))}
                </div>
              ) : (
                <div className="empty-state explore-empty">
                  <span><Search size={26} /></span>
                  <h2>{query ? 'No results' : 'Search to find something to watch'}</h2>
                  <p>{query ? 'Try a different title, or pick another provider from the top bar.' : `Search ${provider?.name || 'this provider'} to browse and play its sources.`}</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default CloudStreamPage;
