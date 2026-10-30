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
import { CINEMETA_ADDON, CURATED_MEDIA, DEFAULT_PROGRESS, DEFAULT_SETTINGS } from './data/catalog';
import { buildBuiltinCloudStreamJsRepository, BUILTIN_MANIFEST_URL } from './data/cloudstreamJsPlugins';
import { fetchStremioCatalog, fetchStremioMeta, searchStremioAddons } from './services/stremioService';
import { searchCurated, tmdbService } from './services/tmdbService';
import type {
  AppSettings, AppView, CloudStreamRepository, InstalledAddon, MediaItem, NuvioRepository,
  StreamResult, ToastMessage, WatchProgress,
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

const App: React.FC = () => {
  const [view, setView] = useState<AppView>('home');
  const [query, setQuery] = useState('');
  const [trending, setTrending] = useState<MediaItem[]>(CURATED_MEDIA);
  const [discoverItems, setDiscoverItems] = useState<MediaItem[]>(CURATED_MEDIA);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [sourceMedia, setSourceMedia] = useState<MediaItem | null>(null);
  const [player, setPlayer] = useState<{ media: MediaItem; stream: StreamResult } | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const [addons, setAddons] = usePersistentState<InstalledAddon[]>('praha.v2.addons', [CINEMETA_ADDON]);
  const [repositories, setRepositories] = usePersistentState<NuvioRepository[]>('praha.v2.nuvio-repositories', []);
  const [cloudstreamRepositories, setCloudstreamRepositories] = usePersistentState<CloudStreamRepository[]>('praha.v2.cloudstream-repositories', []);
  const [watchlist, setWatchlist] = usePersistentState<MediaItem[]>('praha.v2.watchlist', []);
  const [history, setHistory] = usePersistentState<WatchProgress[]>('praha.v2.history', DEFAULT_PROGRESS);
  const [settings, setSettings] = usePersistentState<AppSettings>('praha.v2.settings', DEFAULT_SETTINGS);

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

  useEffect(() => {
    let active = true;
    Promise.all([tmdbService.trending('movie'), tmdbService.trending('tv')])
      .then(([movies, series]) => { if (active) setTrending(uniqueMedia([...movies, ...series, ...CURATED_MEDIA])); })
      .catch(() => { if (active) setTrending(CURATED_MEDIA); });
    return () => { active = false; };
  }, [settings.tmdbApiKey]);

  useEffect(() => {
    if (view !== 'discover') return;
    let active = true;
    const timer = window.setTimeout(async () => {
      setDiscoverLoading(true);
      const term = query.trim();
      try {
        if (term) {
          const local = searchCurated(term);
          const [tmdb, stremio] = await Promise.all([
            tmdbService.search(term).catch(() => []),
            searchStremioAddons(addons, term).catch(() => []),
          ]);
          if (active) setDiscoverItems(uniqueMedia([...local, ...tmdb, ...stremio]));
        } else {
          const catalogJobs = addons.filter((addon) => addon.enabled).flatMap((addon) =>
            addon.manifest.catalogs.filter((catalog) => catalog.id === 'top').slice(0, 2)
              .map((catalog) => fetchStremioCatalog(addon, catalog).catch(() => [])),
          );
          const [catalogs, movies, series] = await Promise.all([
            Promise.all(catalogJobs),
            tmdbService.trending('movie').catch(() => []),
            tmdbService.trending('tv').catch(() => []),
          ]);
          if (active) setDiscoverItems(uniqueMedia([...CURATED_MEDIA, ...movies, ...series, ...catalogs.flat()]));
        }
      } finally {
        if (active) setDiscoverLoading(false);
      }
    }, query ? 400 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [view, query, addons, settings.tmdbApiKey]);

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
    if (item.tmdbId && (!item.genres.length || !item.imdbId)) {
      tmdbService.enrich(item).then((enriched) => setSelected((current) => current?.id === item.id ? enriched : current)).catch(() => undefined);
    }
  };

  const openSources = (item: MediaItem) => {
    setSelected(null);
    setSourceMedia(item);
  };

  const playStream = (stream: StreamResult) => {
    if (!sourceMedia) return;
    const media = sourceMedia;
    setHistory((current) => {
      const existing = current.find((entry) => entry.media.id === media.id);
      return [{ media, progress: existing?.progress || 1, watchedAt: Date.now() }, ...current.filter((entry) => entry.media.id !== media.id)].slice(0, 30);
    });
    setSourceMedia(null);
    setPlayer({ media, stream });
  };

  const playExplorerStream = (media: MediaItem, stream: StreamResult) => {
    setHistory((current) => {
      const existing = current.find((entry) => entry.media.id === media.id);
      return [{ media, progress: existing?.progress || 1, watchedAt: Date.now() }, ...current.filter((entry) => entry.media.id !== media.id)].slice(0, 30);
    });
    setPlayer({ media, stream });
  };

  let page: React.ReactNode;
  if (view === 'home') {
    page = <HomeView trending={trending} history={history} watchlist={watchlist} addons={addons} repositories={repositories}
      onSelect={openDetails} onPlay={openSources} onToggleWatchlist={toggleWatchlist}
      onOpenExtensions={() => navigate('extensions')} onOpenLibrary={() => navigate('library')} compact={settings.compactCards} />;
  } else if (view === 'discover') {
    page = <DiscoverView items={discoverItems} loading={discoverLoading} query={query} watchlist={watchlist}
      onSelect={openDetails} onToggleWatchlist={toggleWatchlist} onClearSearch={() => setQuery('')} compact={settings.compactCards} />;
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
      {player && <React.Suspense fallback={<div className="player-backdrop"><div className="player-loading"><span className="brand-mark"><span /></span><p>Preparing your stream…</p></div></div>}><PlayerModal media={player.media} stream={player.stream} autoplay={settings.autoplay} onClose={() => setPlayer(null)} /></React.Suspense>}

      {toast && <div className={`toast toast-${toast.tone}`} role="status">
        {toast.tone === 'success' ? <CheckCircle2 size={18} /> : toast.tone === 'error' ? <CircleAlert size={18} /> : <Info size={18} />}
        <span>{toast.message}</span><button onClick={() => setToast(null)} aria-label="Dismiss notification"><X size={15} /></button>
      </div>}
    </>
  );
};

export default App;
