import type { HikiTitle } from './services/hikariExtensions';
import type { RuleScraperTitle } from './services/ruleScraper';
export const APP_VERSION = '2.11.42';

export type MediaType = 'movie' | 'series';
export type AppView = 'home' | 'anime' | 'sanka' | 'manga' | 'livetv' | 'audiobooks' | 'music' | 'video-downloads' | 'dubbing' | 'telegram' | 'books' | 'novels' | 'discover' | 'flow' | 'library' | 'explore' | 'collections' | 'cloudstream' | 'extensions' | 'calendar' | 'settings';

export type LibraryStatus = 'watching' | 'plan' | 'hold' | 'dropped' | 'completed';

/**
 * Adult content shown across manga, comics, anime and the TMDB catalog.
 * `off` hides it, `on` mixes it into normal results, `only` shows nothing else.
 * A Kids profile is always `off` regardless of what is saved here.
 */
export type NsfwMode = 'off' | 'on' | 'only';

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
  title: string;
  episode: number;
  overview: string;
  still?: string;
  airDate?: string;
  runtime?: number;
  rating?: number;
}

/**
 * One video of an addon title: an episode, or — in a collection — one of its
 * films. A port of VyseTV's `AddonVideo` (`lib/data/catalog/meta_addons.dart`,
 * GPL-3.0-or-later). `id` is the id the stream addons are asked by
 * (`tt0944947:1:1`, `kitsu:7442:1`), so it travels with the title.
 */
export interface AddonVideo {
  id: string;
  /** 0 for a run with no seasons, numbered straight through. */
  season: number;
  episode: number;
  name: string;
  overview: string;
  thumbnail?: string;
  poster?: string;
  released?: string;
  runtime?: number;
  /** Where IMDb counts it, when the addon says so (Kitsu does). */
  imdbSeason?: number;
  imdbEpisode?: number;
  tmdbId?: number;
  /** Streams the addon put inside the video itself (Stremio's `streams`). */
  inline: Array<Record<string, unknown>>;
}

/** Home screen rows. Every entry is loaded from TMDB at runtime — nothing is bundled. */
export interface HomeCatalog {
  hero: MediaItem[];
  trending: MediaItem[];
  movies: MediaItem[];
  series: MediaItem[];
  topRated: MediaItem[];
}

