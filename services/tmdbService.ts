import type {
  DiscoverFilters, MediaCastMember, MediaItem, TmdbEpisodeInfo, TmdbSeasonSummary,
} from '../types';
import { getTmdbApiKey } from './tmdbConfig';

const API_URL = 'https://api.themoviedb.org/3';
const IMAGE_URL = 'https://image.tmdb.org/t/p';

/** TMDB genre ids so list results and Discover filters share a consistent map. */
export const GENRES: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-fi', 10770: 'TV Movie', 53: 'Thriller',
  10752: 'War', 37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News',
  10764: 'Reality', 10765: 'Sci-fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

/**Unified genre options for the Discover filter bar, mapping movie & TV genre IDs.*/
export const DISCOVER_GENRE_OPTIONS: Array<{ id: string; label: string; movieGenreId?: number; tvGenreId?: number }> = [
  { id: 'action', label: 'Action & Adventure', movieGenreId: 28, tvGenreId: 10759 },
  { id: 'animation', label: 'Animation', movieGenreId: 16, tvGenreId: 16 },
  { id: 'comedy', label: 'Comedy', movieGenreId: 35, tvGenreId: 35 },
  { id: 'crime', label: 'Crime', movieGenreId: 80, tvGenreId: 80 },
  { id: 'documentary', label: 'Documentary', movieGenreId: 99, tvGenreId: 99 },
  { id: 'drama', label: 'Drama', movieGenreId: 18, tvGenreId: 18 },
  { id: 'family', label: 'Family', movieGenreId: 10751, tvGenreId: 10751 },
  { id: 'fantasy', label: 'Fantasy & Sci-Fi', movieGenreId: 878, tvGenreId: 10765 },
  { id: 'horror', label: 'Horror', movieGenreId: 27, tvGenreId: 9648 },
  { id: 'mystery', label: 'Mystery', movieGenreId: 9648, tvGenreId: 9648 },
  { id: 'romance', label: 'Romance', movieGenreId: 10749, tvGenreId: 10749 },
  { id: 'thriller', label: 'Thriller', movieGenreId: 53, tvGenreId: 80 },
];

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

const seasonCache = new Map<string, TmdbEpisodeInfo[]>();

