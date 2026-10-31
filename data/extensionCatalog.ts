import type { SourceKind } from '../types';

export interface CuratedExtensionItem {
  id: string;
  name: string;
  kind: SourceKind;
  category: 'Subtitles' | 'Catalogs & Metadata' | 'Anime' | 'Public Domain & Live' | 'Configurable';
  description: string;
  manifestUrl: string;
  configureUrl?: string;
  badge?: string;
}

/**
 * Curated directory of official & community Stremio addons and starter
 * repositories for 1-click installation inside Extensions → Directory.
 */
export const CURATED_EXTENSIONS: CuratedExtensionItem[] = [
  {
    id: 'opensubtitles-v3',
    name: 'OpenSubtitles v3',
    kind: 'stremio',
    category: 'Subtitles',
    description: 'Official multi-language subtitle addon powered by OpenSubtitles.',
    manifestUrl: 'https://opensubtitles-v3.strem.io/manifest.json',
    badge: 'Recommended',
  },
  {
    id: 'cinemeta',
    name: 'Cinemeta',
    kind: 'stremio',
    category: 'Catalogs & Metadata',
    description: 'The canonical Stremio movie and series catalog and IMDb metadata provider.',
    manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json',
    badge: 'Built-in',
  },
  {
    id: 'anime-kitsu',
    name: 'Anime Kitsu',
    kind: 'stremio',
    category: 'Anime',
    description: 'Seasonal, trending, and top-rated anime catalogs and metadata from Kitsu.',
    manifestUrl: 'https://anime-kitsu.strem.fun/manifest.json',
  },
  {
    id: 'watchhub',
    name: 'WatchHub',
    kind: 'stremio',
    category: 'Catalogs & Metadata',
    description: 'Official streaming platform availability links for movies and shows.',
    manifestUrl: 'https://watchhub.strem.io/manifest.json',
  },
  {
    id: 'public-domain-movies',
    name: 'Public Domain Movies',
    kind: 'stremio',
    category: 'Public Domain & Live',
    description: 'Classic cinema in the public domain with direct browser & Android streams.',
    manifestUrl: 'https://publicdomainmovies.strem.io/manifest.json',
  },
  {
    id: 'youtube-stremio',
    name: 'YouTube Channels',
    kind: 'stremio',
    category: 'Public Domain & Live',
    description: 'Official YouTube channels and trailers formatted as Stremio catalogs.',
    manifestUrl: 'https://v3-channels.strem.io/manifest.json',
  },
  {
    id: 'cyberflix-catalog',
    name: 'Cyberflix Catalog',
    kind: 'stremio',
    category: 'Configurable',
    description: 'Curated streaming service catalogs (configure your preferred platforms first).',
    manifestUrl: 'https://cyberflix.elfhosted.com/manifest.json',
    configureUrl: 'https://cyberflix.elfhosted.com/configure',
  },
];
