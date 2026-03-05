
export interface MediaItem {
  id: number;
  title: string;
  name?: string;
  media_type: 'movie' | 'tv' | 'person';
  poster_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  genre_ids?: number[];
  overview?: string;
}

export interface FavoriteItem extends MediaItem {}

export interface WatchlistItem extends MediaItem {
    addedAt: number;
}

export interface HistoryItem extends MediaItem {
    watchedAt: number;
    progress: number;
}

export interface UserProfile {
    id: string;
    name: string;
    avatar: string; // class name for icon or color
    created: number;
}

export interface Settings {
    theme: 'dark' | 'light' | 'blue' | 'purple';
    autoDarkMode: boolean;
    privacyMode: boolean;
    trackHistory: boolean;
    analyticsEnabled: boolean;
    autoPlay: boolean;
    defaultQuality: 'auto' | '1080p' | '720p' | '480p';
    vpnMode: boolean;
    adBlocker: boolean;
}

export interface Server {
    name: string;
    movieUrl: string;
    tvUrl: string;
    downloadSupport: boolean;
    qualityOptions: string[];
    cors: boolean;
}

export interface Servers {
    [key: string]: Server;
}

export interface CurrentVideoInfo {
    embedUrl: string;
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    season: number | null;
    episode: number | null;
    serverKey: string;
    itemData: MediaItem;
}
