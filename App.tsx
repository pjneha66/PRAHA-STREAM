import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useSpatialNavigation } from './hooks/useSpatialNavigation';
import {
  CINEMETA_ADDON, DEFAULT_DISCOVER_FILTERS, DEFAULT_PROFILE, DEFAULT_SETTINGS,
  EMPTY_HOME_CATALOG, normalizeSettings,
} from './data/defaults';
import {
  buildBuiltinCloudStreamJsRepository, refreshBuiltinCloudStreamJsRepository, BUILTIN_MANIFEST_URL,
} from './data/cloudstreamJsPlugins';
import { fetchStremioCatalog, fetchStremioMeta, findStremioStreams, searchStremioAddons } from './services/stremioService';
import { findNuvioStreams } from './services/nuvioService';
import { findCloudStreamStreamsForMedia } from './services/cloudstreamService';
import { tmdbService } from './services/tmdbService';
import { exitAndroidApp, exportBackupFile } from './services/androidBridge';
import { createBackupBundle, scrobbleWatchProgress, validateAndParseBackup } from './services/backupSyncService';
import type {
  AppSettings, AppView, CloudStreamRepository, DiscoverFilters, HomeCatalog, InstalledAddon,
  LibraryStatus, MediaItem, NuvioRepository, PlayerSettings, StreamResult, ToastMessage,
  UserProfile, WatchProgress,
} from './types';

const PlayerModal = React.lazy(() => import('./components/PlayerModal'));

const VALID_VIEWS: AppView[] = ['home', 'discover', 'library', 'explore', 'cloudstream', 'extensions', 'settings'];

function parseHashView(): AppView {
  if (typeof window === 'undefined') return 'home';
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0] as AppView;
  return VALID_VIEWS.includes(raw) ? raw : 'home';
}

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

interface SourceRequest {
  media: MediaItem;
  season?: number;
  episode?: number;
  episodeTitle?: string;
}

interface ActivePlayerState {
  media: MediaItem;
  stream: StreamResult;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  initialTime?: number;
}

