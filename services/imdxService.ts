import type {
  ImdxSettings, MediaCastMember, MediaItem, TmdbEpisodeInfo, TmdbSeasonSummary,
} from '../types';
import { nativeFetchText } from './androidBridge';

/**
 * IMDx / Tiffara — an IMDb-style, key-free metadata API documented at https://tiffara.com.
 *
 * PRAHA keeps TMDB as its primary catalog (settings.tmdbApiKey is untouched) and uses
 * this provider as an additive, optional metadata source: extra search results in
 * Discover, richer details (plot, IMDb rating, directors, episode stills), and a
 * fallback catalog when no TMDB key has been added yet.
 */

export const IMDX_DEFAULT_BASE = 'https://api.tiffara.com';
export const IMDX_DOCS_URL = 'https://tiffara.com/';

const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env || {};
/** Set VITE_API_PROXY=1 to relay through the dev/preview proxy defined in vite.config.ts. */
const useProxy = env.VITE_API_PROXY === '1';

export const IMDX_PROXY_BASE = '/imdx';

export interface ImdxImage { url?: string; width?: number; height?: number }

export interface ImdxName {
  id?: string;
  displayName?: string;
  alternativeNames?: string[];
  primaryProfessions?: string[];
  primaryImage?: ImdxImage;
}

export interface ImdxTitle {
  id?: string;
  type?: string;
  isAdult?: boolean;
  primaryTitle?: string;
  originalTitle?: string;
  primaryImage?: ImdxImage;
  startYear?: number;
  endYear?: number;
  runtimeSeconds?: number;
  genres?: string[];
  rating?: { aggregateRating?: number; voteCount?: number };
  plot?: string;
  directors?: ImdxName[];
  writers?: ImdxName[];
  stars?: ImdxName[];
  spokenLanguages?: Array<{ code?: string; name?: string }>;
  originCountries?: Array<{ code?: string; name?: string }>;
  interests?: Array<{ id?: string; name?: string; isSubgenre?: boolean }>;
}

export interface ImdxEpisode {
  id?: string;
  title?: string;
  primaryImage?: ImdxImage;
  season?: string | number;
  episodeNumber?: number;
  runtimeSeconds?: number;
  plot?: string;
  rating?: { aggregateRating?: number };
  releaseDate?: { year?: number; month?: number; day?: number };
}

export const IMDX_SERIES_TYPES = ['tvSeries', 'tvMiniSeries', 'tvSpecial', 'tvShort'] as const;

/** Map the IMDb-style title type onto PRAHA's movie/series split. */
export function imdxMediaType(type?: string): MediaItem['type'] {
  const value = String(type || '').toLowerCase();
  if (value.startsWith('tv') && value !== 'tvmovie') return 'series';
  return 'movie';
}

