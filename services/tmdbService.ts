import { CURATED_MEDIA } from '../data/catalog';
import type { MediaItem } from '../types';
import { getTmdbApiKey } from './tmdbConfig';

const API_URL = 'https://api.themoviedb.org/3';
const IMAGE_URL = 'https://image.tmdb.org/t/p';

async function request<T>(path: string, suppliedKey?: string): Promise<T> {
  const apiKey = (suppliedKey === undefined ? getTmdbApiKey() : suppliedKey).trim();
  if (!apiKey) throw new Error('Add your personal TMDB API key in Settings → TMDB API.');

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

export function mapTmdbItem(item: Record<string, any>, forcedType?: 'movie' | 'tv'): MediaItem | null {
  const rawType = forcedType || item.media_type;
  if (!['movie', 'tv'].includes(rawType) || (!item.poster_path && !item.backdrop_path)) return null;
  return {
    id: `tmdb:${item.id}`,
    tmdbId: Number(item.id),
    type: rawType === 'tv' ? 'series' : 'movie',
    title: item.title || item.name || 'Untitled',
    overview: item.overview || '',
    poster: item.poster_path ? `${IMAGE_URL}/w500${item.poster_path}` : `${IMAGE_URL}/w780${item.backdrop_path}`,
    backdrop: item.backdrop_path ? `${IMAGE_URL}/original${item.backdrop_path}` : undefined,
    year: String(item.release_date || item.first_air_date || '').slice(0, 4),
    rating: Number(item.vote_average) || undefined,
    genres: [],
    source: 'tmdb',
  };
}

export const tmdbService = {
  async validateApiKey(apiKey: string) {
    await request('/configuration', apiKey);
    return true;
  },

  async trending(type: 'movie' | 'tv' = 'movie') {
    const data = await request<{ results: Record<string, any>[] }>(`/trending/${type}/week`);
    return data.results.map((item) => mapTmdbItem(item, type)).filter((item): item is MediaItem => Boolean(item));
  },

  async search(query: string) {
    const data = await request<{ results: Record<string, any>[] }>(`/search/multi?query=${encodeURIComponent(query)}&include_adult=false`);
    return data.results.map((item) => mapTmdbItem(item)).filter((item): item is MediaItem => Boolean(item));
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

  async enrich(media: MediaItem): Promise<MediaItem> {
    if (!media.tmdbId) return media;
    const type = media.type === 'series' ? 'tv' : 'movie';
    const details = await request<Record<string, any>>(`/${type}/${media.tmdbId}?append_to_response=external_ids`);
    return {
      ...media,
      imdbId: details.external_ids?.imdb_id || details.imdb_id || media.imdbId,
      overview: details.overview || media.overview,
      runtime: details.runtime ? `${Math.floor(details.runtime / 60)}h ${details.runtime % 60}m` : details.number_of_seasons ? `${details.number_of_seasons} season${details.number_of_seasons === 1 ? '' : 's'}` : media.runtime,
      genres: details.genres?.map((genre: { name: string }) => genre.name) || media.genres,
      maturity: details.adult ? 'R' : media.maturity,
    };
  },
};

export function searchCurated(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return CURATED_MEDIA;
  return CURATED_MEDIA.filter((item) =>
    item.title.toLowerCase().includes(normalized) || item.genres.some((genre) => genre.toLowerCase().includes(normalized)),
  );
}
