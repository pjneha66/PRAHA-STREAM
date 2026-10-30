import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react';
import Navigation from './components/Navigation';
import HomeView from './components/HomeView';
import DiscoverView from './components/DiscoverView';
import LibraryView from './components/LibraryView';
import ExtensionsView from './components/ExtensionsView';
import ExploreView from './components/ExploreView';
import CloudStreamPage from './components/CloudStreamPage';
import SettingsView from './components/SettingsView';
import DetailsModal from './components/DetailsModal';
import SourceModal from './components/SourceModal';
import { usePersistentState } from './hooks/usePersistentState';
import { CINEMETA_ADDON, DEFAULT_SETTINGS, EMPTY_HOME_CATALOG } from './data/defaults';
import { buildBuiltinCloudStreamJsRepository, BUILTIN_MANIFEST_URL } from './data/cloudstreamJsPlugins';
import { fetchStremioCatalog, fetchStremioMeta, searchStremioAddons } from './services/stremioService';
import { tmdbService } from './services/tmdbService';
import type {
  AppSettings, AppView, CloudStreamRepository, HomeCatalog, InstalledAddon, MediaItem,
  NuvioRepository, PlayerSettings, StreamResult, ToastMessage, WatchProgress,
} from './types';

const PlayerModal = React.lazy(() => import('./components/PlayerModal'));

