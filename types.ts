export type MediaType = 'movie' | 'series';
export type AppView = 'home' | 'discover' | 'library' | 'explore' | 'cloudstream' | 'extensions' | 'settings';

export type LibraryStatus = 'watching' | 'plan' | 'hold' | 'dropped' | 'completed';

export interface MediaCastMember {
  id: number;
  name: string;
  character?: string;
  job?: string;
  profile?: string;
}

export interface TmdbSeasonSummary {
  id: number;
  seasonNumber: number;
  name: string;
  episodeCount: number;
  poster?: string;
  airDate?: string;
  overview?: string;
}

export interface TmdbEpisodeInfo {
  id: number;
  season: number;
  episode: number;
  title: string;
  overview: string;
  still?: string;
  airDate?: string;
  runtime?: number;
  rating?: number;
}

/** Home screen rows. Every entry is loaded from TMDB at runtime — nothing is bundled. */
export interface HomeCatalog {
  hero: MediaItem[];
  trending: MediaItem[];
  movies: MediaItem[];
  series: MediaItem[];
  topRated: MediaItem[];
}

export interface MediaItem {
  id: string;
  tmdbId?: number;
  imdbId?: string;
  type: MediaType;
  title: string;
  overview: string;
  poster: string;
  backdrop?: string;
  logo?: string;
  year?: string;
  rating?: number;
  genres: string[];
  runtime?: string;
  maturity?: string;
  source: 'tmdb' | 'stremio' | 'nuvio' | 'cloudstream';
  addonUrl?: string;
  providerId?: string;
  providerMediaId?: string;
  /** Enriched TMDB details */
  trailerKey?: string;
  trailerName?: string;
  director?: string;
  cast?: MediaCastMember[];
  recommendations?: MediaItem[];
  seasons?: TmdbSeasonSummary[];
  numberOfSeasons?: number;
  libraryStatus?: LibraryStatus;
}

export interface WatchProgress {
  media: MediaItem;
  progress: number;
  currentTime?: number;
  duration?: number;
  watchedAt: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  lastStream?: StreamResult;
}

export interface UserProfile {
  id: string;
  name: string;
  avatarColor: string;
  isKids?: boolean;
  createdAt: number;
}

export interface StremioResource {
  name: 'catalog' | 'meta' | 'stream' | 'subtitles' | 'addon_catalog' | string;
  types: string[];
  idPrefixes?: string[];
}

export interface StremioCatalog {
  type: string;
  id: string;
  name?: string;
  extra?: Array<{
    name: string;
    isRequired?: boolean;
    options?: string[];
    optionsLimit?: number;
  }>;
}

export interface StremioManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  logo?: string;
  resources: StremioResource[];
  types: string[];
  idPrefixes?: string[];
  catalogs: StremioCatalog[];
  behaviorHints?: {
    configurable?: boolean;
    configurationRequired?: boolean;
    adult?: boolean;
    p2p?: boolean;
  };
}

export interface InstalledAddon {
  manifestUrl: string;
  manifest: StremioManifest;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
}

export interface NuvioSettingField {
  key: string;
  label?: string;
  name?: string;
  type?: 'text' | 'password' | 'boolean' | 'toggle' | 'select' | 'number' | string;
  default?: unknown;
  defaultValue?: unknown;
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string } | string>;
}

export interface NuvioManifestScraper {
  id: string;
  name: string;
  description?: string;
  version: string;
  filename: string;
  supportedTypes?: string[];
  enabled?: boolean;
  hasSettings?: boolean;
  logo?: string;
  contentLanguage?: string[];
  supportedPlatforms?: string[];
  disabledPlatforms?: string[];
  formats?: string[];
  supportedFormats?: string[];
  supportsExternalPlayer?: boolean;
  limited?: boolean;
}

export interface NuvioScraper extends NuvioManifestScraper {
  id: string;
  repositoryUrl: string;
  enabled: boolean;
  manifestEnabled: boolean;
  supportedTypes: string[];
  code: string;
}

export interface NuvioRepository {
  manifestUrl: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  enabled: boolean;
  scrapers: NuvioScraper[];
  installedAt: number;
  updatedAt: number;
}

export interface StreamSubtitle {
  id?: string;
  url: string;
  language: string;
  name?: string;
  headers?: Record<string, string>;
}

export interface StreamResult {
  id: string;
  title: string;
  url: string;
  sourceName: string;
  sourceType: 'stremio' | 'nuvio' | 'cloudstream';
  quality?: string;
  size?: string;
  language?: string;
  provider?: string;
  seeders?: number;
  peers?: number;
  infoHash?: string;
  fileIdx?: number;
  headers?: Record<string, string>;
  referer?: string;
  format?: string;
  subtitles?: StreamSubtitle[];
  externalUrl?: string;
  ytId?: string;
  behaviorHints?: Record<string, unknown>;
}

export interface SourceError {
  sourceName: string;
  message: string;
}

