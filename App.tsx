import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react';
import Navigation from './components/Navigation';
import HomeView from './components/HomeView';
import EmbedModal from './components/EmbedModal';
import DiscoverView from './components/DiscoverView';
import LibraryView from './components/LibraryView';
import ExtensionsView from './components/ExtensionsView';
import ExploreView from './components/ExploreView';
import AnimeView from './components/AnimeView';
import SankaExplorer from './components/SankaExplorer';
import AudiobooksView from './components/AudiobooksView';
import BooksView from './components/BooksView';
import MusicView from './components/MusicView';
import { MusicPlayerProvider } from './components/music/MusicPlayerProvider';
import MusicPlayerBar from './components/music/MusicPlayerBar';
import NowPlayingSheet from './components/music/NowPlayingSheet';
import LiveTvView from './components/LiveTvView';
import FlowView from './components/FlowView';
import ProfilePicker from './components/ProfilePicker';
import PersonModal from './components/PersonModal';
import SettingsView from './components/SettingsView';
import DetailsModal from './components/DetailsModal';
import SourceModal from './components/SourceModal';
import UpdateModal from './components/UpdateModal';
import { usePersistentState } from './hooks/usePersistentState';
import { useSpatialNavigation } from './hooks/useSpatialNavigation';
import {
  CINEMETA_ADDON, DEFAULT_DISCOVER_FILTERS, DEFAULT_PROFILE, DEFAULT_SETTINGS,
  EMPTY_HOME_CATALOG, normalizeSettings,
} from './data/defaults';
import { fetchStremioCatalog, fetchStremioMeta, findStremioStreams, searchStremioAddons } from './services/stremioService';
import { findNuvioStreams } from './services/nuvioService';
import { tmdbService } from './services/tmdbService';
import type { JellyfinSnapshot } from './services/jellyfinService';
import { animeService } from './services/animeService';
import { imdxService } from './services/imdxService';
import { DEFAULT_HOME_ROWS, normalizeHomeRows, readHomeCache, writeHomeCache } from './services/homeCache';
import type { HomeRowSettings } from './services/homeCache';
import { exitAndroidApp, exportBackupFile, getNativeAppVersion, nativeVlcStop } from './services/androidBridge';
import { createBackupBundle, scrobbleWatchProgress, validateAndParseBackup } from './services/backupSyncService';
import { checkForUpdates, type UpdateInfo } from './services/autoUpdateService';
import { OctaveMusicService, type MusicTrack } from './services/musicService';
import { noteSearchTerm } from './services/searchHistory';
import { hashPin } from './services/profilePin';
import { ARCHIVE_COLLECTIONS, BooksService, type BookItem } from './services/archiveService';
import { buildIptvPlayback, IptvZapStore } from './services/iptvService';
import {
  APP_VERSION,
  AppSettings, AppView, DiscoverFilters, HomeCatalog, InstalledAddon,
  LibraryStatus, MediaItem, NuvioRepository, PlayerSettings, ProfileAvatarIcon, StreamResult, ToastMessage,
  UserProfile, WatchProgress, PrahaBackupBundle,
} from './types';

const SESSION_PROFILE_KEY = 'praha.v2.session-profile-picked';

const PlayerModal = React.lazy(() => import('./components/PlayerModal'));

const VALID_VIEWS: AppView[] = ['home', 'livetv', 'anime', 'sanka', 'music', 'audiobooks', 'books', 'discover', 'flow', 'library', 'explore', 'extensions', 'settings'];

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
  alternatives?: StreamResult[];
}

/** Profile PIN gate: shown instead of switching when the target profile has a PIN. */
const ProfilePinGate: React.FC<{
  profile: UserProfile;
  onUnlocked: () => void;
  onCancel: () => void;
}> = ({ profile, onUnlocked, onCancel }) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    const hash = await hashPin(pin);
    if (hash === profile.pinHash) {
      onUnlocked();
    } else {
      setError('Wrong PIN.');
      setPin('');
    }
  };
  return (
    <div className="modal-backdrop" style={{ zIndex: 300 }} onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section role="dialog" aria-modal="true" aria-label={`Enter PIN for ${profile.name}`} style={{ margin: 'auto', background: '#161b22', border: '1px solid #30363d', borderRadius: '16px', padding: '26px 24px', width: 'min(320px, 90vw)', textAlign: 'center' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: '17px', color: '#f0f6fc' }}>Enter PIN for {profile.name}</h2>
        <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: '#8b949e' }}>This profile is protected.</p>
        <input
          value={pin}
          onChange={(event) => { setPin(event.target.value.replace(/\D/g, '').slice(0, 8)); setError(''); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && pin.length >= 4) void submit(); }}
          inputMode="numeric"
          autoFocus
          placeholder="••••"
          style={{ width: '100%', textAlign: 'center', letterSpacing: '0.5em', fontSize: '20px', padding: '10px 0', borderRadius: '10px', border: error ? '1px solid #f87171' : '1px solid #30363d', background: '#0d1117', color: '#f0f6fc' }}
        />
        {error && <p style={{ margin: '8px 0 0', fontSize: '12px', color: '#f87171' }}>{error}</p>}
        <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
          <button onClick={onCancel} style={{ flex: 1, padding: '9px 0', borderRadius: '9px', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => void submit()} disabled={pin.length < 4} style={{ flex: 1, padding: '9px 0', borderRadius: '9px', border: 'none', background: pin.length >= 4 ? '#ef4444' : '#3a3f46', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: pin.length >= 4 ? 'pointer' : 'default' }}>Unlock</button>
        </div>
      </section>
    </div>
  );
};