const App: React.FC = () => {
  const [view, setView] = useState<AppView>(() => parseHashView());
  const [query, setQuery] = useState('');
  const [discoverFilters, setDiscoverFilters] = useState<DiscoverFilters>(DEFAULT_DISCOVER_FILTERS);
  const [discoverPage, setDiscoverPage] = useState(1);
  const [discoverHasMore, setDiscoverHasMore] = useState(false);
  const [discoverLoadingMore, setDiscoverLoadingMore] = useState(false);

  const [catalog, setCatalog] = useState<HomeCatalog>(EMPTY_HOME_CATALOG);
  const [catalogState, setCatalogState] = useState<LoadState>('idle');
  const [catalogError, setCatalogError] = useState('');
  const [discoverItems, setDiscoverItems] = useState<MediaItem[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState('');
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [sourceState, setSourceState] = useState<SourceRequest | null>(null);
  const [player, setPlayer] = useState<ActivePlayerState | null>(null);
  const [nextEpisodeLoading, setNextEpisodeLoading] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const lastBackExitPromptRef = useRef(0);
  const scrobbledKeysRef = useRef<Set<string>>(new Set());

  const [addons, setAddons] = usePersistentState<InstalledAddon[]>('praha.v2.addons', [CINEMETA_ADDON]);
  const [repositories, setRepositories] = usePersistentState<NuvioRepository[]>('praha.v2.nuvio-repositories', []);
  const [cloudstreamRepositories, setCloudstreamRepositories] = usePersistentState<CloudStreamRepository[]>('praha.v2.cloudstream-repositories', []);
  const [nuvioSettings, setNuvioSettings] = usePersistentState<Record<string, Record<string, unknown>>>('praha.v2.nuvio-settings', {});
  const [rawSettings, setSettings] = usePersistentState<AppSettings>('praha.v2.settings', DEFAULT_SETTINGS);
  const settings = useMemo(() => normalizeSettings(rawSettings), [rawSettings]);

  const [profiles, setProfiles] = usePersistentState<UserProfile[]>('praha.v2.profiles', [DEFAULT_PROFILE]);
  const [activeProfileId, setActiveProfileId] = usePersistentState<string>('praha.v2.active-profile', DEFAULT_PROFILE.id);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) || profiles[0] || DEFAULT_PROFILE,
    [profiles, activeProfileId],
  );

  const watchlistKey = activeProfile.id === 'default'
    ? 'praha.v2.watchlist'
    : `praha.v2.profile.${activeProfile.id}.watchlist`;
  const historyKey = activeProfile.id === 'default'
    ? 'praha.v2.history'
    : `praha.v2.profile.${activeProfile.id}.history`;

  const [watchlist, setWatchlist] = usePersistentState<MediaItem[]>(watchlistKey, []);
  const [history, setHistory] = usePersistentState<WatchProgress[]>(historyKey, []);

  // Spatial D-Pad / Android TV remote navigation (pauses automatically while video player is open)
  useSpatialNavigation(settings.dpadNavigation, Boolean(player));

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

  // URL hash deep-link synchronization
  useEffect(() => {
    const targetHash = `#/${view}`;
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, '', targetHash);
    }
  }, [view]);

  useEffect(() => {
    const onHashChange = () => {
      const next = parseHashView();
      setView(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Android Hardware Back Button handler
  useEffect(() => {
    const onHardwareBack = (event: Event) => {
      event.preventDefault?.();
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => undefined);
        return;
      }
      if (player) {
        setPlayer(null);
        return;
      }
      if (sourceState) {
        setSourceState(null);
        return;
      }
      if (selected) {
        setSelected(null);
        return;
      }
      if (view !== 'home') {
        setView('home');
        return;
      }
      const now = Date.now();
      if (now - lastBackExitPromptRef.current < 2200) {
        exitAndroidApp();
      } else {
        lastBackExitPromptRef.current = now;
        notify('Press back again to exit PRAHA STREAM.');
      }
    };

    window.addEventListener('praha:hardware-back', onHardwareBack);
    return () => window.removeEventListener('praha:hardware-back', onHardwareBack);
  }, [player, sourceState, selected, view, notify]);

  const updatePlayerSettings = useCallback((patch: Partial<PlayerSettings>) => {
    setSettings((current) => {
      const norm = normalizeSettings(current);
      return { ...norm, player: { ...norm.player, ...patch } };
    });
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

  // Discover search & filtered TMDB /discover + Stremio catalogs
  useEffect(() => {
    if (view !== 'discover') return;
    let active = true;
    const timer = window.setTimeout(async () => {
      setDiscoverLoading(true);
      setDiscoverError('');
      setDiscoverPage(1);
      const term = query.trim();
      try {
        if (term) {
          const [tmdb, stremio] = await Promise.all([
            tmdbReady ? tmdbService.search(term, 1).catch(() => []) : Promise.resolve([]),
            searchStremioAddons(addons, term).catch(() => []),
          ]);
          if (active) {
            setDiscoverItems(uniqueMedia([...tmdb, ...stremio]));
            setDiscoverHasMore(tmdb.length >= 16);
          }
        } else {
          const catalogJobs = discoverFilters.source !== 'tmdb'
            ? addons.filter((addon) => addon.enabled).flatMap((addon) =>
                addon.manifest.catalogs.filter((cat) => cat.id === 'top').slice(0, 2)
                  .map((cat) => fetchStremioCatalog(addon, cat).catch(() => [])),
              )
            : [];
          const [addonItems, tmdbDiscovered] = await Promise.all([
            Promise.all(catalogJobs),
            tmdbReady && discoverFilters.source !== 'stremio'
              ? tmdbService.discover(discoverFilters, 1)
              : Promise.resolve({ items: [], hasMore: false }),
          ]);
          if (active) {
            setDiscoverItems(uniqueMedia([...tmdbDiscovered.items, ...addonItems.flat()]));
            setDiscoverHasMore(tmdbDiscovered.hasMore);
          }
        }
      } catch (error) {
        if (active) setDiscoverError(error instanceof Error ? error.message : 'Search failed.');
      } finally {
        if (active) setDiscoverLoading(false);
      }
    }, query ? 380 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [view, query, discoverFilters, addons, tmdbReady]);

  const loadMoreDiscover = useCallback(async () => {
    if (!tmdbReady || discoverLoadingMore || !discoverHasMore) return;
    const nextPage = discoverPage + 1;
    setDiscoverLoadingMore(true);
    try {
      const term = query.trim();
      if (term) {
        const more = await tmdbService.search(term, nextPage);
        setDiscoverItems((prev) => uniqueMedia([...prev, ...more]));
        setDiscoverPage(nextPage);
        setDiscoverHasMore(more.length >= 16);
      } else {
        const more = await tmdbService.discover(discoverFilters, nextPage);
        setDiscoverItems((prev) => uniqueMedia([...prev, ...more.items]));
        setDiscoverPage(nextPage);
        setDiscoverHasMore(more.hasMore);
      }
    } catch {
      setDiscoverHasMore(false);
    } finally {
      setDiscoverLoadingMore(false);
    }
  }, [tmdbReady, discoverLoadingMore, discoverHasMore, discoverPage, query, discoverFilters]);

  const activeSourceCount = useMemo(() =>
    addons.filter((addon) => addon.enabled).length +
    repositories.filter((repo) => repo.enabled).length +
    cloudstreamRepositories.filter((repo) => repo.enabled).length,
  [addons, repositories, cloudstreamRepositories]);

  const builtinJsRepo = useMemo(() => buildBuiltinCloudStreamJsRepository(), []);
  useEffect(() => {
    setCloudstreamRepositories((current) => {
      const existing = current.find((repo) => repo.manifestUrl === BUILTIN_MANIFEST_URL);
      if (!existing) return [builtinJsRepo, ...current];
      const refreshed = refreshBuiltinCloudStreamJsRepository(existing);
      const unchanged = JSON.stringify({ ...refreshed, updatedAt: existing.updatedAt }) === JSON.stringify(existing);
      return unchanged ? current : current.map((repo) => repo.manifestUrl === BUILTIN_MANIFEST_URL ? refreshed : repo);
    });
  }, [builtinJsRepo, setCloudstreamRepositories]);

  const navigate = (next: AppView) => {
    setView(next);
    window.scrollTo({ top: 0, behavior: settings.reduceMotion ? 'auto' : 'smooth' });
  };

  const toggleWatchlist = (item: MediaItem, defaultStatus: LibraryStatus = 'plan') => {
    const exists = watchlist.some((entry) => entry.id === item.id);
    setWatchlist((current) =>
      exists
        ? current.filter((entry) => entry.id !== item.id)
        : [{ ...item, libraryStatus: item.libraryStatus || defaultStatus }, ...current],
    );
    notify(exists ? `${item.title} removed from your library.` : `${item.title} saved to your library.`, 'success');
  };

  const updateWatchlistStatus = (item: MediaItem, status: LibraryStatus) => {
    setWatchlist((current) => {
      const exists = current.some((entry) => entry.id === item.id);
      if (exists) {
        return current.map((entry) => (entry.id === item.id ? { ...entry, libraryStatus: status } : entry));
      }
      return [{ ...item, libraryStatus: status }, ...current];
    });
    notify(`${item.title} moved to ${status}.`, 'success');
  };

  const openDetails = (item: MediaItem) => {
    setSelected(item);
    if (item.source === 'stremio' && item.addonUrl) {
      const addon = addons.find((entry) => entry.manifestUrl === item.addonUrl);
      if (addon) {
        fetchStremioMeta(addon, item)
          .then((metaItem) => (tmdbReady ? tmdbService.enrich(metaItem).catch(() => metaItem) : metaItem))
          .then((enriched) => setSelected((current) => (current?.id === item.id ? enriched : current)))
          .catch(() => undefined);
        return;
      }
    }
    if (tmdbReady && (item.tmdbId || item.imdbId || item.id.startsWith('tt'))) {
      tmdbService.enrich(item)
        .then((enriched) => setSelected((current) => (current?.id === item.id ? enriched : current)))
        .catch(() => undefined);
    }
  };

  const openSources = (item: MediaItem, season?: number, episode?: number, episodeTitle?: string) => {
    const existing = history.find((h) => h.media.id === item.id);
    setSelected(null);
    setSourceState({
      media: item,
      season: season ?? existing?.season ?? (item.type === 'series' ? 1 : undefined),
      episode: episode ?? existing?.episode ?? (item.type === 'series' ? 1 : undefined),
      episodeTitle: episodeTitle ?? existing?.episodeTitle,
    });
  };

  const upsertHistory = useCallback((patch: {
    media: MediaItem;
    stream?: StreamResult;
    season?: number;
    episode?: number;
    episodeTitle?: string;
    currentTime?: number;
    duration?: number;
  }) => {
    setHistory((current) => {
      const prev = current.find((entry) => entry.media.id === patch.media.id);
      const sameEpisode = !patch.season || (prev?.season === patch.season && prev?.episode === patch.episode);
      const duration = patch.duration ?? (sameEpisode ? prev?.duration : undefined);
      const currentTime = patch.currentTime ?? (sameEpisode ? prev?.currentTime : 0);
      const progress = duration && duration > 0 && typeof currentTime === 'number'
        ? Math.max(1, Math.min(100, Math.round((currentTime / duration) * 100)))
        : (sameEpisode ? prev?.progress || 1 : 1);

      const nextEntry: WatchProgress = {
        media: patch.media,
        progress,
        currentTime,
        duration,
        watchedAt: Date.now(),
        season: patch.season ?? prev?.season,
        episode: patch.episode ?? prev?.episode,
        episodeTitle: patch.episodeTitle ?? (sameEpisode ? prev?.episodeTitle : undefined),
        lastStream: patch.stream ?? prev?.lastStream,
      };

      const scrobbleKey = `${patch.media.id}:${nextEntry.season || 0}:${nextEntry.episode || 0}`;
      if (progress >= 80 && !scrobbledKeysRef.current.has(scrobbleKey)) {
        scrobbledKeysRef.current.add(scrobbleKey);
        scrobbleWatchProgress(nextEntry, settings.sync).catch(() => undefined);
      }

      return [nextEntry, ...current.filter((entry) => entry.media.id !== patch.media.id)].slice(0, 50);
    });
  }, [setHistory, settings.sync]);

  const removeHistoryEntry = useCallback((target: WatchProgress) => {
    setHistory((current) => current.filter((entry) => entry.media.id !== target.media.id));
    notify(`Removed ${target.media.title} from Continue Watching.`);
  }, [setHistory, notify]);

  const resumeWatchEntry = (entry: WatchProgress) => {
    if (entry.lastStream && entry.progress < 96) {
      setPlayer({
        media: entry.media,
        stream: entry.lastStream,
        season: entry.season,
        episode: entry.episode,
        episodeTitle: entry.episodeTitle,
        initialTime: entry.currentTime || 0,
      });
      return;
    }
    openSources(entry.media, entry.season, entry.episode, entry.episodeTitle);
  };

  const playStream = (stream: StreamResult, season?: number, episode?: number, episodeTitle?: string) => {
    if (!sourceState) return;
    const { media } = sourceState;
    const existing = history.find((entry) =>
      entry.media.id === media.id &&
      (media.type === 'movie' || (entry.season === season && entry.episode === episode)),
    );
    const resumeTime = existing && existing.progress < 95 ? (existing.currentTime || 0) : 0;

    upsertHistory({ media, stream, season, episode, episodeTitle });
    setSourceState(null);
    setPlayer({ media, stream, season, episode, episodeTitle, initialTime: resumeTime });
  };

  const playExplorerStream = (media: MediaItem, stream: StreamResult) => {
    const existing = history.find((entry) => entry.media.id === media.id);
    const resumeTime = existing && existing.progress < 95 ? (existing.currentTime || 0) : 0;
    upsertHistory({ media, stream });
    setPlayer({ media, stream, initialTime: resumeTime });
  };

  const handlePlayerProgress = useCallback((currentTime: number, duration: number) => {
    if (!player) return;
    upsertHistory({
      media: player.media,
      stream: player.stream,
      season: player.season,
      episode: player.episode,
      episodeTitle: player.episodeTitle,
      currentTime,
      duration,
    });
  }, [player, upsertHistory]);

  const handleNextEpisode = useCallback(async () => {
    if (!player || player.media.type !== 'series' || !player.season || !player.episode) return;
    setNextEpisodeLoading(true);
    try {
      let nextSeason = player.season;
      let nextEp = player.episode + 1;
      let nextTitle: string | undefined;

      if (tmdbReady && player.media.tmdbId) {
        const seasonEps = await tmdbService.getSeason(player.media.tmdbId, player.season).catch(() => []);
        if (seasonEps.length && nextEp > seasonEps.length) {
          nextSeason = player.season + 1;
          nextEp = 1;
        }
        const targetList = nextSeason === player.season
          ? seasonEps
          : await tmdbService.getSeason(player.media.tmdbId, nextSeason).catch(() => []);
        nextTitle = targetList.find((e) => e.episode === nextEp)?.title;
      }

      const ids = await tmdbService.resolveIds(player.media).catch(() => ({
        tmdbId: player.media.tmdbId ? String(player.media.tmdbId) : undefined,
        imdbId: player.media.imdbId,
      }));
      const resolved = { ...player.media, imdbId: ids.imdbId || player.media.imdbId };

      const [stremio, nuvio, cs] = await Promise.all([
        findStremioStreams(addons, resolved, nextSeason, nextEp),
        ids.tmdbId
          ? findNuvioStreams(repositories, ids.tmdbId, 'series', nextSeason, nextEp, nuvioSettings)
          : Promise.resolve({ streams: [], errors: [] }),
        findCloudStreamStreamsForMedia(cloudstreamRepositories, resolved, ids.tmdbId, settings.tmdbApiKey, nextSeason, nextEp),
      ]);

      const allStreams = [...stremio.streams, ...nuvio.streams, ...cs.streams];
      const preferred = allStreams.find((s) => s.sourceName === player.stream.sourceName && !s.url.startsWith('magnet:'))
        || allStreams.find((s) => !s.url.startsWith('magnet:'))
        || allStreams[0];

      if (preferred) {
        upsertHistory({ media: player.media, stream: preferred, season: nextSeason, episode: nextEp, episodeTitle: nextTitle, currentTime: 0 });
        setPlayer({
          media: player.media,
          stream: preferred,
          season: nextSeason,
          episode: nextEp,
          episodeTitle: nextTitle,
          initialTime: 0,
        });
        notify(`Playing S${nextSeason} E${nextEp}${nextTitle ? ` — ${nextTitle}` : ''}`, 'success');
      } else {
        const media = player.media;
        setPlayer(null);
        openSources(media, nextSeason, nextEp, nextTitle);
      }
    } catch {
      notify('Could not automatically load next episode.', 'error');
    } finally {
      setNextEpisodeLoading(false);
    }
  }, [player, tmdbReady, addons, repositories, nuvioSettings, cloudstreamRepositories, settings.tmdbApiKey, upsertHistory, notify]);

  // Profile management
  const createProfile = (name: string, avatarColor: string, isKids: boolean) => {
    const id = `prof-${Date.now().toString(36)}`;
    const created: UserProfile = { id, name, avatarColor, isKids, createdAt: Date.now() };
    setProfiles((cur) => [...cur, created]);
    setActiveProfileId(id);
    notify(`Switched to ${name}.`, 'success');
  };

  const deleteProfile = (profileId: string) => {
    if (profileId === 'default') return;
    setProfiles((cur) => cur.filter((p) => p.id !== profileId));
    try {
      window.localStorage.removeItem(`praha.v2.profile.${profileId}.watchlist`);
      window.localStorage.removeItem(`praha.v2.profile.${profileId}.history`);
    } catch { /* ignore */ }
    if (activeProfileId === profileId) setActiveProfileId('default');
    notify('Profile deleted.');
  };

  // Backup Export & Import
  const handleExportBackup = async () => {
    const profileData: Record<string, { watchlist: MediaItem[]; history: WatchProgress[] }> = {};
    profiles.forEach((prof) => {
      const wKey = prof.id === 'default' ? 'praha.v2.watchlist' : `praha.v2.profile.${prof.id}.watchlist`;
      const hKey = prof.id === 'default' ? 'praha.v2.history' : `praha.v2.profile.${prof.id}.history`;
      try {
        profileData[prof.id] = {
          watchlist: JSON.parse(window.localStorage.getItem(wKey) || '[]'),
          history: JSON.parse(window.localStorage.getItem(hKey) || '[]'),
        };
      } catch {
        profileData[prof.id] = { watchlist: [], history: [] };
      }
    });

    const bundle = createBackupBundle({
      settings,
      addons,
      repositories,
      cloudstreamRepositories,
      nuvioSettings,
      profiles,
      activeProfileId: activeProfile.id,
      profileData,
    });
    const filename = `praha-stream-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const mode = await exportBackupFile(filename, JSON.stringify(bundle, null, 2));
    notify(mode === 'shared' ? 'Backup ready to share or save.' : `Backup exported as ${filename}.`, 'success');
  };

  const handleImportBackup = async (file: File) => {
    try {
      const text = await file.text();
      const restored = validateAndParseBackup(text);
      setSettings(normalizeSettings(restored.settings));
      setAddons(restored.addons);
      setRepositories(restored.repositories);
      setCloudstreamRepositories(restored.cloudstreamRepositories);
      setNuvioSettings(restored.nuvioSettings || {});
      setProfiles(restored.profiles);

      Object.entries(restored.profileData).forEach(([profId, data]) => {
        const wKey = profId === 'default' ? 'praha.v2.watchlist' : `praha.v2.profile.${profId}.watchlist`;
        const hKey = profId === 'default' ? 'praha.v2.history' : `praha.v2.profile.${profId}.history`;
        window.localStorage.setItem(wKey, JSON.stringify(data.watchlist || []));
        window.localStorage.setItem(hKey, JSON.stringify(data.history || []));
      });

      setActiveProfileId(restored.activeProfileId);
      const currentProfData = restored.profileData[restored.activeProfileId];
      if (currentProfData) {
        setWatchlist(currentProfData.watchlist || []);
        setHistory(currentProfData.history || []);
      }
      notify('Backup restored! Sources, profiles, library, and settings are active.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not import backup file.', 'error');
    }
  };

  let page: React.ReactNode;
  if (view === 'home') {
    page = (
      <HomeView
        catalog={catalog}
        loading={catalogState === 'loading'}
        error={catalogError}
        tmdbReady={tmdbReady}
        history={history}
        watchlist={watchlist}
        addons={addons}
        repositories={repositories}
        onSelect={openDetails}
        onPlay={(item) => openSources(item)}
        onResumeEntry={resumeWatchEntry}
        onRemoveHistory={removeHistoryEntry}
        onToggleWatchlist={(item) => toggleWatchlist(item)}
        onOpenExtensions={() => navigate('extensions')}
        onOpenLibrary={() => navigate('library')}
        onOpenSettings={() => navigate('settings')}
        onRetry={loadCatalog}
        compact={settings.compactCards}
      />
    );
  } else if (view === 'discover') {
    page = (
      <DiscoverView
        items={discoverItems}
        loading={discoverLoading}
        loadingMore={discoverLoadingMore}
        hasMore={discoverHasMore}
        error={discoverError}
        query={query}
        filters={discoverFilters}
        onFiltersChange={setDiscoverFilters}
        onLoadMore={loadMoreDiscover}
        watchlist={watchlist}
        tmdbReady={tmdbReady}
        onSelect={openDetails}
        onToggleWatchlist={(item) => toggleWatchlist(item)}
        onClearSearch={() => setQuery('')}
        onOpenSettings={() => navigate('settings')}
        compact={settings.compactCards}
      />
    );
  } else if (view === 'library') {
    page = (
      <LibraryView
        watchlist={watchlist}
        history={history}
        profileName={activeProfile.name}
        onSelect={openDetails}
        onPlay={(item) => openSources(item)}
        onResumeEntry={resumeWatchEntry}
        onRemoveHistory={removeHistoryEntry}
        onToggleWatchlist={(item) => toggleWatchlist(item)}
        onExplore={() => navigate('discover')}
        onClearHistory={() => { setHistory([]); notify('Watch history cleared.'); }}
        compact={settings.compactCards}
      />
    );
  } else if (view === 'explore') {
    page = (
      <ExploreView
        addons={addons}
        repositories={repositories}
        watchlist={watchlist}
        compact={settings.compactCards}
        preferredLanguage={settings.preferredLanguage}
        onToggleWatchlist={(item) => toggleWatchlist(item)}
        onPlay={playExplorerStream}
        onOpenExtensions={() => navigate('extensions')}
      />
    );
  } else if (view === 'cloudstream') {
    page = (
      <CloudStreamPage
        repositories={cloudstreamRepositories}
        history={history}
        watchlist={watchlist}
        compact={settings.compactCards}
        preferredLanguage={settings.preferredLanguage}
        tmdbApiKey={settings.tmdbApiKey}
        cloudstreamServerUrl={settings.cloudstreamServerUrl || ''}
        onServerUrlChange={(url) => setSettings({ ...settings, cloudstreamServerUrl: url })}
        onOpenSettings={() => navigate('settings')}
        onToggleWatchlist={(item) => toggleWatchlist(item, 'watching')}
        onPlay={playExplorerStream}
        onOpenExtensions={() => navigate('extensions')}
      />
    );
  } else if (view === 'extensions') {
    page = (
      <ExtensionsView
        addons={addons}
        repositories={repositories}
        cloudstreamRepositories={cloudstreamRepositories}
        nuvioSettings={nuvioSettings}
        setAddons={setAddons}
        setRepositories={setRepositories}
        setCloudstreamRepositories={setCloudstreamRepositories}
        setNuvioSettings={setNuvioSettings}
        notify={notify}
      />
    );
  } else {
    page = (
      <SettingsView
        settings={settings}
        onChange={setSettings}
        onReset={() => {
          setSettings({ ...DEFAULT_SETTINGS, tmdbApiKey: settings.tmdbApiKey || '' });
          notify('Preferences reset. Your TMDB API key was kept.', 'success');
        }}
        addons={addons}
        repositories={repositories}
        cloudstreamRepositories={cloudstreamRepositories}
        profiles={profiles}
        activeProfile={activeProfile}
        onSelectProfile={(id) => {
          setActiveProfileId(id);
          const target = profiles.find((p) => p.id === id);
          if (target) notify(`Switched to ${target.name}.`, 'success');
        }}
        onCreateProfile={createProfile}
        onDeleteProfile={deleteProfile}
        onExportBackup={handleExportBackup}
        onImportBackup={handleImportBackup}
      />
    );
  }

  return (
    <>
      <Navigation
        view={view}
        onNavigate={navigate}
        query={query}
        onQueryChange={setQuery}
        onSearch={() => navigate('discover')}
        sourceCount={activeSourceCount}
        profiles={profiles}
        activeProfile={activeProfile}
        onSelectProfile={(id) => {
          setActiveProfileId(id);
          const target = profiles.find((p) => p.id === id);
          if (target) notify(`Switched to ${target.name}.`, 'success');
        }}
      >
        {page}
      </Navigation>

      {selected && (
        <DetailsModal
          item={selected}
          watchlist={watchlist}
          history={history}
          onClose={() => setSelected(null)}
          onPlay={openSources}
          onSelectRecommendation={openDetails}
          onToggleWatchlist={toggleWatchlist}
          onUpdateStatus={updateWatchlistStatus}
          inWatchlist={watchlist.some((item) => item.id === selected.id)}
        />
      )}

      {sourceState && (
        <SourceModal
          media={sourceState.media}
          initialSeason={sourceState.season}
          initialEpisode={sourceState.episode}
          addons={addons}
          repositories={repositories}
          cloudstreamRepositories={cloudstreamRepositories}
          nuvioSettings={nuvioSettings}
          tmdbApiKey={settings.tmdbApiKey}
          preferredLanguage={settings.preferredLanguage}
          onClose={() => setSourceState(null)}
          onOpenExtensions={() => { setSourceState(null); navigate('extensions'); }}
          onPlay={playStream}
        />
      )}

      {player && (
        <React.Suspense fallback={<div className="player-backdrop"><div className="player-loading"><span className="brand-mark"><span /></span><p>Preparing your stream…</p></div></div>}>
          <PlayerModal
            media={player.media}
            stream={player.stream}
            season={player.season}
            episode={player.episode}
            episodeTitle={player.episodeTitle}
            initialTime={player.initialTime}
            addons={addons}
            debrid={settings.debrid}
            preferNativeProxy={settings.preferNativeProxy}
            autoplay={settings.autoplay}
            playerSettings={settings.player}
            onPlayerSettingsChange={updatePlayerSettings}
            onProgress={handlePlayerProgress}
            onNextEpisode={player.media.type === 'series' && player.season && player.episode ? handleNextEpisode : undefined}
            nextEpisodeLoading={nextEpisodeLoading}
            onOpenSettings={() => navigate('settings')}
            onClose={() => setPlayer(null)}
          />
        </React.Suspense>
      )}

      {toast && (
        <div className={`toast toast-${toast.tone}`} role="status">
          {toast.tone === 'success' ? <CheckCircle2 size={18} /> : toast.tone === 'error' ? <CircleAlert size={18} /> : <Info size={18} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss notification"><X size={15} /></button>
        </div>
      )}
    </>
  );
};

export default App;