export const tmdbService = {
  async validateApiKey(apiKey: string) {
    await request('/configuration', apiKey);
    return true;
  },

  /** Trending titles. `all` mixes movies and TV in one ranked list. */
  async trending(type: 'movie' | 'tv' | 'all' = 'all', window: 'day' | 'week' = 'week', page = 1) {
    const endpoint = `/trending/${type}/${window}`;
    const data = await request<{ results?: unknown }>(`${endpoint}?page=${page}`);
    return listOf(data, endpoint, type === 'all' ? undefined : type);
  },

  /** Standard TMDB catalogs (`/movie/popular`, `/tv/top_rated`, …). */
  async catalog(kind: TmdbCatalogKind, type: 'movie' | 'tv', page = 1) {
    if (!isValidCatalog(kind, type)) throw new Error(`TMDB has no /${type}/${kind} catalog.`);
    const endpoint = `/${type}/${kind}`;
    const data = await request<{ results?: unknown }>(`${endpoint}?page=${page}`);
    return listOf(data, endpoint, type);
  },

  async search(query: string, page = 1) {
    const endpoint = '/search/multi';
    const data = await request<{ results?: unknown }>(
      `${endpoint}?query=${encodeURIComponent(query)}&include_adult=false&page=${page}`,
    );
    return listOf(data, endpoint);
  },

  /**
   * Filtered discovery powered by `/discover/movie` and `/discover/tv`.
   * Supports genre, release year, minimum rating, original language, sort, and pagination.
   */
  async discover(filters: DiscoverFilters, page = 1): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    const genreDef = filters.genre !== 'all'
      ? DISCOVER_GENRE_OPTIONS.find((item) => item.id === filters.genre)
      : undefined;

    const buildParams = (kind: 'movie' | 'tv') => {
      const params = new URLSearchParams();
      params.set('include_adult', 'false');
      params.set('page', String(page));
      const sort = kind === 'tv' && filters.sortBy === 'primary_release_date.desc'
        ? 'first_air_date.desc'
        : kind === 'tv' && filters.sortBy === 'revenue.desc'
          ? 'popularity.desc'
          : filters.sortBy;
      params.set('sort_by', sort);
      if (filters.sortBy === 'vote_average.desc') params.set('vote_count.gte', '150');
      if (filters.minRating > 0) params.set('vote_average.gte', String(filters.minRating));
      if (filters.language && filters.language !== 'all') params.set('with_original_language', filters.language);
      if (filters.year && filters.year !== 'all') {
        params.set(kind === 'movie' ? 'primary_release_year' : 'first_air_date_year', filters.year);
      }
      const gid = kind === 'movie' ? genreDef?.movieGenreId : genreDef?.tvGenreId;
      if (gid) params.set('with_genres', String(gid));
      return params.toString();
    };

    if (filters.type === 'movie') {
      const data = await request<{ results?: unknown; total_pages?: number }>(`/discover/movie?${buildParams('movie')}`);
      return { items: listOf(data, '/discover/movie', 'movie'), hasMore: page < Number(data.total_pages || 1) };
    }
    if (filters.type === 'series') {
      const data = await request<{ results?: unknown; total_pages?: number }>(`/discover/tv?${buildParams('tv')}`);
      return { items: listOf(data, '/discover/tv', 'tv'), hasMore: page < Number(data.total_pages || 1) };
    }

    const [movies, series] = await Promise.all([
      request<{ results?: unknown; total_pages?: number }>(`/discover/movie?${buildParams('movie')}`),
      request<{ results?: unknown; total_pages?: number }>(`/discover/tv?${buildParams('tv')}`),
    ]);
    const movieItems = listOf(movies, '/discover/movie', 'movie');
    const seriesItems = listOf(series, '/discover/tv', 'tv');
    const interleaved: MediaItem[] = [];
    const maxLen = Math.max(movieItems.length, seriesItems.length);
    for (let index = 0; index < maxLen; index += 1) {
      if (movieItems[index]) interleaved.push(movieItems[index]);
      if (seriesItems[index]) interleaved.push(seriesItems[index]);
    }
    const maxPages = Math.max(Number(movies.total_pages || 1), Number(series.total_pages || 1));
    return { items: interleaved, hasMore: page < maxPages };
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
   * Full metadata for one title: IMDB id, genres, runtime or season count,
   * certification, official YouTube trailer, cast & director/creator,
   * real season summaries, and recommendations.
   */
  async enrich(media: MediaItem): Promise<MediaItem> {
    let tmdbId = media.tmdbId;
    if (!tmdbId) {
      const resolved = await this.resolveIds(media).catch(() => ({ tmdbId: undefined, imdbId: media.imdbId }));
      if (resolved.tmdbId) tmdbId = Number(resolved.tmdbId);
    }
    if (!tmdbId) return media;

    const type = media.type === 'series' ? 'tv' : 'movie';
    const append = type === 'tv'
      ? 'external_ids,content_ratings,videos,credits,recommendations'
      : 'external_ids,release_dates,videos,credits,recommendations';
    const details = await request<Record<string, any>>(`/${type}/${tmdbId}?append_to_response=${append}`);

    const certification = type === 'tv'
      ? (details.content_ratings?.results || []).find((entry: { iso_3166_1: string }) => entry.iso_3166_1 === 'US')?.rating
      : (details.release_dates?.results || [])
        .flatMap((entry: { iso_3166_1: string; release_dates: Array<{ certification?: string }> }) =>
          entry.iso_3166_1 === 'US' ? entry.release_dates.map((item) => item.certification) : [])
        .find((value?: string) => Boolean(value));

    const videos: Array<Record<string, any>> = Array.isArray(details.videos?.results) ? details.videos.results : [];
    const youtubeVideos = videos.filter((video) => video.site === 'YouTube' && video.key);
    const officialTrailer = youtubeVideos.find((video) => video.type === 'Trailer' && video.official)
      || youtubeVideos.find((video) => video.type === 'Trailer')
      || youtubeVideos.find((video) => video.type === 'Teaser')
      || youtubeVideos[0];

    const rawCast: Array<Record<string, any>> = Array.isArray(details.credits?.cast) ? details.credits.cast : [];
    const cast: MediaCastMember[] = rawCast.slice(0, 14).map((member) => ({
      id: Number(member.id),
      name: String(member.name || 'Unknown'),
      character: member.character ? String(member.character) : undefined,
      profile: tmdbImage(member.profile_path, 'w185'),
    }));

    const rawCrew: Array<Record<string, any>> = Array.isArray(details.credits?.crew) ? details.credits.crew : [];
    const creators: Array<Record<string, any>> = Array.isArray(details.created_by) ? details.created_by : [];
    const director = type === 'tv'
      ? creators.map((person) => person.name).filter(Boolean).slice(0, 2).join(', ') || undefined
      : rawCrew.filter((person) => person.job === 'Director').map((person) => person.name).slice(0, 2).join(', ') || undefined;

    const rawSeasons: Array<Record<string, any>> = Array.isArray(details.seasons) ? details.seasons : [];
    const seasons: TmdbSeasonSummary[] = rawSeasons
      .filter((season) => Number(season.season_number) > 0 && Number(season.episode_count) > 0)
      .map((season) => ({
        id: Number(season.id || season.season_number),
        seasonNumber: Number(season.season_number),
        name: String(season.name || `Season ${season.season_number}`),
        episodeCount: Number(season.episode_count || 0),
        poster: tmdbImage(season.poster_path, 'w342'),
        airDate: season.air_date ? String(season.air_date) : undefined,
        overview: season.overview ? String(season.overview) : undefined,
      }));

    const recommendations = mapList(details.recommendations?.results, type).slice(0, 12);

    return {
      ...media,
      tmdbId,
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
      trailerKey: officialTrailer?.key ? String(officialTrailer.key) : media.trailerKey,
      trailerName: officialTrailer?.name ? String(officialTrailer.name) : media.trailerName,
      director: director || media.director,
      cast: cast.length ? cast : media.cast,
      recommendations: recommendations.length ? recommendations : media.recommendations,
      seasons: seasons.length ? seasons : media.seasons,
      numberOfSeasons: Number(details.number_of_seasons) || seasons.length || media.numberOfSeasons,
    };
  },

  /** Load full episode guide for one TV season (cached in-memory for instant switching). */
  async getSeason(tmdbId: number | string, seasonNumber: number): Promise<TmdbEpisodeInfo[]> {
    const cacheKey = `${tmdbId}:${seasonNumber}`;
    const cached = seasonCache.get(cacheKey);
    if (cached) return cached;

    const data = await request<{ episodes?: Array<Record<string, any>> }>(`/tv/${tmdbId}/season/${seasonNumber}`);
    const episodes: TmdbEpisodeInfo[] = (data.episodes || []).map((ep, idx) => ({
      id: Number(ep.id || idx + 1),
      season: Number(ep.season_number ?? seasonNumber),
      episode: Number(ep.episode_number ?? idx + 1),
      title: String(ep.name || `Episode ${ep.episode_number ?? idx + 1}`),
      overview: String(ep.overview || ''),
      still: tmdbImage(ep.still_path, 'w500'),
      airDate: ep.air_date ? String(ep.air_date) : undefined,
      runtime: Number(ep.runtime) || undefined,
      rating: Number(ep.vote_average) ? Number(Number(ep.vote_average).toFixed(1)) : undefined,
    }));
    seasonCache.set(cacheKey, episodes);
    return episodes;
  },
};