const uniqueMedia = (items: MediaItem[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.title.toLowerCase().replace(/[^a-z0-9]/g, '')}-${item.year || ''}`;
    if (!item.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const App: React.FC = () => {
  const [view, setView] = useState<AppView>('home');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<HomeCatalog>(EMPTY_HOME_CATALOG);
  const [catalogState, setCatalogState] = useState<LoadState>('idle');
  const [catalogError, setCatalogError] = useState('');
  const [discoverItems, setDiscoverItems] = useState<MediaItem[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState('');
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [sourceMedia, setSourceMedia] = useState<MediaItem | null>(null);
  const [player, setPlayer] = useState<{ media: MediaItem; stream: StreamResult } | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const [addons, setAddons] = usePersistentState<InstalledAddon[]>('praha.v2.addons', [CINEMETA_ADDON]);
  const [repositories, setRepositories] = usePersistentState<NuvioRepository[]>('praha.v2.nuvio-repositories', []);
  const [cloudstreamRepositories, setCloudstreamRepositories] = usePersistentState<CloudStreamRepository[]>('praha.v2.cloudstream-repositories', []);
  const [watchlist, setWatchlist] = usePersistentState<MediaItem[]>('praha.v2.watchlist', []);
  const [history, setHistory] = usePersistentState<WatchProgress[]>('praha.v2.history', []);
  const [settings, setSettings] = usePersistentState<AppSettings>('praha.v2.settings', DEFAULT_SETTINGS);

  /** PRAHA ships no catalog of its own — TMDB is the only metadata source. */
  const tmdbReady = Boolean(settings.tmdbApiKey?.trim());

  const notify = useCallback((message: string, tone: 'default' | 'success' | 'error' = 'default') => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    document.documentElement.dataset.accent = settings.accent;
    document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion);
  }, [settings.accent, settings.reduceMotion]);

  const updatePlayerSettings = useCallback((patch: Partial<PlayerSettings>) => {
    setSettings((current) => ({ ...current, player: { ...current.player, ...patch } }));
  }, [setSettings]);

  const loadCatalog = useCallback(() => {
    if (!tmdbReady) {
      setCatalog(EMPTY_HOME_CATALOG);
      setCatalogState('idle');
      setCatalogError('');
      return;
    }
    let active = true;
    setCatalogState('loading');
    setCatalogError('');
    (async () => {
      try {
        const [trending, movies, series, topRated] = await Promise.all([
          tmdbService.trending('all', 'week'),
          tmdbService.catalog('popular', 'movie'),
          tmdbService.catalog('popular', 'tv'),
          tmdbService.catalog('top_rated', 'movie'),
        ]);
        if (!active) return;
        // Spotlight titles need full metadata (runtime, genres, certification, IMDB id).
        const spotlight = await Promise.all(
          uniqueMedia([...trending, ...movies]).filter((item) => item.backdrop).slice(0, 5)
            .map((item) => tmdbService.enrich(item).catch(() => item)),
        );
        if (!active) return;
        setCatalog({
          hero: spotlight,
          trending: uniqueMedia(trending),
          movies: uniqueMedia(movies),
          series: uniqueMedia(series),
          topRated: uniqueMedia(topRated),
        });
        setCatalogState('ready');
      } catch (error) {
        if (!active) return;
        setCatalog(EMPTY_HOME_CATALOG);
        setCatalogError(error instanceof Error ? error.message : 'TMDB could not be reached.');
        setCatalogState('error');
      }
    })();
    return () => { active = false; };
  }, [tmdbReady]);

  useEffect(() => loadCatalog(), [loadCatalog]);

  useEffect(() => {
    if (view !== 'discover') return;
    let active = true;
    const timer = window.setTimeout(async () => {
      setDiscoverLoading(true);
      setDiscoverError('');
      const term = query.trim();
      try {
        if (term) {
          const [tmdb, stremio] = await Promise.all([
            tmdbReady ? tmdbService.search(term).catch(() => []) : Promise.resolve([]),
            searchStremioAddons(addons, term).catch(() => []),
          ]);
          if (active) setDiscoverItems(uniqueMedia([...tmdb, ...stremio]));
        } else {
          const catalogJobs = addons.filter((addon) => addon.enabled).flatMap((addon) =>
            addon.manifest.catalogs.filter((catalog) => catalog.id === 'top').slice(0, 2)
              .map((catalog) => fetchStremioCatalog(addon, catalog).catch(() => [])),
          );
          const [catalogs, movies, series] = await Promise.all([
            Promise.all(catalogJobs),
            tmdbReady ? tmdbService.trending('movie').catch(() => []) : Promise.resolve([]),
            tmdbReady ? tmdbService.trending('tv').catch(() => []) : Promise.resolve([]),
          ]);
          if (active) setDiscoverItems(uniqueMedia([...movies, ...series, ...catalogs.flat()]));
        }
      } catch (error) {
        if (active) setDiscoverError(error instanceof Error ? error.message : 'Search failed.');
      } finally {
        if (active) setDiscoverLoading(false);
      }
    }, query ? 400 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [view, query, addons, tmdbReady]);

  const activeSourceCount = useMemo(() =>
    addons.filter((addon) => addon.enabled).length +
    repositories.filter((repo) => repo.enabled).length +
    cloudstreamRepositories.filter((repo) => repo.enabled).length,
  [addons, repositories, cloudstreamRepositories]);

  // Always include the browser-playable built-in CloudStream JS extensions so
  // the CloudStream tab shows real content even when a repo only ships .cs3.
  const builtinJsRepo = useMemo(() => buildBuiltinCloudStreamJsRepository(), []);
  useEffect(() => {
    setCloudstreamRepositories((current) =>
      current.some((repo) => repo.manifestUrl === BUILTIN_MANIFEST_URL) ? current : [builtinJsRepo, ...current],
    );
  }, [builtinJsRepo, setCloudstreamRepositories]);

  const navigate = (next: AppView) => {
    setView(next);
    window.scrollTo({ top: 0, behavior: settings.reduceMotion ? 'auto' : 'smooth' });
  };

  const toggleWatchlist = (item: MediaItem) => {
    const exists = watchlist.some((entry) => entry.id === item.id);
    setWatchlist((current) => exists ? current.filter((entry) => entry.id !== item.id) : [item, ...current]);
    notify(exists ? `${item.title} removed from your library.` : `${item.title} saved to your library.`, 'success');
  };

  const openDetails = (item: MediaItem) => {
    setSelected(item);
    if (item.source === 'stremio' && item.addonUrl) {
      const addon = addons.find((entry) => entry.manifestUrl === item.addonUrl);
      if (addon) {
        fetchStremioMeta(addon, item).then((enriched) => setSelected((current) => current?.id === item.id ? enriched : current)).catch(() => undefined);
        return;
      }
    }
    if (item.tmdbId && (!item.genres.length || !item.imdbId || !item.runtime)) {
      tmdbService.enrich(item).then((enriched) => setSelected((current) => current?.id === item.id ? enriched : current)).catch(() => undefined);
    }
  };

  const openSources = (item: MediaItem) => {
    setSelected(null);
    setSourceMedia(item);
  };

  const recordProgress = (media: MediaItem) => setHistory((current) => {
    const existing = current.find((entry) => entry.media.id === media.id);
    return [{ media, progress: existing?.progress || 1, watchedAt: Date.now() }, ...current.filter((entry) => entry.media.id !== media.id)].slice(0, 30);
  });

  const playStream = (stream: StreamResult) => {
    if (!sourceMedia) return;
    const media = sourceMedia;
    recordProgress(media);
    setSourceMedia(null);
    setPlayer({ media, stream });
  };

  const playExplorerStream = (media: MediaItem, stream: StreamResult) => {
    recordProgress(media);
    setPlayer({ media, stream });
  };

  let page: React.ReactNode;
  if (view === 'home') {
    page = <HomeView catalog={catalog} loading={catalogState === 'loading'} error={catalogError}
      tmdbReady={tmdbReady} history={history} watchlist={watchlist} addons={addons} repositories={repositories}
      onSelect={openDetails} onPlay={openSources} onToggleWatchlist={toggleWatchlist}
      onOpenExtensions={() => navigate('extensions')} onOpenLibrary={() => navigate('library')}
      onOpenSettings={() => navigate('settings')} onRetry={loadCatalog} compact={settings.compactCards} />;
  } else if (view === 'discover') {
    page = <DiscoverView items={discoverItems} loading={discoverLoading} error={discoverError} query={query}
      watchlist={watchlist} tmdbReady={tmdbReady}
      onSelect={openDetails} onToggleWatchlist={toggleWatchlist} onClearSearch={() => setQuery('')}
      onOpenSettings={() => navigate('settings')} compact={settings.compactCards} />;
  } else if (view === 'library') {
    page = <LibraryView watchlist={watchlist} history={history} onSelect={openDetails} onPlay={openSources}
      onToggleWatchlist={toggleWatchlist} onExplore={() => navigate('discover')} onClearHistory={() => { setHistory([]); notify('Watch history cleared.'); }} compact={settings.compactCards} />;
  } else if (view === 'explore') {
    page = <ExploreView addons={addons} repositories={repositories}
      watchlist={watchlist} compact={settings.compactCards} preferredLanguage={settings.preferredLanguage}
      onToggleWatchlist={toggleWatchlist} onPlay={playExplorerStream}
      onOpenExtensions={() => navigate('extensions')} />;
  } else if (view === 'cloudstream') {
    page = <CloudStreamPage repositories={cloudstreamRepositories} history={history} watchlist={watchlist}
      compact={settings.compactCards} preferredLanguage={settings.preferredLanguage}
      tmdbApiKey={settings.tmdbApiKey}
      onToggleWatchlist={toggleWatchlist} onPlay={playExplorerStream}
      onOpenExtensions={() => navigate('extensions')} />;
  } else if (view === 'extensions') {
    page = <ExtensionsView addons={addons} repositories={repositories} cloudstreamRepositories={cloudstreamRepositories}
      setAddons={setAddons} setRepositories={setRepositories} setCloudstreamRepositories={setCloudstreamRepositories} notify={notify} />;
  } else {
    page = <SettingsView settings={settings} onChange={setSettings} onReset={() => { setSettings({ ...DEFAULT_SETTINGS, tmdbApiKey: settings.tmdbApiKey || '' }); notify('Preferences reset. Your TMDB API key was kept.', 'success'); }} addons={addons} repositories={repositories} cloudstreamRepositories={cloudstreamRepositories} />;
  }

  return (
    <>
      <Navigation view={view} onNavigate={navigate} query={query} onQueryChange={setQuery}
        onSearch={() => navigate('discover')} sourceCount={activeSourceCount}>
        {page}
      </Navigation>

      {selected && <DetailsModal item={selected} onClose={() => setSelected(null)} onPlay={openSources}
        onToggleWatchlist={toggleWatchlist} inWatchlist={watchlist.some((item) => item.id === selected.id)} />}
      {sourceMedia && <SourceModal media={sourceMedia} addons={addons} repositories={repositories}
        preferredLanguage={settings.preferredLanguage} onClose={() => setSourceMedia(null)}
        onOpenExtensions={() => { setSourceMedia(null); navigate('extensions'); }} onPlay={playStream} />}
      {player && <React.Suspense fallback={<div className="player-backdrop"><div className="player-loading"><span className="brand-mark"><span /></span><p>Preparing your stream…</p></div></div>}><PlayerModal media={player.media} stream={player.stream} autoplay={settings.autoplay} playerSettings={settings.player} onPlayerSettingsChange={updatePlayerSettings} onClose={() => setPlayer(null)} /></React.Suspense>}

      {toast && <div className={`toast toast-${toast.tone}`} role="status">
        {toast.tone === 'success' ? <CheckCircle2 size={18} /> : toast.tone === 'error' ? <CircleAlert size={18} /> : <Info size={18} />}
        <span>{toast.message}</span><button onClick={() => setToast(null)} aria-label="Dismiss notification"><X size={15} /></button>
      </div>}
    </>
  );
};

export default App;
