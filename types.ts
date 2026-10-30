export type MediaType = 'movie' | 'series';
export type AppView = 'home' | 'discover' | 'library' | 'extensions' | 'settings';

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
  source: 'praha' | 'tmdb' | 'stremio';
  addonUrl?: string;
}

export interface WatchProgress {
  media: MediaItem;
  progress: number;
  watchedAt: number;
  season?: number;
  episode?: number;
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
  sourceType: 'stremio' | 'nuvio';
  quality?: string;
  size?: string;
  language?: string;
  provider?: string;
  seeders?: number;
  peers?: number;
  infoHash?: string;
  headers?: Record<string, string>;
  subtitles?: StreamSubtitle[];
  externalUrl?: string;
  ytId?: string;
  behaviorHints?: Record<string, unknown>;
}

export interface SourceError {
  sourceName: string;
  message: string;
}

export interface AppSettings {
  autoplay: boolean;
  compactCards: boolean;
  reduceMotion: boolean;
  preferredLanguage: string;
  accent: 'lime' | 'violet' | 'blue';
  tmdbApiKey: string;
}

export interface ToastMessage {
  id: number;
  message: string;
  tone?: 'default' | 'success' | 'error';
}
