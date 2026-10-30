import type { MediaItem } from '../types';
import { getTmdbApiKey } from './tmdbConfig';

const API_URL = 'https://api.themoviedb.org/3';
const IMAGE_URL = 'https://image.tmdb.org/t/p';

/** TMDB genre ids (identical for movies and TV) so list results can carry genres. */
const GENRES: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-fi', 10770: 'TV Movie', 53: 'Thriller',
  10752: 'War', 37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News',
  10764: 'Reality', 10765: 'Sci-fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

export class TmdbKeyError extends Error {
  constructor() {
    super('Add your personal TMDB API key in Settings → TMDB API.');
    this.name = 'TmdbKeyError';
  }
}

async function request<T>(path: string, suppliedKey?: string): Promise<T> {
  const apiKey = (suppliedKey === undefined ? getTmdbApiKey() : suppliedKey).trim();
  if (!apiKey) throw new TmdbKeyError();

  const url = new URL(`${API_URL}${path}`);
  const isV4Token = apiKey.startsWith('eyJ') && apiKey.split('.').length === 3;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (isV4Token) headers.Authorization = `Bearer ${apiKey}`;
  else url.searchParams.set('api_key', apiKey);

  const response = await fetch(url, { headers });
  if (!response.ok) {
    let message = `TMDB returned HTTP ${response.status}.`;
    try {
      const error = await response.json() as { status_message?: string };
      if (error.status_message) message = error.status_message;
    } catch { /* Keep the HTTP error when the response is not JSON. */ }
    throw new Error(message);
  }
  return response.json();
}

export function tmdbImage(path: string | null | undefined, size = 'w500') {
  return path ? `${IMAGE_URL}/${size}${path}` : undefined;
}

export function mapTmdbItem(item: Record<string, any>, forcedType?: 'movie' | 'tv'): MediaItem | null {
  const rawType = forcedType || item.media_type;
  if (!['movie', 'tv'].includes(rawType) || (!item.poster_path && !item.backdrop_path)) return null;
  const genreIds: number[] = Array.isArray(item.genre_ids) ? item.genre_ids : [];
  return {
    id: `tmdb:${item.id}`,
    tmdbId: Number(item.id),
    type: rawType === 'tv' ? 'series' : 'movie',
    title: item.title || item.name || 'Untitled',
    overview: item.overview || '',
    poster: tmdbImage(item.poster_path) || tmdbImage(item.backdrop_path, 'w780') || '',
    backdrop: tmdbImage(item.backdrop_path, 'w1280'),
    year: String(item.release_date || item.first_air_date || '').slice(0, 4),
    rating: Number(item.vote_average) ? Number(Number(item.vote_average).toFixed(1)) : undefined,
    genres: genreIds.map((id) => GENRES[id]).filter((name): name is string => Boolean(name)),
    source: 'tmdb',
  };
}

function mapList(results: unknown, forcedType?: 'movie' | 'tv') {
  if (!Array.isArray(results)) return [];
  return (results as Record<string, any>[]).map((item) => mapTmdbItem(item, forcedType)).filter((item): item is MediaItem => Boolean(item));
}

/** Every catalog endpoint must answer with a `results` array — say so when it does not. */
function listOf(data: { results?: unknown }, endpoint: string, forcedType?: 'movie' | 'tv') {
  if (!data || !Array.isArray(data.results)) throw new Error(`TMDB returned an unexpected response for ${endpoint}.`);
  return mapList(data.results, forcedType);
}

export type TmdbCatalogKind = 'popular' | 'top_rated' | 'now_playing' | 'upcoming' | 'airing_today' | 'on_the_air';

const CATALOG_BY_TYPE: Record<'movie' | 'tv', TmdbCatalogKind[]> = {
  movie: ['popular', 'top_rated', 'now_playing', 'upcoming'],
  tv: ['popular', 'top_rated', 'airing_today', 'on_the_air'],
};

export function isValidCatalog(kind: TmdbCatalogKind, type: 'movie' | 'tv') {
  return CATALOG_BY_TYPE[type].includes(kind);
}

