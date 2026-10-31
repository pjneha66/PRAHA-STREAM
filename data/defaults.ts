import type { AppSettings, DiscoverFilters, HomeCatalog, InstalledAddon, PlayerSettings, UserProfile } from '../types';

/** Empty starting point for the TMDB-driven home screen. */
export const EMPTY_HOME_CATALOG: HomeCatalog = { hero: [], trending: [], movies: [], series: [], topRated: [] };

/**
 * PRAHA ships no catalog of its own. Every title on the home screen, in
 * discover, and in search comes from TMDB (metadata) and the sources you
 * install (streams). The only default below is the Cinemeta metadata addon.
 */
export const CINEMETA_ADDON: InstalledAddon = {
  manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json',
  enabled: true,
  installedAt: Date.now(),
  updatedAt: Date.now(),
  manifest: {
    id: 'org.stremio.cinemeta',
    name: 'Cinemeta',
    description: 'Metadata and catalogs for movies and series.',
    version: '3.0.0',
    logo: 'https://www.stremio.com/website/stremio-logo-small.png',
    types: ['movie', 'series'],
    resources: [
      { name: 'catalog', types: ['movie', 'series'] },
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] },
    ],
    catalogs: [
      { type: 'movie', id: 'top', name: 'Popular movies', extra: [{ name: 'genre' }, { name: 'skip' }, { name: 'search' }] },
      { type: 'series', id: 'top', name: 'Popular series', extra: [{ name: 'genre' }, { name: 'skip' }, { name: 'search' }] },
    ],
  },
};

export const DEFAULT_PROFILE: UserProfile = {
  id: 'default',
  name: 'Main Profile',
  avatarColor: '#d6f77a',
  isKids: false,
  createdAt: Date.now(),
};

export const DEFAULT_DISCOVER_FILTERS: DiscoverFilters = {
  type: 'all',
  source: 'all',
  genre: 'all',
  year: 'all',
  minRating: 0,
  sortBy: 'popularity.desc',
  language: 'all',
};

/** mpvRx-style player defaults. Everything is user-adjustable in Settings → Player. */
export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  theme: 'mpvrx',
  seekStep: 10,
  oscTimeout: 2600,
  subtitleSize: 100,
  subtitleColor: '#ffffff',
  subtitleOffset: 0,
  subtitleBgOpacity: 55,
  stats: false,
  gestures: true,
  volume: 100,
  speed: 1,
  brightness: 100,
  autoNextEpisode: true,
  landscapeLock: true,
  skipIntro: true,
};

export const DEFAULT_SETTINGS: AppSettings = {
  autoplay: true,
  compactCards: false,
  reduceMotion: false,
  preferredLanguage: 'en',
  accent: 'lime',
  tmdbApiKey: '',
  cloudstreamServerUrl: '',
  debrid: {
    provider: 'none',
    apiKey: '',
  },
  sync: {
    traktClientId: '',
    traktToken: '',
    simklClientId: '',
    simklToken: '',
  },
  dpadNavigation: false,
  preferNativeProxy: true,
  player: DEFAULT_PLAYER_SETTINGS,
};

/** Ensure older saved settings smoothly merge new defaults. */
export function normalizeSettings(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const base = raw || {};
  return {
    ...DEFAULT_SETTINGS,
    ...base,
    debrid: {
      ...DEFAULT_SETTINGS.debrid,
      ...(base.debrid || {}),
    },
    sync: {
      ...DEFAULT_SETTINGS.sync,
      ...(base.sync || {}),
    },
    player: {
      ...DEFAULT_PLAYER_SETTINGS,
      ...(base.player || {}),
    },
  };
}