export type SourceKind = 'stremio' | 'nuvio' | 'cloudstream';

export interface CloudStreamPluginEntry {
  name: string;
  version?: number | string;
  url?: string;
  iconUrl?: string;
  description?: string;
  apiVersion?: number;
  repositoryUrl?: string;
  fileSize?: number;
  status?: number;
  language?: string;
  authors?: string[];
  tvTypes?: string[];
  enabled?: boolean;
}

export interface CloudStreamProvider extends CloudStreamPluginEntry {
  id: string;
  repositoryId: string;
  enabled: boolean;
  manifestEnabled: boolean;
  supportedTypes: string[];
  installedAt: number;
  /** Fetched JavaScript source for extensions that can run in the browser. */
  code?: string;
  /** True when the extension is a compiled .cs3 package that needs the native app. */
  nativeOnly?: boolean;
}

export interface CloudStreamRepository {
  manifestUrl: string;
  name: string;
  description?: string;
  manifestVersion?: number;
  pluginListUrls: string[];
  enabled: boolean;
  providers: CloudStreamProvider[];
  installedAt: number;
  updatedAt: number;
}

export interface IntroSegment {
  start: number;
  end: number;
  label: 'Skip Intro' | 'Skip Outro' | 'Skip Recap';
}

export type DebridProvider = 'none' | 'realdebrid' | 'alldebrid' | 'torbox';

export interface DebridSettings {
  provider: DebridProvider;
  apiKey: string;
}

export interface SyncSettings {
  traktClientId?: string;
  traktToken?: string;
  simklClientId?: string;
  simklToken?: string;
}

export interface DiscoverFilters {
  type: 'all' | MediaType;
  source: 'all' | 'tmdb' | 'stremio';
  genre: string;
  year: string;
  minRating: number;
  sortBy: 'popularity.desc' | 'vote_average.desc' | 'primary_release_date.desc' | 'revenue.desc';
  language: string;
}

export type PlayerThemeId =
  | 'mpvrx' | 'amoled' | 'catppuccin' | 'nord' | 'tokyo' | 'dracula' | 'gruvbox' | 'rosepine';

/** Settings for the built-in mpvRx-style player. Persisted with the rest of the app. */
export interface PlayerSettings {
  /** Color scheme for the on-screen controller, inspired by mpvRx themes. */
  theme: PlayerThemeId;
  /** Seconds used by ←/→ and the back/forward buttons. */
  seekStep: number;
  /** Milliseconds before the controller hides itself. 0 keeps it visible. */
  oscTimeout: number;
  /** Subtitle font size as a percentage of the browser default. */
  subtitleSize: number;
  /** Subtitle text color. */
  subtitleColor: string;
  /** Subtitle timing offset in seconds (e.g. -0.5 or +1.0). */
  subtitleOffset: number;
  /** Subtitle background opacity (0 - 100). */
  subtitleBgOpacity: number;
  /** Show the mpv-style statistics overlay on startup. */
  stats: boolean;
  /** Enable touch gestures (double-tap seek, swipe volume/brightness, long-press speed). */
  gestures: boolean;
  /** Volume in percent, restored for the next session. */
  volume: number;
  /** Playback speed multiplier. */
  speed: number;
  /** Brightness in percent, applied as a CSS filter. */
  brightness: number;
  /** Automatically queue and prompt next episode for series. */
  autoNextEpisode: boolean;
  /** Lock screen orientation to landscape in fullscreen on Android. */
  landscapeLock: boolean;
  /** Show Skip Intro / Skip Outro button when segment timestamps are detected. */
  skipIntro: boolean;
}

export interface AppSettings {
  autoplay: boolean;
  compactCards: boolean;
  reduceMotion: boolean;
  preferredLanguage: string;
  accent: 'lime' | 'violet' | 'blue';
  tmdbApiKey: string;
  /** Optional CloudStream plugin server that executes native .cs3 providers. */
  cloudstreamServerUrl: string;
  /** Debrid service used to convert magnets/infoHashes into direct HTTP streams. */
  debrid: DebridSettings;
  /** Optional Trakt / Simkl scrobbling credentials. */
  sync: SyncSettings;
  /** Enhanced D-Pad / Android TV spatial remote navigation. */
  dpadNavigation: boolean;
  /** Route header-protected streams through native Android proxy when running in APK. */
  preferNativeProxy: boolean;
  player: PlayerSettings;
}

export interface PrahaBackupBundle {
  app: 'praha-stream';
  version: number;
  exportedAt: number;
  settings: Partial<AppSettings>;
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  cloudstreamRepositories: CloudStreamRepository[];
  nuvioSettings?: Record<string, Record<string, unknown>>;
  profiles: UserProfile[];
  activeProfileId: string;
  profileData: Record<string, {
    watchlist: MediaItem[];
    history: WatchProgress[];
  }>;
}

export interface ToastMessage {
  id: number;
  message: string;
  tone?: 'default' | 'success' | 'error';
}