export const tmdbService = {
  async validateApiKey(apiKey: string) {
    await request('/configuration', apiKey);
    return true;
  },

  /** Trending titles. `all` mixes movies and TV in one ranked list. */
  async trending(type: 'movie' | 'tv' | 'all' = 'all', window: 'day' | 'week' = 'week') {
    const endpoint = `/trending/${type}/${window}`;
    const data = await request<{ results?: unknown }>(endpoint);
    return listOf(data, endpoint, type === 'all' ? undefined : type);
  },

  /** Standard TMDB catalogs (`/movie/popular`, `/tv/top_rated`, …). */
  async catalog(kind: TmdbCatalogKind, type: 'movie' | 'tv') {
    if (!isValidCatalog(kind, type)) throw new Error(`TMDB has no /${type}/${kind} catalog.`);
    const endpoint = `/${type}/${kind}`;
    const data = await request<{ results?: unknown }>(endpoint);
    return listOf(data, endpoint, type);
  },

  async search(query: string) {
    const endpoint = '/search/multi';
    const data = await request<{ results?: unknown }>(`${endpoint}?query=${encodeURIComponent(query)}&include_adult=false`);
    return listOf(data, endpoint);
  },

  async resolveIds(media: MediaItem): Promise<{ tmdbId?: string; imdbId?: string }> {
    let tmdbId = media.tmdbId ? String(media.tmdbId) : undefined;
    let imdbId = media.imdbId || (media.id.startsWith('tt') ? media.id : undefined);
    if (!tmdbId && media.id.startsWith('tmdb:')) tmdbId = media.id.slice(5);
    if (tmdbId && !imdbId) {
      const type = media.type === 'series' ? 'tv' : 'movie';
      const details = await request<{ external_ids?: { imdb_id?: string }; imdb_id?: string }>(`/${type}/${tmdbId}?append_to_response=external_ids`);
      imdbId = details.external_ids?.imdb_id || details.imdb_id;
    }
    if (!tmdbId && imdbId) {
      const data = await request<{ movie_results: Array<{ id: number }>; tv_results: Array<{ id: number }> }>(`/find/${imdbId}?external_source=imdb_id`);
      tmdbId = String((media.type === 'series' ? data.tv_results[0]?.id : data.movie_results[0]?.id) || data.movie_results[0]?.id || data.tv_results[0]?.id || '') || undefined;
    }
    return { tmdbId, imdbId };
  },

  /**
   * Full metadata for one title: IMDB id, genres, runtime or season count, and a
   * certification (US where available) for the maturity badge.
   */
  async enrich(media: MediaItem): Promise<MediaItem> {
    if (!media.tmdbId) return media;
    const type = media.type === 'series' ? 'tv' : 'movie';
    const append = type === 'tv' ? 'external_ids,content_ratings' : 'external_ids,release_dates';
    const details = await request<Record<string, any>>(`/${type}/${media.tmdbId}?append_to_response=${append}`);

    const certification = type === 'tv'
      ? (details.content_ratings?.results || []).find((entry: { iso_3166_1: string }) => entry.iso_3166_1 === 'US')?.rating
      : (details.release_dates?.results || [])
        .flatMap((entry: { iso_3166_1: string; release_dates: Array<{ certification?: string }> }) =>
          entry.iso_3166_1 === 'US' ? entry.release_dates.map((item) => item.certification) : [])
        .find((value?: string) => Boolean(value));

    return {
      ...media,
      imdbId: details.external_ids?.imdb_id || details.imdb_id || media.imdbId,
      overview: details.overview || media.overview,
      poster: tmdbImage(details.poster_path) || media.poster,
      backdrop: tmdbImage(details.backdrop_path, 'w1280') || media.backdrop,
      year: media.year || String(details.release_date || details.first_air_date || '').slice(0, 4),
      rating: media.rating ?? (Number(details.vote_average) ? Number(Number(details.vote_average).toFixed(1)) : undefined),
      runtime: details.runtime
        ? `${Math.floor(details.runtime / 60)}h ${details.runtime % 60}m`
        : details.number_of_seasons
          ? `${details.number_of_seasons} season${details.number_of_seasons === 1 ? '' : 's'}`
          : media.runtime,
      genres: details.genres?.length ? details.genres.map((genre: { name: string }) => genre.name) : media.genres,
      maturity: certification || media.maturity,
    };
  },
};