const App: React.FC = () => {
  const [view, setView] = useState<AppView>(() => parseHashView());
  const [query, setQuery] = useState('');
  // Universal search extras (music + books/comics) and cross-tab deep links.
  const [discoverExtras, setDiscoverExtras] = useState<{ music: MusicTrack[]; books: BookItem[] } | null>(null);
  const [searchPrefill, setSearchPrefill] = useState<{ view: AppView; term: string } | null>(null);
  const [pinGateProfile, setPinGateProfile] = useState<UserProfile | null>(null);
  const [personModal, setPersonModal] = useState<{ id: number; name: string } | null>(null);
  const [discoverFilters, setDiscoverFilters] = useState<DiscoverFilters>(DEFAULT_DISCOVER_FILTERS);
  const [discoverPage, setDiscoverPage] = useState(1);
  const [discoverHasMore, setDiscoverHasMore] = useState(false);
  const [discoverLoadingMore, setDiscoverLoadingMore] = useState(false);

  const [catalog, setCatalog] = useState<HomeCatalog>(() => { try { return readHomeCache(window.localStorage) || EMPTY_HOME_CATALOG; } catch { return EMPTY_HOME_CATALOG; } });
  const [catalogState, setCatalogState] = useState<LoadState>('idle');
  const [catalogError, setCatalogError] = useState('');
  const [jellyfinSnapshot, setJellyfinSnapshot] = useState<(JellyfinSnapshot & { profileId: string }) | null>(null);
  const [imdxSpotlight, setImdxSpotlight] = useState<MediaItem[]>([]);
  const [discoverItems, setDiscoverItems] = useState<MediaItem[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState('');
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [sourceState, setSourceState] = useState<SourceRequest | null>(null);
  const [embedState, setEmbedState] = useState<SourceRequest | null>(null);
  const [player, setPlayer] = useState<ActivePlayerState | null>(null);
  const playerIdentityRef = useRef<string | null>(null);
  const playerIdentity = player ? JSON.stringify([player.media.id, player.season, player.episode, player.stream.id]) : null;
  playerIdentityRef.current = playerIdentity;
  const [nextEpisodeLoading, setNextEpisodeLoading] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const playbackPositionRef = useRef(0);
  const lastBackExitPromptRef = useRef(0);
  const scrobbledKeysRef = useRef<Set<string>>(new Set());
  // Bumped whenever a new Discover search starts. "Load more" captures the
  // token so a page fetched for an older query cannot be appended afterwards.
  const discoverRequestRef = useRef(0);

  const [addons, setAddons] = usePersistentState<InstalledAddon[]>('praha.v2.addons', [CINEMETA_ADDON]);
  const [repositories, setRepositories] = usePersistentState<NuvioRepository[]>('praha.v2.nuvio-repositories', []);
  const [nuvioSettings, setNuvioSettings] = usePersistentState<Record<string, Record<string, unknown>>>('praha.v2.nuvio-settings', {});
  const [rawSettings, setSettings] = usePersistentState<AppSettings>('praha.v2.settings', DEFAULT_SETTINGS);
  const settings = useMemo(() => normalizeSettings(rawSettings), [rawSettings]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.accent || 'gold');
  }, [settings.accent]);

  const [profiles, setProfiles] = usePersistentState<UserProfile[]>('praha.v2.profiles', [DEFAULT_PROFILE]);
  const [activeProfileId, setActiveProfileId] = usePersistentState<string>('praha.v2.active-profile', DEFAULT_PROFILE.id);
  const [sessionProfilePicked, setSessionProfilePicked] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      return Boolean(window.sessionStorage.getItem(SESSION_PROFILE_KEY));
    } catch {
      return false;
    }
  });
  const [profileSwitcherOpen, setProfileSwitcherOpen] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null);
  const profilePickerCompleted = sessionProfilePicked || settings.askProfileOnStartup === false;
  const showProfileGate = profileSwitcherOpen || !profilePickerCompleted;

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) || profiles[0] || DEFAULT_PROFILE,
    [profiles, activeProfileId],
  );

  useEffect(() => { setJellyfinSnapshot(null); }, [activeProfile.id]);

  const watchlistKey = activeProfile.id === 'default'
    ? 'praha.v2.watchlist'
    : `praha.v2.profile.${activeProfile.id}.watchlist`;
  const historyKey = activeProfile.id === 'default'
    ? 'praha.v2.history'
    : `praha.v2.profile.${activeProfile.id}.history`;

  const [watchlist, setWatchlist] = usePersistentState<MediaItem[]>(watchlistKey, []);
  const [history, setHistory] = usePersistentState<WatchProgress[]>(historyKey, []);
  const [homeRowsRaw, setHomeRows] = usePersistentState<HomeRowSettings>(`praha.v2.profile.${activeProfile.id}.home-rows`, DEFAULT_HOME_ROWS);
  const homeRows = useMemo(() => normalizeHomeRows(homeRowsRaw), [homeRowsRaw]);
  const [preferredSource, setPreferredSource] = usePersistentState<string>(`praha.v2.profile.${activeProfile.id}.preferred-source`, '');

  // Spatial D-Pad / Android TV remote navigation (pauses automatically while video player is open)
  useSpatialNavigation(settings.dpadNavigation, Boolean(player));

  const tmdbReady = Boolean(settings.tmdbApiKey?.trim());
  const imdxEnabled = imdxService.isEnabled(settings.imdx);
  const imdxBaseUrl = settings.imdx.baseUrl;
  const imdxApiKey = settings.imdx.apiKey;

  const notify = useCallback((message: string, tone: 'default' | 'success' | 'error' = 'default') => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  // Autonomous In-App Update check on launch
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const activeVersion = getNativeAppVersion() || APP_VERSION;
      checkForUpdates(activeVersion)
        .then((info) => {
          if (info && info.hasUpdate) {
            setAvailableUpdate(info);
          }
        })
        .catch(() => {});
    }, 2800);
    return () => window.clearTimeout(timer);
  }, []);

  const manualCheckUpdates = useCallback(async () => {
    notify('Checking for updates…');
    try {
      const activeVersion = getNativeAppVersion() || APP_VERSION;
      const info = await checkForUpdates(activeVersion);
      if (info && info.hasUpdate) {
        setAvailableUpdate(info);
      } else {
        notify(`PRAHA STREAM is up to date (v${activeVersion}).`, 'success');
      }
    } catch {
      notify('Unable to check for updates right now.', 'error');
    }
  }, [notify]);

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

  const closePlayer = useCallback(() => {
    try {
      nativeVlcStop();
      document.documentElement.classList.remove('player-vlc-active');
      document.body.classList.remove('player-vlc-active');
      document.getElementById('root')?.classList.remove('player-vlc-active');
    } catch {}
    setPlayer(null);
  }, []);

  // Android Hardware Back Button handler
  useEffect(() => {
    const onHardwareBack = (event: Event) => {
      event.preventDefault?.();
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => undefined);
        return;
      }
      if (profileSwitcherOpen) {
        setProfileSwitcherOpen(false);
        return;
      }
      if (player) {
        closePlayer();
        return;
      }
      if (embedState) {
        setEmbedState(null);
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
  }, [profileSwitcherOpen, player, sourceState, embedState, selected, view, notify]);

  // Custom background image (port of PlayTorrio's custom background): URL
  // based, dimmed with a scrim so text stays readable.
  useEffect(() => {
    const url = (settings.customBackground || '').trim();
    if (url && /^https?:\/\//.test(url)) {
      document.body.style.backgroundImage = `linear-gradient(rgba(8,9,11,.82), rgba(8,9,11,.9)), url("${url.replace(/"/g, '')}")`;
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundPosition = 'center';
      document.body.style.backgroundAttachment = 'fixed';
    } else {
      document.body.style.backgroundImage = '';
    }
    return () => { document.body.style.backgroundImage = ''; };
  }, [settings.customBackground]);

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
      // Without a TMDB key the optional IMDx provider can still supply a catalog.
      if (imdxEnabled) {
        let active = true;
        setCatalogState('loading');
        Promise.all([
          imdxService.list(settings.imdx, ['MOVIE']).catch(() => [] as MediaItem[]),
          imdxService.list(settings.imdx, ['TV_SERIES']).catch(() => [] as MediaItem[]),
        ]).then(([movies, series]) => {
          if (!active) return;
          if (!movies.length && !series.length) {
            setCatalogError('IMDx returned no titles. Check the IMDx card in Settings, or add a TMDB key.');
            setCatalogState('error');
            return;
          }
          setCatalog({
            hero: uniqueMedia([...series, ...movies]).filter((item) => item.poster).slice(0, 5),
            trending: uniqueMedia([...series, ...movies]).slice(0, 20),
            movies: uniqueMedia(movies).slice(0, 20),
            series: uniqueMedia(series).slice(0, 20),
            topRated: uniqueMedia([...movies, ...series])
              .filter((item) => (item.rating || 0) >= 7)
              .sort((a, b) => (b.rating || 0) - (a.rating || 0))
              .slice(0, 20),
          });
          setCatalogState('ready');
        }).catch((error) => {
          if (!active) return;
          setCatalogError(error instanceof Error ? error.message : 'IMDx could not be reached.');
          setCatalogState('error');
        });
        return () => { active = false; };
      }
      return;
    }
    let active = true;
    setCatalogState('loading');
    setCatalogError('');
    (async () => {
      // Each row can render as soon as it arrives; a slow endpoint must not
      // hold the entire home screen hostage.
      const rows = [
        ['trending', () => tmdbService.trending('all', 'week')],
        ['movies', () => tmdbService.catalog('popular', 'movie')],
        ['series', () => tmdbService.catalog('popular', 'tv')],
        ['topRated', () => tmdbService.catalog('top_rated', 'movie')],
      ] as const;
      let successes = 0;
      let lastError: unknown;
      await Promise.all(rows.map(async ([name, fetchRow]) => {
        try {
          const items = uniqueMedia(await fetchRow());
          if (!active) return;
          successes++;
          setCatalog((current) => {
            const next = { ...current, [name]: items };
            if (name === 'trending' || name === 'movies') {
              next.hero = uniqueMedia([...next.trending, ...next.movies]).filter((item) => item.backdrop).slice(0, 5);
            }
            writeHomeCache(window.localStorage, next);
            return next;
          });
          setCatalogState('ready');
        } catch (error) { lastError = error; }
      }));
      if (active && !successes) {
        setCatalogError(lastError instanceof Error ? lastError.message : 'TMDB could not be reached.');
        setCatalogState('error');
      }
    })();
    return () => { active = false; };
  }, [tmdbReady, imdxEnabled, imdxBaseUrl, imdxApiKey]);

  useEffect(() => {
    if (!profilePickerCompleted) return;
    return loadCatalog();
  }, [loadCatalog, profilePickerCompleted]);

  // Optional IMDx (Tiffara) spotlight row. Runs alongside TMDB — it never replaces it.
  useEffect(() => {
    if (!profilePickerCompleted || !imdxEnabled) {
      setImdxSpotlight([]);
      return;
    }
    let active = true;
    Promise.all([
      imdxService.list(settings.imdx, ['MOVIE']).catch(() => [] as MediaItem[]),
      imdxService.list(settings.imdx, ['TV_SERIES']).catch(() => [] as MediaItem[]),
    ]).then(([movies, series]) => {
      if (active) setImdxSpotlight(uniqueMedia([...movies, ...series]).slice(0, 20));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [profilePickerCompleted, imdxEnabled, imdxBaseUrl, imdxApiKey]);

  // Discover search & filtered TMDB /discover + Stremio catalogs
  useEffect(() => {
    if (!profilePickerCompleted || view !== 'discover') return;
    let active = true;
    // Any new search invalidates pages requested by an earlier "Load more".
    // Clear the pagination flag here too: the invalidated request's `finally`
    // deliberately skips its own reset (isCurrent() is false), so without this
    // `discoverLoadingMore` would stay true and block every future page load.
    discoverRequestRef.current += 1;
    setDiscoverLoadingMore(false);
    const timer = window.setTimeout(async () => {
      setDiscoverLoading(true);
      setDiscoverError('');
      setDiscoverPage(1);
      const term = query.trim();
      if (term) noteSearchTerm(term);
      try {
        if (term) {
          const imdxOn = imdxEnabled;
          const folkComics = ARCHIVE_COLLECTIONS.find((c) => c.id === 'folk-comics') || ARCHIVE_COLLECTIONS[0];
          const [tmdb, stremio, anime, imdx, musicTracks, bookHits] = await Promise.all([
            tmdbReady ? tmdbService.search(term, 1).catch(() => []) : Promise.resolve([]),
            searchStremioAddons(addons, term).catch(() => []),
            animeService.search(term, 1, 20).then((result) => result.items).catch(() => []),
            imdxOn ? imdxService.search(term, settings.imdx).catch(() => []) : Promise.resolve([]),
            // Universal search: also sweep the non-video tabs so one query
            // covers the whole app.
            OctaveMusicService.searchFull(term)
              .then((data) => data.tracks.slice(0, 6))
              .catch(() => [] as MusicTrack[]),
            BooksService.searchArchive(term, folkComics, 1, 8).catch(() => [] as BookItem[]),
          ]);
          if (active) {
            setDiscoverItems(uniqueMedia([...tmdb, ...imdx, ...anime, ...stremio]));
            setDiscoverHasMore(tmdb.length >= 16 || anime.length >= 20 || imdx.length >= 12);
            setDiscoverExtras({ music: musicTracks, books: bookHits });
          }
        } else if (discoverFilters.source === 'imdx' && imdxService.isEnabled(settings.imdx)) {
          const [movies, series] = await Promise.all([
            imdxService.list(settings.imdx, ['MOVIE']).catch(() => []),
            imdxService.list(settings.imdx, ['TV_SERIES']).catch(() => []),
          ]);
          if (active) {
            setDiscoverItems(uniqueMedia([...movies, ...series]));
            setDiscoverHasMore(false);
            setDiscoverExtras(null);
          }
        } else {
          const addonGenre = discoverFilters.genre !== 'all' ? discoverFilters.genre : undefined;
          const catalogJobs = discoverFilters.source !== 'tmdb'
            ? addons.filter((addon) => addon.enabled).flatMap((addon) =>
                addon.manifest.catalogs.filter((cat) => cat.id === 'top').slice(0, 2)
                  .map((cat) => fetchStremioCatalog(addon, cat, { genre: addonGenre }).catch(() => [])),
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
            setDiscoverExtras(null);
          }
        }
      } catch (error) {
        if (active) setDiscoverError(error instanceof Error ? error.message : 'Search failed.');
      } finally {
        if (active) setDiscoverLoading(false);
      }
    }, query ? 380 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [profilePickerCompleted, view, query, discoverFilters, addons, tmdbReady, imdxEnabled, imdxBaseUrl, imdxApiKey]);

  const loadMoreDiscover = useCallback(async () => {
    if (discoverLoadingMore || !discoverHasMore) return;
    const requestId = discoverRequestRef.current;
    const isCurrent = () => requestId === discoverRequestRef.current;
    const nextPage = discoverPage + 1;
    setDiscoverLoadingMore(true);
    try {
      const term = query.trim();
      if (term) {
        const [tmdb, anime] = await Promise.all([
          tmdbReady ? tmdbService.search(term, nextPage).catch(() => []) : Promise.resolve([]),
          animeService.search(term, nextPage, 20).then((result) => result.items).catch(() => []),
        ]);
        if (!isCurrent()) return;
        setDiscoverItems((prev) => uniqueMedia([...prev, ...tmdb, ...anime]));
        setDiscoverPage(nextPage);
        setDiscoverHasMore(tmdb.length >= 16 || anime.length >= 20);
      } else {
        const more = await tmdbService.discover(discoverFilters, nextPage);
        if (!isCurrent()) return;
        setDiscoverItems((prev) => uniqueMedia([...prev, ...more.items]));
        setDiscoverPage(nextPage);
        setDiscoverHasMore(more.hasMore);
      }
    } catch {
      if (isCurrent()) setDiscoverHasMore(false);
    } finally {
      if (isCurrent()) setDiscoverLoadingMore(false);
    }
  }, [tmdbReady, discoverLoadingMore, discoverHasMore, discoverPage, query, discoverFilters]);

  const activeSourceCount = useMemo(() =>
    addons.filter((addon) => addon.enabled).length +
    repositories.filter((repo) => repo.enabled).length,
  [addons, repositories]);

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
    const applyEnrichment = (enriched: MediaItem | null) => {
      if (enriched) setSelected((current) => (current?.id === item.id ? enriched : current));
    };
    const enrichWithImdx = (fallback?: MediaItem) => {
      if (!imdxService.isEnabled(settings.imdx)) return;
      imdxService.enrich(fallback || item, settings.imdx).then(applyEnrichment).catch(() => undefined);
    };

    if (item.source === 'anicore' || item.anime?.slug) {
      animeService.enrich(item)
        .then((enriched) => {
          applyEnrichment(enriched);
          if (!enriched.overview || !enriched.cast?.length) enrichWithImdx(enriched);
        })
        .catch(() => undefined);
      return;
    }
    if (item.source === 'imdx') {
      enrichWithImdx();
      return;
    }
    if (item.source === 'stremio' && item.addonUrl) {
      const addon = addons.find((entry) => entry.manifestUrl === item.addonUrl);
      if (addon) {
        fetchStremioMeta(addon, item)
          .then((metaItem) => (tmdbReady ? tmdbService.enrich(metaItem, settings.tmdbEnrichment).catch(() => metaItem) : metaItem))
          .then((enriched) => setSelected((current) => (current?.id === item.id ? enriched : current)))
          .catch(() => undefined);
        return;
      }
    }
    if (tmdbReady && (item.tmdbId || item.imdbId || item.id.startsWith('tt'))) {
      tmdbService.enrich(item, settings.tmdbEnrichment)
        .then((enriched) => {
          applyEnrichment(enriched);
          if (!enriched.cast?.length && !enriched.trailerKey) enrichWithImdx(enriched);
        })
        .catch(() => enrichWithImdx());
      return;
    }
    enrichWithImdx();
  };

  const openEmbeddedPlayers = (media: MediaItem, season?: number, episode?: number) => {
    const existing = history.find((entry) => entry.media.id === media.id);
    setSelected(null);
    setEmbedState({ media, season: season ?? existing?.season ?? 1, episode: episode ?? existing?.episode ?? 1 });
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
      // Placeholder-clip guard (port of Nuvio's WatchingPolicies): debrid and
      // scrape sources sometimes resolve to tiny sample/placeholder files —
      // never record meaningful progress for sub-2-minute "durations".
      const isPlaceholderClip = Boolean(duration && duration < 121);
      const progress = duration && duration > 0 && typeof currentTime === 'number' && !isPlaceholderClip
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
        queueMicrotask(() => {
          scrobbleWatchProgress(nextEntry, settings.sync).catch(() => undefined);
        });
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
      playbackPositionRef.current = entry.currentTime || 0;
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

  const playStream = (stream: StreamResult, season?: number, episode?: number, episodeTitle?: string, alternatives: StreamResult[] = []) => {
    if (!sourceState) return;
    const { media } = sourceState;
    const existing = history.find((entry) =>
      entry.media.id === media.id &&
      (media.type === 'movie' || (entry.season === season && entry.episode === episode)),
    );
    const resumeTime = existing && existing.progress < 95 ? (existing.currentTime || 0) : 0;

    upsertHistory({ media, stream, season, episode, episodeTitle });
    setSourceState(null);
    playbackPositionRef.current = resumeTime;
    setPlayer({ media, stream, season, episode, episodeTitle, initialTime: resumeTime, alternatives });
  };

  const playExplorerStream = (media: MediaItem, stream: StreamResult) => {
    const existing = history.find((entry) => entry.media.id === media.id);
    const resumeTime = existing && existing.progress < 95 ? (existing.currentTime || 0) : 0;
    upsertHistory({ media, stream });
    playbackPositionRef.current = resumeTime;
    setPlayer({ media, stream, initialTime: resumeTime });
  };

  const zapIptvChannel = useCallback((direction: 1 | -1) => {
    const channel = IptvZapStore.neighbor(direction);
    if (!channel) return;
    const { media, stream } = buildIptvPlayback(channel);
    setPlayer({ media, stream, initialTime: 0 });
  }, []);

  const handlePlayerProgress = useCallback((currentTime: number, duration: number) => {
    if (!player || (playerIdentityRef.current !== null && playerIdentityRef.current !== playerIdentity)) return;
    playbackPositionRef.current = currentTime;
    upsertHistory({
      media: player.media,
      stream: player.stream,
      season: player.season,
      episode: player.episode,
      episodeTitle: player.episodeTitle,
      currentTime,
      duration,
    });
  }, [player, playerIdentity, upsertHistory]);

  // Next-episode preload cache (port of Nuvio's PlayerNextEpisodeAutoPlay):
  // sources for the next episode are fetched before the card is tapped so the
  // switch is instant.
  const nextEpisodePreloadRef = useRef<{
    key: string;
    nextSeason: number;
    nextEp: number;
    nextTitle?: string;
    streams: StreamResult[];
  } | null>(null);

  const prepareNextEpisode = useCallback(async () => {
    if (!player || player.media.type !== 'series' || !player.season || !player.episode) return null;
    const key = `${player.media.id}:${player.season}:${player.episode}`;
    let nextSeason = player.season;
    let nextEp = player.episode + 1;
    let nextTitle: string | undefined;

    const animeSlug = player.media.anime?.slug
      || (player.media.source === 'anicore' ? player.media.id.slice('anicore:'.length) : '');

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
    } else if (animeSlug) {
      const animeEpisodes = await animeService.getEpisodes(animeSlug).catch(() => []);
      const seasonEps = animeEpisodes.filter((entry) => entry.season === player.season);
      if (seasonEps.length && nextEp > seasonEps.length) {
        nextSeason = player.season + 1;
        nextEp = 1;
      }
      const targetList = nextSeason === player.season
        ? seasonEps
        : animeEpisodes.filter((entry) => entry.season === nextSeason);
      nextTitle = targetList.find((e) => e.episode === nextEp)?.title;
    }

    const ids = await tmdbService.resolveIds(player.media).catch(() => ({
      tmdbId: player.media.tmdbId ? String(player.media.tmdbId) : undefined,
      imdbId: player.media.imdbId,
    }));
    const resolved = { ...player.media, imdbId: ids.imdbId || player.media.imdbId };
    const [stremio, nuvio] = await Promise.all([
      findStremioStreams(addons, resolved, nextSeason, nextEp),
      ids.tmdbId
        ? findNuvioStreams(repositories, ids.tmdbId, 'series', nextSeason, nextEp, nuvioSettings)
        : Promise.resolve({ streams: [], errors: [] }),
    ]);
    return { key, nextSeason, nextEp, nextTitle, streams: [...stremio.streams, ...nuvio.streams] };
  }, [player, tmdbReady, addons, repositories, nuvioSettings]);

  const preloadNextEpisode = useCallback(() => {
    if (!player || player.media.type !== 'series') return;
    const key = `${player.media.id}:${player.season || 0}:${player.episode || 0}`;
    if (nextEpisodePreloadRef.current?.key === key) return;
    void prepareNextEpisode().then((payload) => {
      if (payload && payload.streams.length) nextEpisodePreloadRef.current = payload;
    }).catch(() => undefined);
  }, [player, prepareNextEpisode]);

  const handleNextEpisode = useCallback(async () => {
    if (!player || player.media.type !== 'series' || !player.season || !player.episode) return;
    setNextEpisodeLoading(true);
    try {
      const preloadKey = `${player.media.id}:${player.season}:${player.episode}`;
      const preloaded = nextEpisodePreloadRef.current?.key === preloadKey ? nextEpisodePreloadRef.current : null;
      if (preloaded) {
        const preferred = preloaded.streams.find((s) => s.sourceName === player.stream.sourceName && !s.url.startsWith('magnet:'))
          || preloaded.streams.find((s) => !s.url.startsWith('magnet:'))
          || preloaded.streams[0];
        if (preferred) {
          nextEpisodePreloadRef.current = null;
          upsertHistory({ media: player.media, stream: preferred, season: preloaded.nextSeason, episode: preloaded.nextEp, episodeTitle: preloaded.nextTitle, currentTime: 0 });
          playbackPositionRef.current = 0;
          setPlayer({
            media: player.media,
            stream: preferred,
            season: preloaded.nextSeason,
            episode: preloaded.nextEp,
            episodeTitle: preloaded.nextTitle,
            initialTime: 0,
          });
          notify(`Playing S${preloaded.nextSeason} E${preloaded.nextEp}${preloaded.nextTitle ? ` — ${preloaded.nextTitle}` : ''}`, 'success');
          setNextEpisodeLoading(false);
          return;
        }
      }

      let nextSeason = player.season;
      let nextEp = player.episode + 1;
      let nextTitle: string | undefined;

      const animeSlug = player.media.anime?.slug
        || (player.media.source === 'anicore' ? player.media.id.slice('anicore:'.length) : '');

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
      } else if (animeSlug) {
        // Anime episode guides live in AniCore, so Up Next works without a TMDB key.
        const animeEpisodes = await animeService.getEpisodes(animeSlug).catch(() => []);
        const seasonEps = animeEpisodes.filter((entry) => entry.season === player.season);
        if (seasonEps.length && nextEp > seasonEps.length) {
          nextSeason = player.season + 1;
          nextEp = 1;
        }
        const targetList = nextSeason === player.season
          ? seasonEps
          : animeEpisodes.filter((entry) => entry.season === nextSeason);
        nextTitle = targetList.find((e) => e.episode === nextEp)?.title;
      }

      const ids = await tmdbService.resolveIds(player.media).catch(() => ({
        tmdbId: player.media.tmdbId ? String(player.media.tmdbId) : undefined,
        imdbId: player.media.imdbId,
      }));
      const resolved = { ...player.media, imdbId: ids.imdbId || player.media.imdbId };

      const [stremio, nuvio] = await Promise.all([
        findStremioStreams(addons, resolved, nextSeason, nextEp),
        ids.tmdbId
          ? findNuvioStreams(repositories, ids.tmdbId, 'series', nextSeason, nextEp, nuvioSettings)
          : Promise.resolve({ streams: [], errors: [] }),
      ]);

      const allStreams = [...stremio.streams, ...nuvio.streams];
      const preferred = allStreams.find((s) => s.sourceName === player.stream.sourceName && !s.url.startsWith('magnet:'))
        || allStreams.find((s) => !s.url.startsWith('magnet:'))
        || allStreams[0];

      if (preferred) {
        upsertHistory({ media: player.media, stream: preferred, season: nextSeason, episode: nextEp, episodeTitle: nextTitle, currentTime: 0 });
        playbackPositionRef.current = 0;
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
  }, [player, tmdbReady, addons, repositories, nuvioSettings, settings.tmdbApiKey, upsertHistory, notify]);

  // Profile management
  const createProfile = (
    name: string,
    avatarColor: string,
    isKids: boolean,
    avatarIcon?: ProfileAvatarIcon,
    avatarImage?: string,
  ) => {
    const id = `prof-${Date.now().toString(36)}`;
    const cleanImg = avatarImage?.trim() || undefined;
    const created: UserProfile = { id, name, avatarColor, avatarIcon, avatarImage: cleanImg, isKids, createdAt: Date.now() };
    setProfiles((cur) => [...cur, created]);
    if (!showProfileGate) {
      setActiveProfileId(id);
      notify(`Switched to ${name}.`, 'success');
    } else {
      notify(`Added profile ${name}.`, 'success');
    }
    return created;
  };

  const updateProfile = (
    profileId: string,
    patch: Partial<Pick<UserProfile, 'name' | 'avatarColor' | 'isKids' | 'avatarIcon' | 'avatarImage' | 'pinHash'>>,
  ) => {
    setProfiles((cur) => cur.map((prof) => (prof.id === profileId ? { ...prof, ...patch } : prof)));
    notify('Profile updated.', 'success');
  };

  const deleteProfile = (profileId: string) => {
    if (profileId === 'default') return;
    setProfiles((cur) => cur.filter((p) => p.id !== profileId));
    try {
      window.localStorage.removeItem(`praha.v2.profile.${profileId}.watchlist`);
      window.localStorage.removeItem(`praha.v2.profile.${profileId}.history`);
      window.localStorage.removeItem(`praha.v2.profile.${profileId}.home-rows`);
      window.localStorage.removeItem(`praha.v2.profile.${profileId}.preferred-source`);
    } catch { /* ignore */ }
    if (activeProfileId === profileId) setActiveProfileId('default');
    notify('Profile deleted.');
  };

  // Backup Export & Import
  const handleExportBackup = async () => {
    if (!window.confirm('This backup can contain API keys, tokens, addon URLs and scraper settings. Anyone with the file can read them. Export only to a trusted location. Continue?')) return;
    const profileData: PrahaBackupBundle['profileData'] = {};
    profiles.forEach((prof) => {
      const wKey = prof.id === 'default' ? 'praha.v2.watchlist' : `praha.v2.profile.${prof.id}.watchlist`;
      const hKey = prof.id === 'default' ? 'praha.v2.history' : `praha.v2.profile.${prof.id}.history`;
      try {
        profileData[prof.id] = {
          watchlist: JSON.parse(window.localStorage.getItem(wKey) || '[]'),
          history: JSON.parse(window.localStorage.getItem(hKey) || '[]'),
          homeRows: normalizeHomeRows(JSON.parse(window.localStorage.getItem(`praha.v2.profile.${prof.id}.home-rows`) || 'null')),
          preferredSource: JSON.parse(window.localStorage.getItem(`praha.v2.profile.${prof.id}.preferred-source`) || '""'),
        };
      } catch {
        profileData[prof.id] = { watchlist: [], history: [] };
      }
    });

    const bundle = createBackupBundle({
      settings,
      addons,
      repositories,
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
      if (!window.confirm('Restore this backup? It replaces local settings, sources and profile data. Only import a file you trust; it may contain executable scraper code and credentials.')) return;
      setSettings(normalizeSettings(restored.settings));
      setAddons(restored.addons);
      setRepositories(restored.repositories);
      setNuvioSettings(restored.nuvioSettings || {});
      setProfiles(restored.profiles);

      Object.entries(restored.profileData).forEach(([profId, data]) => {
        const wKey = profId === 'default' ? 'praha.v2.watchlist' : `praha.v2.profile.${profId}.watchlist`;
        const hKey = profId === 'default' ? 'praha.v2.history' : `praha.v2.profile.${profId}.history`;
        window.localStorage.setItem(wKey, JSON.stringify(data.watchlist || []));
        window.localStorage.setItem(hKey, JSON.stringify(data.history || []));
        if (data.homeRows) window.localStorage.setItem(`praha.v2.profile.${profId}.home-rows`, JSON.stringify(normalizeHomeRows(data.homeRows)));
        if (typeof data.preferredSource === 'string') window.localStorage.setItem(`praha.v2.profile.${profId}.preferred-source`, JSON.stringify(data.preferredSource));
      });

      setActiveProfileId(restored.activeProfileId);
      const currentProfData = restored.profileData[restored.activeProfileId];
      if (currentProfData && restored.activeProfileId === activeProfile.id) {
        if (currentProfData.homeRows) setHomeRows(normalizeHomeRows(currentProfData.homeRows));
        if (typeof currentProfData.preferredSource === 'string') setPreferredSource(currentProfData.preferredSource);
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
        jellyfinSnapshot={jellyfinSnapshot?.profileId === activeProfile.id ? jellyfinSnapshot : null}
        loading={catalogState === 'loading'}
        error={catalogError}
        tmdbReady={tmdbReady}
        history={history}
        watchlist={watchlist}
        addons={addons}
        repositories={repositories}
        onSelect={openDetails}
        onPlay={(item) => openSources(item)}
        onEmbeddedPlayers={openEmbeddedPlayers}
            onOpenPerson={(personId, personName) => setPersonModal({ id: personId, name: personName })}
        onResumeEntry={resumeWatchEntry}
        onRemoveHistory={removeHistoryEntry}
        onToggleWatchlist={(item) => toggleWatchlist(item)}
        onOpenExtensions={() => navigate('extensions')}
        onOpenLibrary={() => navigate('library')}
        onOpenSettings={() => navigate('settings')}
        onRetry={loadCatalog}
        compact={settings.compactCards}
        homeRows={homeRows}
        onHomeRowsChange={setHomeRows}
        imdxSpotlight={imdxSpotlight}
        imdxEnabled={imdxEnabled}
      />
    );
  } else if (view === 'anime') {
    page = (
      <AnimeView
        query={query}
        watchlist={watchlist}
        compact={settings.compactCards}
        imdx={settings.imdx}
        onSelect={openDetails}
        onPlay={(item) => openSources(item)}
        onEmbeddedPlayers={openEmbeddedPlayers}
        onToggleWatchlist={(item) => toggleWatchlist(item)}
        onOpenSettings={() => navigate('settings')}
        onClearSearch={() => setQuery('')}
      />
    );
  } else if (view === 'sanka') {
    page = (
      <SankaExplorer
        prefillQuery={searchPrefill?.view === 'sanka' ? searchPrefill.term : undefined}
      />
    );
  } else if (view === 'livetv') {
    page = (
      <LiveTvView
        onPlayStream={(media, stream) => {
          setPlayer({ media, stream, initialTime: 0 });
        }}
      />
    );
  } else if (view === 'audiobooks') {
    page = <AudiobooksView />;
  } else if (view === 'books') {
    page = (
      <BooksView
        compact={settings.compactCards}
        prefillQuery={searchPrefill?.view === 'books' ? searchPrefill.term : undefined}
      />
    );
  } else if (view === 'music') {
    page = (
      <MusicView
        prefillQuery={searchPrefill?.view === 'music' ? searchPrefill.term : undefined}
      />
    );
  } else if (view === 'flow') {
    page = (
      <FlowView
        onPlay={playExplorerStream}
        onEmbed={openEmbeddedPlayers}
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
        imdxEnabled={imdxEnabled}
        onSelect={openDetails}
        onToggleWatchlist={(item) => toggleWatchlist(item)}
        onClearSearch={() => setQuery('')}
        onOpenSettings={() => navigate('settings')}
        compact={settings.compactCards}
        musicResults={discoverExtras?.music}
        bookResults={discoverExtras?.books}
        onOpenInTab={(target) => {
          setSearchPrefill({ view: target, term: query.trim() });
          navigate(target);
        }}
        onPrefillSearch={(term) => setQuery(term)}
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
  } else if (view === 'extensions') {
    page = (
      <ExtensionsView
        addons={addons}
        repositories={repositories}
        nuvioSettings={nuvioSettings}
        setAddons={setAddons}
        setRepositories={setRepositories}
        setNuvioSettings={setNuvioSettings}
        notify={notify}
      />
    );
  } else {
    page = (
      <SettingsView
        settings={settings}
        jellyfinSnapshot={jellyfinSnapshot?.profileId === activeProfile.id ? jellyfinSnapshot : null}
        onJellyfinSnapshotChange={(snapshot) => setJellyfinSnapshot(snapshot ? { ...snapshot, profileId: activeProfile.id } : null)}
        onChange={setSettings}
        onReset={() => {
          setSettings({ ...DEFAULT_SETTINGS, tmdbApiKey: settings.tmdbApiKey || '' });
          notify('Preferences reset. Your TMDB API key was kept.', 'success');
        }}
        addons={addons}
        repositories={repositories}
        profiles={profiles}
        activeProfile={activeProfile}
        onSelectProfile={(id) => {
          const target = profiles.find((p) => p.id === id);
          if (target?.pinHash) {
            setPinGateProfile(target);
            return;
          }
          setActiveProfileId(id);
          if (target) notify(`Switched to ${target.name}.`, 'success');
        }}
        onCreateProfile={createProfile}
        onDeleteProfile={deleteProfile}
        onUpdateProfile={updateProfile}
        onOpenProfilePicker={() => setProfileSwitcherOpen(true)}
        onExportBackup={handleExportBackup}
        onImportBackup={handleImportBackup}
        onCheckUpdates={manualCheckUpdates}
      />
    );
  }

  const handleCompleteProfileGate = (profileId: string) => {
    const wasSwitching = profileSwitcherOpen && profileId !== activeProfile.id;
    setActiveProfileId(profileId);
    try {
      window.sessionStorage.setItem(SESSION_PROFILE_KEY, profileId);
      window.localStorage.setItem('praha.v2.profile-picker-completed', 'true');
    } catch { /* ignore */ }
    setSessionProfilePicked(true);
    setProfileSwitcherOpen(false);
    if (wasSwitching) {
      const target = profiles.find((p) => p.id === profileId);
      if (target) notify(`Switched to ${target.name}.`, 'success');
    }
  };

  return (
    <MusicPlayerProvider>
      {/* Main app navigation and pages — completely hidden when player is active to prevent transparency bleed and ghost clicks */}
      {profilePickerCompleted && (
        <div
          className={`app-navigation-container ${player ? 'player-active-hidden' : ''}`}
          style={player ? { display: 'none' } : undefined}
          aria-hidden={Boolean(player)}
        >
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
              try { window.sessionStorage.setItem(SESSION_PROFILE_KEY, id); } catch { /* ignore */ }
              const target = profiles.find((p) => p.id === id);
              if (target) notify(`Switched to ${target.name}.`, 'success');
            }}
            onOpenProfilePicker={() => setProfileSwitcherOpen(true)}
          >
            {page}
          </Navigation>
        </div>
      )}

      {showProfileGate && (
        <ProfilePicker
          profiles={profiles.length ? profiles : [DEFAULT_PROFILE]}
          activeProfile={activeProfile}
          onContinue={handleCompleteProfileGate}
          onCreateProfile={createProfile}
          onUpdateProfile={updateProfile}
          onDeleteProfile={deleteProfile}
          canDismiss={profileSwitcherOpen && profilePickerCompleted}
          onDismiss={() => setProfileSwitcherOpen(false)}
        />
      )}

      {selected && !player && (
        <DetailsModal
          item={selected}
          tmdbEpisodesEnabled={settings.tmdbEnrichment.enabled && settings.tmdbEnrichment.episodes}
          watchlist={watchlist}
          history={history}
          onClose={() => setSelected(null)}
          onPlay={openSources}
          onEmbeddedPlayers={openEmbeddedPlayers}
          onSelectRecommendation={openDetails}
          onToggleWatchlist={toggleWatchlist}
          onUpdateStatus={updateWatchlistStatus}
          inWatchlist={watchlist.some((item) => item.id === selected.id)}
        />
      )}

      {embedState && !player && <EmbedModal media={embedState.media} initialSeason={embedState.season} initialEpisode={embedState.episode} onClose={() => setEmbedState(null)} />}

      {sourceState && !player && (
        <SourceModal
          media={sourceState.media}
          initialSeason={sourceState.season}
          initialEpisode={sourceState.episode}
          addons={addons}
          repositories={repositories}
          nuvioSettings={nuvioSettings}
          tmdbApiKey={settings.tmdbApiKey}
          preferredLanguage={settings.preferredLanguage}
          preferredSource={preferredSource}
          onPreferredSourceChange={setPreferredSource}
          onClose={() => setSourceState(null)}
          onOpenExtensions={() => { setSourceState(null); navigate('extensions'); }}
          onPlay={playStream}
        />
      )}

      {player && (
        <React.Suspense fallback={<div className="player-backdrop"><div className="player-loading"><span className="brand-mark"><span /></span><p>Preparing your stream…</p></div></div>}>
          <PlayerModal
            key={playerIdentity || undefined}
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
            onZapChannel={zapIptvChannel}
            onTryAnother={player.alternatives?.length ? () => {
              const [next, ...remaining] = player.alternatives!;
              setPlayer({ ...player, stream: next, alternatives: remaining, initialTime: playbackPositionRef.current });
              upsertHistory({ media: player.media, stream: next, season: player.season, episode: player.episode, episodeTitle: player.episodeTitle, currentTime: playbackPositionRef.current });
              notify(`Trying ${next.sourceName}…`);
            } : undefined}
            onFindSources={() => {
              const { media, season, episode, episodeTitle } = player;
              closePlayer();
              openSources(media, season, episode, episodeTitle);
            }}
            onProgress={handlePlayerProgress}
            onNextEpisode={player.media.type === 'series' && player.season && player.episode ? handleNextEpisode : undefined}
            onPreloadNextEpisode={player.media.type === 'series' ? preloadNextEpisode : undefined}
            nextEpisodeLoading={nextEpisodeLoading}
            onOpenSettings={() => navigate('settings')}
            onClose={closePlayer}
          />
        </React.Suspense>
      )}

      {availableUpdate && (
        <UpdateModal
          update={availableUpdate}
          onClose={() => setAvailableUpdate(null)}
        />
      )}

      {personModal && (
        <PersonModal
          personId={personModal.id}
          name={personModal.name}
          onClose={() => setPersonModal(null)}
          onSelect={(item) => { setPersonModal(null); openDetails(item); }}
          watchlist={watchlist}
          onToggleWatchlist={(item) => toggleWatchlist(item)}
          compact={settings.compactCards}
        />
      )}

      {pinGateProfile && (
        <ProfilePinGate
          profile={pinGateProfile}
          onUnlocked={() => {
            setActiveProfileId(pinGateProfile.id);
            notify(`Switched to ${pinGateProfile.name}.`, 'success');
            setPinGateProfile(null);
          }}
          onCancel={() => setPinGateProfile(null)}
        />
      )}

      {toast && (
        <div className={`toast toast-${toast.tone}`} role="status">
          {toast.tone === 'success' ? <CheckCircle2 size={18} /> : toast.tone === 'error' ? <CircleAlert size={18} /> : <Info size={18} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss notification"><X size={15} /></button>
        </div>
      )}

      {/* Persistent SimpMusic-style player: mini bar on every tab (hidden inside
          the Music tab, which has its own layout, and under the video player),
          expandable into the full Now Playing sheet. */}
      <MusicPlayerBar hidden={view === 'music' || Boolean(player)} />
      <NowPlayingSheet />
    </MusicPlayerProvider>
  );
};

export default App;
