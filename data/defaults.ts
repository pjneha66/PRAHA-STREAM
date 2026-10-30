import type { AppSettings, HomeCatalog, InstalledAddon, PlayerSettings } from '../types';

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

/** mpvRx-style player defaults. Everything is user-adjustable in Settings → Player. */
export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  theme: 'mpvrx',
  seekStep: 10,
  oscTimeout: 2600,
  subtitleSize: 100,
  subtitleColor: '#ffffff',
  stats: false,
  gestures: true,
  volume: 100,
  speed: 1,
  brightness: 100,
};

export const DEFAULT_SETTINGS: AppSettings = {
  autoplay: true,
  compactCards: false,
  reduceMotion: false,
  preferredLanguage: 'en',
  accent: 'lime',
  tmdbApiKey: '',
  player: DEFAULT_PLAYER_SETTINGS,
};