/** Cross-database anime identifiers resolved by AniCore / Anikura. */
export interface AnimeReference {
  alternatePoster?: string;
  /** AniCore catalog slug (used for detail + episode endpoints). */
  slug: string;
  anicoreId?: number;
  malId?: number;
  anilistId?: number;
  kitsuId?: number;
  tvdbId?: number;
  /** Anikura's own catalog id, when the title is carried there. */
  anikuraId?: number;
  format?: string;
  status?: string;
  season?: string;
  seasonYear?: number;
  episodeCount?: number;
  studios?: string[];
  /** Metadata providers that contributed to this record (kitsu, tvdb, tmdb, anilist, mal). */
  sources?: string[];
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
  source: 'tmdb' | 'stremio' | 'nuvio' | 'anicore' | 'imdx' | 'youtube' | 'iptv' | 'cloudstream'
    | 'sora' | 'skystream' | 'zangetsu' | 'anymex' | 'telegram' | 'hikari' | 'rule-scraper' | 'calendar';
  /** Present when the title was resolved through AniCore / Anikura. */
  anime?: AnimeReference;
  addonUrl?: string;
  /**
   * The addon's own word for this title's kind (`movie`, `series`, `anime`,
   * `channel`, `tv`, `other`). PRAHA's `type` is only movie/series, but addons
   * are asked and matched by their own word — a Kitsu title is `anime`, and an
   * addon declaring `types: ['anime']` cannot be asked for a "series".
   */
  addonType?: string;
  providerId?: string;
  providerMediaId?: string;
  /**
   * Set when the title came from a CloudStream extension. Sources for it are
   * resolved by asking that extension for links, so the provider name and the
   * playable list travel with the item rather than being looked up again.
   */
  hikari?: HikiTitle;
  /** Present when the title came from a JSON-rule scraper source. */
  ruleScraper?: RuleScraperTitle;
  cloudstreamApiName?: string;
  cloudstreamUrl?: string;
  cloudstreamPlayables?: CloudStreamPlayable[];
  /** Enriched TMDB details */
  trailerKey?: string;
  trailerName?: string;
  director?: string;
  cast?: MediaCastMember[];
  recommendations?: MediaItem[];
  seasons?: TmdbSeasonSummary[];
  numberOfSeasons?: number;
  libraryStatus?: LibraryStatus;
  networks?: string[];
  status?: string;
  originCountry?: string;
  originalLanguage?: string;
  /**
   * The episodes a metadata addon gave for this title, when it did. Present
   * means the addon's own list is the truth for this title — its ids are what
   * the stream addons are asked by, and an addon that counts episodes its own
   * way (Kitsu) would be asked for the wrong one if TMDB's numbering were used.
   */
  addonVideos?: AddonVideo[];
  /**
   * A collection's films (TMDB Collections, and any addon that lists a set of
   * films as one entry), each a title of its own. A non-empty list means this
   * item is a collection: it has no streams of its own, and playing it plays
   * its first unwatched film (VyseTV's `partToPlay`).
   */
  addonParts?: MediaItem[];
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

export type ProfileAvatarIcon = 'classic' | 'cool' | 'wink' | 'joy' | 'hero' | 'kids';

export interface UserProfile {
  id: string;
  name: string;
  avatarColor: string;
  avatarIcon?: ProfileAvatarIcon;
  avatarImage?: string;
  isKids?: boolean;
  createdAt: number;
  /** SHA-256 hex of a 4-8 digit PIN (port of Nuvio's ProfilePinCrypto). */
  pinHash?: string;
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
  /** User-assigned display name (port of Nuvio's ManagedAddon rename). */
  renamedTitle?: string;
  /** Per-feature switches (port of PlayTorrio's per-addon checkboxes). */
  features?: { catalog?: boolean; search?: boolean; streams?: boolean };
  /**
   * This entry is not an addon but a plugin repository answering as one
   * (VyseTV's `Addon.plugins`): its titles are `pl:`-prefixed ids its plugins
   * find, and its catalogs are pages asked of those plugins rather than URLs.
   */
  plugins?: boolean;
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

/**
 * A JavaScript plugin repository (VyseTV's `repo.json`, scraper list, or Vega
 * manifest). Unlike a Nuvio repository, whose scrapers ship with their code
 * inline, a plugin's script is fetched at run time — so a change to `version` is
 * what makes the app download it again.
 */
export interface PluginRepository {
  /** The link the user pasted, normalised. */
  url: string;
  name: string;
  /** Which of the three shapes it was. */
  kind: 'repo' | 'scrapers' | 'vega';
  enabled: boolean;
  plugins: PluginRepositoryEntry[];
  installedAt: number;
  updatedAt: number;
  /**
   * Which plugins' catalogs are rows on Home and results in Discover, by plugin
   * id — VyseTV's `Addon.browse`. Absent means "not picked yet": a scraper
   * list's that list titles, none of a Vega provider's (a repository of them can
   * list hundreds). Its titles' details stay on a plugin switched off here.
   */
  browse?: string[];
}

export interface PluginRepositoryEntry {
  id: string;
  name: string;
  /** The script URL, or for a Vega provider the `dist/<value>` folder. */
  url: string;
  version: string;
  note: string;
  types: string[];
  scraper: boolean;
  vega: boolean;
  /** Off keeps the plugin listed but never asked. */
  enabled: boolean;
  /** The lists of titles it offers to browse; a Vega provider's are read at install. */
  catalogs?: PluginCatalog[];
  /** It gives a title's own details (else they come from TMDB, or the catalog's copy). */
  details?: boolean;
  /**
   * It lists comics, not films and shows: its catalogs belong to the manga
   * section, and it is never asked for a video's streams (VyseTV's `comic`).
   */
  comic?: boolean;
}

/**
 * One list of titles a plugin offers (VyseTV's `PluginCatalog`): its type in the
 * plugin's own word ("tv" is a show), what a Vega provider's posts are asked for,
 * and whether it takes a search or a genre.
 */
export interface PluginCatalog {
  id: string;
  name: string;
  type: string;
  filter?: string;
  genres?: string[];
  search?: boolean;
  searchOnly?: boolean;
  genreRequired?: boolean;
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

/**
 * A CloudStream extension repository (a `repo.json` / `plugins.json` pair). Managed
 * natively: the .cs3 packages are Dalvik bytecode and can only be installed and run
 * by the Android host, so this list mirrors what the host reports rather than
 * being the source of truth.
 */
export interface CloudStreamRepository {
  name: string;
  url: string;
  iconUrl?: string | null;
  description?: string | null;
}

/** An extension a repository offers, with its installed state as the host sees it. */
export interface CloudStreamAvailablePlugin {
  internalName: string;
  name: string;
  version: number;
  description?: string | null;
  authors: string[];
  language?: string | null;
  iconUrl?: string | null;
  /** 0 down, 1 ok, 2 slow, 3 beta only — the repository's own health marker. */
  status: number;
  tvTypes: string[];
  fileSize?: number | null;
  repositoryUrl: string;
  installed: boolean;
  installedVersion?: number | null;
  updateAvailable: boolean;
}

/** An installed extension. `loaded` is false when the .cs3 failed to load. */
export interface CloudStreamPlugin {
  internalName: string;
  name: string;
  version: number;
  isOnline: boolean;
  repositoryUrl?: string | null;
  loaded: boolean;
  providerCount: number;
  extractorCount: number;
  error?: string | null;
}

/** A provider a loaded extension registered. */
export interface CloudStreamProvider {
  name: string;
  lang: string;
  hasMainPage: boolean;
  supportedTypes: string[];
  sourcePlugin?: string | null;
}

export interface CloudStreamSearchItem {
  name: string;
  url: string;
  apiName: string;
  type?: string | null;
  posterUrl?: string | null;
  quality?: string | null;
  score?: number | null;
  id?: number | null;
}

/** One row of the CloudStream home screen. */
export interface CloudStreamHomeSection {
  apiName: string;
  section: string;
  name: string;
  horizontal: boolean;
  items: CloudStreamSearchItem[];
}

/** A playable unit: a movie, or one episode of a series. */
export interface CloudStreamPlayable {
  label: string;
  data: string;
  season?: number | null;
  episode?: number | null;
  name?: string | null;
  posterUrl?: string | null;
  description?: string | null;
  dub?: string | null;
}

export interface CloudStreamLoadResponse {
  apiName: string;
  name: string;
  url: string;
  type: string;
  kind: 'movie' | 'series' | 'anime' | 'torrent' | 'live';
  posterUrl?: string | null;
  backgroundPosterUrl?: string | null;
  logoUrl?: string | null;
  year?: number | null;
  plot?: string | null;
  duration?: number | null;
  score?: number | null;
  contentRating?: string | null;
  tags: string[];
  playables: CloudStreamPlayable[];
}

export interface CloudStreamLink {
  source: string;
  name: string;
  url: string;
  referer: string;
  quality: number;
  type: string;
  isM3u8: boolean;
  headers: Record<string, string>;
}

/** A subtitle an extension returned. Field names match the host's JSON. */
export interface CloudStreamSubtitle {
  lang: string;
  url: string;
  headers?: Record<string, string>;
}

export interface CloudStreamLinks {
  links: CloudStreamLink[];
  subtitles: CloudStreamSubtitle[];
}

export interface CloudStreamSettings {
  sourcesTimeoutSeconds: number;
  preferredQuality: number;
  audioLanguage: string;
  prepareSources: boolean;
  allowAdult: boolean;
  jsDelivr: boolean;
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
  sourceType: 'stremio' | 'nuvio' | 'playtorrio' | 'iptv' | 'scraper' | 'debrid' | 'torrserver' | 'embed' | 'cloudstream' | 'ecosystem' | 'telegram' | 'hikari' | 'rule-scraper';
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

export interface ProviderHealth {
  id: string;
  name: string;
  status: 'searching' | 'ready' | 'empty' | 'error' | 'unsupported';
  count?: number;
  message?: string;
}

export type SourceKind = 'stremio' | 'nuvio';

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

/** Configuration for the optional IMDx (api.tiffara.com) metadata provider. */
export interface ImdxSettings {
  enabled: boolean;
  /** API origin, e.g. https://api.tiffara.com */
  baseUrl: string;
  /** Optional key — the public IMDx endpoints answer without one. */
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
  source: 'all' | 'tmdb' | 'stremio' | 'imdx';
  genre: string;
  year: string;
  minRating: number;
  sortBy: 'popularity.desc' | 'vote_average.desc' | 'primary_release_date.desc' | 'revenue.desc';
  language: string;
}

export type PlayerThemeId =
  | 'mpvrx' | 'amoled' | 'catppuccin' | 'nord' | 'tokyo' | 'dracula' | 'gruvbox' | 'rosepine';

export type SubtitleOutline = 'none' | 'thin' | 'medium' | 'thick' | 'shadow';
export type SubtitlePosition = 'bottom' | 'top' | 'middle';

/**
 * Playback engine preference. On Android `mpv` is tried first, then Media3,
 * then the in-WebView player; the order is fixed by `services/playerSelection`.
 * There is no browser mpv, so the web build always ends up on `web`.
 */
export type PlayerEngineId = 'mpv' | 'media3' | 'web';

/** Settings for the built-in mpvRx-style player. Persisted with the rest of the app. */
export interface PlayerSettings {
  /**
   * Engine to try first on Android. Unset or unrecognised values mean `mpv`,
   * so existing installs get it without a migration.
   */
  playerEngine?: PlayerEngineId;
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
  /** Subtitle background color hex. */
  subtitleBgColor?: string;
  /** Subtitle text outline style. */
  subtitleOutline?: SubtitleOutline;
  /** Subtitle screen position (bottom, top, middle). */
  subtitlePosition?: SubtitlePosition;
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

export type AppThemeAccent =
  | 'gold'
  | 'jade'
  | 'rosegold'
  | 'arcticblue'
  | 'arctic'
  | 'graphite'
  | 'crimson'
  | 'ocean'
  | 'emerald'
  | 'amber'
  | 'violet'
  | 'rose'
  | 'lime'
  | 'blue'
  | 'white';

export interface TmdbEnrichmentSettings {
  enabled: boolean;
  trailers: boolean;
  artwork: boolean;
  basicInfo: boolean;
  details: boolean;
  credits: boolean;
  episodes: boolean;
  seasonPosters: boolean;
  recommendations: boolean;
}

export interface AppSettings {
  autoplay: boolean;
  compactCards: boolean;
  reduceMotion: boolean;
  preferredLanguage: string;
  accent: AppThemeAccent;
  /** Custom background image URL (port of PlayTorrio's custom background). */
  customBackground?: string;
  tmdbApiKey: string;
  tmdbEnrichment: TmdbEnrichmentSettings;
  /** Optional IMDb-style metadata from the IMDx / Tiffara API. TMDB stays the primary catalog. */
  imdx: ImdxSettings;
  /** Debrid service used to convert magnets/infoHashes into direct HTTP streams. */
  debrid: DebridSettings;
  /** Optional Trakt / Simkl scrobbling credentials. */
  sync: SyncSettings;
  /** Enhanced D-Pad / Android TV spatial remote navigation. */
  dpadNavigation: boolean;
  /** Show the Netflix-style "Who's watching?" profile screen at the start of each session. */
  askProfileOnStartup: boolean;
  /** Route header-protected streams through native Android proxy when running in APK. */
  preferNativeProxy: boolean;
  /**
   * Adult content across manga, comics, anime, Live TV and the TMDB catalog.
   * `off` (default) hides it, `on` mixes it in, `only` shows nothing else.
   */
  nsfw: NsfwMode;
  /** DNS over HTTPS provider for app network requests. */
  dnsProvider?: string;
  /** Fall back to system DNS when DoH resolver is slow or blocked. */
  dnsFallback?: boolean;
  /**
   * Route DNS through the in-app tunnel so resolver-blocked sources load.
   * Only the DNS lookups are captured; media traffic is untouched.
   */
  vpnEnabled?: boolean;
  /** Resolver the DNS tunnel forwards to. */
  vpnDnsServer?: string;
  player: PlayerSettings;
}

export interface PrahaBackupBundle {
  app: 'praha-stream';
  version: number;
  exportedAt: number;
  settings: Partial<AppSettings>;
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  cloudstreamRepositories?: unknown[];
  nuvioSettings?: Record<string, Record<string, unknown>>;
  profiles: UserProfile[];
  activeProfileId: string;
  profileData: Record<string, {
    watchlist: MediaItem[];
    history: WatchProgress[];
    homeRows?: import('./services/homeCache').HomeRowSettings;
    preferredSource?: string;
  }>;
}

export interface ToastMessage {
  id: number;
  message: string;
  tone?: 'default' | 'success' | 'error';
}