export function imdxRuntimeLabel(seconds?: number): string | undefined {
  const minutes = Math.round(Number(seconds) / 60);
  if (!minutes || minutes <= 0) return undefined;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

export function normalizeImdxBaseUrl(raw?: string): string {
  const value = (raw || IMDX_DEFAULT_BASE).trim().replace(/\/+$/, '');
  if (!value) return IMDX_DEFAULT_BASE;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('The IMDx base URL must be a full https:// address.');
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('Only HTTPS IMDx endpoints are supported.');
  }
  if (parsed.username || parsed.password) throw new Error('Do not embed credentials in the IMDx URL.');
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Convert an IMDx search/list title into PRAHA's shared MediaItem shape. */
export function mapImdxTitle(title: ImdxTitle): MediaItem | null {
  const name = title.primaryTitle || title.originalTitle;
  if (!name || !title.id) return null;
  const poster = title.primaryImage?.url;
  const rating = Number(title.rating?.aggregateRating);
  return {
    id: `imdx:${title.id}`,
    imdbId: title.id,
    type: imdxMediaType(title.type),
    title: String(name),
    overview: title.plot || '',
    poster: poster || '',
    backdrop: undefined,
    year: title.startYear ? String(title.startYear) : undefined,
    rating: Number.isFinite(rating) && rating > 0 ? Number(rating.toFixed(1)) : undefined,
    genres: Array.isArray(title.genres) ? title.genres.slice(0, 4) : [],
    runtime: imdxRuntimeLabel(title.runtimeSeconds),
    source: 'imdx',
  };
}

export function mapImdxTitles(titles: unknown): MediaItem[] {
  if (!Array.isArray(titles)) return [];
  const seen = new Set<string>();
  return titles
    .map((entry) => mapImdxTitle(entry as ImdxTitle))
    .filter((item): item is MediaItem => Boolean(item))
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

function toCast(people: ImdxName[] | undefined, role: 'character' | 'job', label?: string): MediaCastMember[] {
  return (people || []).slice(0, 12).map((person, index) => ({
    id: Number(String(person.id || '').replace(/\D/g, '')) || index + 1,
    name: String(person.displayName || 'Unknown'),
    [role]: label,
    profile: person.primaryImage?.url,
  }));
}

export function mapImdxEpisodes(episodes: ImdxEpisode[] | undefined): TmdbEpisodeInfo[] {
  if (!Array.isArray(episodes)) return [];
  return episodes
    .filter((episode) => Number(episode?.episodeNumber) > 0)
    .map((episode, index) => ({
      id: Number(String(episode.id || '').replace(/\D/g, '')) || index + 1,
      season: Number(episode.season) || 1,
      episode: Number(episode.episodeNumber),
      title: String(episode.title || `Episode ${episode.episodeNumber}`),
      overview: String(episode.plot || ''),
      still: episode.primaryImage?.url,
      airDate: episode.releaseDate?.year
        ? [episode.releaseDate.year, String(episode.releaseDate.month || 1).padStart(2, '0'), String(episode.releaseDate.day || 1).padStart(2, '0')].join('-')
        : undefined,
      runtime: episode.runtimeSeconds ? Math.round(episode.runtimeSeconds / 60) : undefined,
      rating: episode.rating?.aggregateRating ? Number(Number(episode.rating.aggregateRating).toFixed(1)) : undefined,
    }))
    .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
}

function settingsBase(settings?: Partial<ImdxSettings>): string {
  if (!settings?.baseUrl) return useProxy ? IMDX_PROXY_BASE : IMDX_DEFAULT_BASE;
  const base = normalizeImdxBaseUrl(settings.baseUrl);
  return useProxy && base === IMDX_DEFAULT_BASE ? IMDX_PROXY_BASE : base;
}

async function request<T>(path: string, settings?: Partial<ImdxSettings>): Promise<T> {
  const base = settingsBase(settings);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = settings?.apiKey?.trim();
  if (apiKey) headers['x-api-key'] = apiKey;
  let result: Awaited<ReturnType<typeof nativeFetchText>>;
  try {
    result = await nativeFetchText(`${base}${path}`, { headers, timeoutMs: 14000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/abort/i.test(message)) throw new Error('IMDx took too long to answer. Check your connection and retry.');
    throw new Error('IMDx is unreachable. Check the IMDx base URL in Settings, or your network.');
  }
  if (!result.ok) {
    let detail = '';
    try {
      const body = JSON.parse(result.data) as { message?: string };
      detail = body?.message || '';
    } catch { /* not JSON */ }
    throw new Error(detail || `IMDx returned HTTP ${result.status || 'error'}.`);
  }
  try {
    return JSON.parse(result.data) as T;
  } catch {
    throw new Error('IMDx returned a response that was not JSON.');
  }
}

export const imdxService = {
  isEnabled(settings?: Partial<ImdxSettings>): boolean {
    return Boolean(settings?.enabled);
  },

  /** Cheap health check used by Settings → Verify. */
  async verify(settings?: Partial<ImdxSettings>): Promise<true> {
    await request('/titles/tt0133093', settings);
    return true;
  },

  async search(query: string, settings?: Partial<ImdxSettings>): Promise<MediaItem[]> {
    const term = query.trim();
    if (!term) return [];
    const data = await request<{ titles?: unknown }>(`/search/titles?query=${encodeURIComponent(term)}`, settings);
    return mapImdxTitles(data.titles);
  },

  /** Popular titles straight from the IMDx index — used when TMDB has no key yet. */
  async list(settings: Partial<ImdxSettings> | undefined, types: Array<'MOVIE' | 'TV_SERIES'>, sortBy = 'SORT_BY_POPULARITY'): Promise<MediaItem[]> {
    const params = new URLSearchParams();
    types.forEach((type) => params.append('types', type));
    params.set('sortBy', sortBy);
    params.set('sortOrder', 'DESC');
    const data = await request<{ titles?: unknown }>(`/titles?${params.toString()}`, settings);
    return mapImdxTitles(data.titles);
  },

  async getTitle(imdbId: string, settings?: Partial<ImdxSettings>): Promise<ImdxTitle> {
    return request<ImdxTitle>(`/titles/${encodeURIComponent(imdbId)}`, settings);
  },

  async getSeasons(imdbId: string, settings?: Partial<ImdxSettings>): Promise<TmdbSeasonSummary[]> {
    const data = await request<{ seasons?: Array<{ season?: string; episodeCount?: number }> }>(
      `/titles/${encodeURIComponent(imdbId)}/seasons`,
      settings,
    );
    return (data.seasons || [])
      .map((season) => ({
        id: Number(season.season) || 0,
        seasonNumber: Number(season.season) || 0,
        name: `Season ${season.season}`,
        episodeCount: Number(season.episodeCount) || 0,
      }))
      .filter((season) => season.seasonNumber > 0);
  },

  async getEpisodes(imdbId: string, settings?: Partial<ImdxSettings>): Promise<TmdbEpisodeInfo[]> {
    const data = await request<{ episodes?: ImdxEpisode[] }>(`/titles/${encodeURIComponent(imdbId)}/episodes`, settings);
    return mapImdxEpisodes(data.episodes);
  },

  /** Enrich a MediaItem with IMDb plot, genres, runtime, directors and stars. */
  async enrich(media: MediaItem, settings?: Partial<ImdxSettings>): Promise<MediaItem> {
    const imdbId = media.imdbId || (media.id.startsWith('tt') ? media.id : '');
    if (!imdbId) return media;
    const title = await this.getTitle(imdbId, settings);
    const directors = (title.directors || []).map((person) => person.displayName).filter(Boolean) as string[];
    const genres = Array.isArray(title.genres) && title.genres.length ? title.genres : media.genres;
    const stars = toCast(title.stars, 'character');
    const enriched: MediaItem = {
      ...media,
      imdbId,
      title: title.primaryTitle || media.title,
      overview: title.plot || media.overview,
      poster: title.primaryImage?.url || media.poster,
      year: title.startYear ? String(title.startYear) : media.year,
      rating: title.rating?.aggregateRating ? Number(Number(title.rating.aggregateRating).toFixed(1)) : media.rating,
      runtime: imdxRuntimeLabel(title.runtimeSeconds) || media.runtime,
      genres,
      director: directors.slice(0, 2).join(', ') || media.director,
      cast: stars.length ? stars : media.cast,
    };
    if (enriched.type === 'series') {
      const seasons = await this.getSeasons(imdbId, settings).catch(() => [] as TmdbSeasonSummary[]);
      if (seasons.length) {
        enriched.seasons = seasons;
        enriched.numberOfSeasons = seasons.length;
      }
    }
    return enriched;
  },
};
