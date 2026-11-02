import type {
  AnimeReference, MediaCastMember, MediaItem, TmdbEpisodeInfo, TmdbSeasonSummary,
} from '../types';
import { nativeFetchText } from './androidBridge';

/**
 * Anime metadata comes from two independent, key-free public APIs:
 *
 *  - AniCore  (https://anicore.dpdns.org)  — unified Kitsu / TVDB / TMDB / AniList / MAL index.
 *  - Anikura  (https://anikura.club/api)   — catalog lookups plus episode discussion comments.
 *
 * Both are browser-friendly, but a dev/preview proxy (see vite.config.ts) is used
 * locally so the tab also works on hosts where the remote CORS headers are missing.
 */

const ANICORE_ORIGIN = 'https://anicore.dpdns.org';
const ANIKURA_ORIGIN = 'https://anikura.club';

const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env || {};
/**
 * Requests go straight to the public origins by default. Set VITE_API_PROXY=1
 * to route them through the dev/preview relay in vite.config.ts — useful on
 * hosts that cannot reach the APIs directly. Inside the Android APK, `nativeFetchText`
 * falls back to PRAHA's native HTTP bridge so CORS and header rules never apply.
 */
const useProxy = env.VITE_API_PROXY === '1';

export const ANICORE_API_BASE = useProxy ? '/anicore/v1' : `${ANICORE_ORIGIN}/v1`;
export const ANIKURA_API_BASE = useProxy ? '/anikura/api/v1' : `${ANIKURA_ORIGIN}/api/v1`;

export const ANICORE_SITE = ANICORE_ORIGIN;
export const ANIKURA_SITE = ANIKURA_ORIGIN;

export const ANIME_FORMATS = ['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'] as const;
export type AnimeFormat = (typeof ANIME_FORMATS)[number];

export const ANIME_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Romance', 'Sci-Fi', 'Slice of Life',
  'Supernatural', 'Mystery', 'Sports', 'Thriller', 'Award Winning', 'Shounen',
] as const;

export type AnimeSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

export interface AniCoreNamed {
  name?: string | null;
  slug?: string | null;
  kind?: string | null;
}

export interface AniCoreEntry {
  id?: number;
  slug?: string;
  title?: string;
  titleEnglish?: string | null;
  titleNative?: string | null;
  format?: string | null;
  status?: string | null;
  season?: string | null;
  seasonYear?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  episodeCount?: number | null;
  episodesKnown?: number | null;
  durationMinutes?: number | null;
  images?: { poster?: string | null; cover?: string | null; banner?: string | null; logo?: string | null } | null;
  trailer?: { youtubeId?: string | null; url?: string | null } | null;
  scores?: {
    average?: number | null; anilist?: number | null; mal?: number | null;
    malRank?: number | null; malMembers?: number | null; anilistPopularity?: number | null;
  } | null;
  isAdult?: boolean | null;
  dataQuality?: number | null;
  sources?: string[] | null;
  externalIds?: {
    mal?: number | null; anilist?: number | null; kitsu?: number | null;
    tvdb?: number | null; tmdb?: number | null; imdb?: string | null;
  } | null;
  genres?: AniCoreNamed[] | null;
  studios?: AniCoreNamed[] | null;
  synopsis?: string | null;
  background?: string | null;
  contentRating?: string | null;
}

export interface AniCoreEpisode {
  id?: number;
  number?: number | null;
  seasonNumber?: number | null;
  absoluteNumber?: number | null;
  title?: string | null;
  synopsis?: string | null;
  airDate?: string | null;
  runtimeMinutes?: number | null;
  thumbnail?: string | null;
}

export interface AniCorePage<T> {
  pageInfo?: { page?: number; perPage?: number; total?: number; lastPage?: number; hasNextPage?: boolean };
  items?: T[];
}

export interface AnikuraComment {
  id: string;
  body: string;
  created_at?: string;
  like_count?: number;
  parent_id?: string | null;
  author?: { name?: string; handle?: string; avatar?: string; profile_url?: string } | null;
}

export interface AnikuraSeries {
  id?: number;
  title?: string;
  url?: string;
  watch_url?: string;
  mal_id?: number;
  anilist_id?: number;
  tmdb_id?: number;
}

export interface AnikuraCatalog {
  id?: number;
  title?: string;
  title_alternative?: string | null;
  title_native?: string | null;
  synopsis?: string | null;
  year?: number | null;
  season?: string | null;
  status?: string | null;
  score?: string | null;
  rating?: string | null;
  episode_count?: number | null;
  duration_minutes?: number | null;
  poster?: string | null;
  banner?: string | null;
  ids?: { anikura?: number; mal?: number; anilist?: number; tmdb?: number } | null;
  url?: string | null;
  episodes?: Array<{ number: number; title?: string | null; title_japanese?: string | null }>;
}

export interface AnikuraIds {
  mal?: number;
  anilist?: number;
  tmdb?: number;
  id?: number;
}

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

function readCache<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function writeCache<T>(key: string, value: T) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 240) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 60);
    oldest.forEach(([entryKey]) => cache.delete(entryKey));
  }
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  let result: Awaited<ReturnType<typeof nativeFetchText>>;
  try {
    result = await nativeFetchText(url, { headers: { Accept: 'application/json' }, timeoutMs: 14000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/abort/i.test(message)) throw new Error(`${label} took too long to answer. Check your connection and retry.`);
    throw new Error(`${label} is unreachable from this app. On the web this is usually a CORS block — the Android build bypasses it automatically.`);
  }
  if (!result.ok) {
    let detail = '';
    try {
      const body = JSON.parse(result.data) as { error?: string; message?: string };
      detail = body?.message || body?.error || '';
    } catch { /* body was not JSON */ }
    throw new Error(detail ? `${label}: ${detail}` : `${label} returned HTTP ${result.status || 'error'}.`);
  }
  try {
    return JSON.parse(result.data) as T;
  } catch {
    throw new Error(`${label} returned a response that was not JSON.`);
  }
}

/** The JSON-stringified date AniCore returns (`{"year":2013,"month":4,"day":7}`) plus plain ISO strings. */
export function parseAniCoreYear(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { year?: number | null };
      return parsed?.year ? String(parsed.year) : undefined;
    } catch {
      return undefined;
    }
  }
  const match = text.match(/(\d{4})/);
  return match ? match[1] : undefined;
}

export function currentAnimeSeason(date = new Date()): { season: AnimeSeason; year: number } {
  const month = date.getMonth(); // 0-11
  const season: AnimeSeason = month <= 2 ? 'WINTER' : month <= 5 ? 'SPRING' : month <= 8 ? 'SUMMER' : 'FALL';
  return { season, year: date.getFullYear() };
}

export const SEASON_LABEL: Record<AnimeSeason, string> = {
  WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall',
};

/** AniCore returns scores on a 0–100 scale; PRAHA displays a 0–10 rating like TMDB. */
export function anicoreScore(average?: number | null): number | undefined {
  if (!average && average !== 0) return undefined;
  const scaled = Number(average) / 10;
  if (!Number.isFinite(scaled) || scaled <= 0) return undefined;
  return Number(scaled.toFixed(1));
}

export function anicoreRuntimeLabel(minutes?: number | null): string | undefined {
  if (!minutes || minutes <= 0) return undefined;
  return `${minutes}m`;
}

export function animeReference(entry: AniCoreEntry): AnimeReference {
  return {
    slug: String(entry.slug || entry.id || ''),
    anicoreId: entry.id ? Number(entry.id) : undefined,
    malId: entry.externalIds?.mal ? Number(entry.externalIds.mal) : undefined,
    anilistId: entry.externalIds?.anilist ? Number(entry.externalIds.anilist) : undefined,
    kitsuId: entry.externalIds?.kitsu ? Number(entry.externalIds.kitsu) : undefined,
    tvdbId: entry.externalIds?.tvdb ? Number(entry.externalIds.tvdb) : undefined,
    format: entry.format || undefined,
    status: entry.status || undefined,
    season: entry.season || undefined,
    seasonYear: entry.seasonYear || undefined,
    episodeCount: entry.episodeCount || entry.episodesKnown || undefined,
    studios: (entry.studios || []).map((studio) => studio.name).filter((name): name is string => Boolean(name)).slice(0, 4),
    sources: entry.sources || undefined,
  };
}

/** Convert one AniCore catalog record into PRAHA's shared MediaItem shape. */
export function mapAniCoreItem(entry: AniCoreEntry): MediaItem | null {
  const title = entry.titleEnglish || entry.title;
  const slug = entry.slug;
  if (!title || !slug) return null;
  const poster = entry.images?.poster || entry.images?.cover || undefined;
  const backdrop = entry.images?.banner || entry.images?.cover || undefined;
  if (!poster && !backdrop) return null;
  const format = (entry.format || '').toUpperCase();
  const type: MediaItem['type'] = format === 'MOVIE' ? 'movie' : 'series';
  const year = entry.seasonYear ? String(entry.seasonYear) : parseAniCoreYear(entry.startDate);

  return {
    id: `anicore:${slug}`,
    tmdbId: entry.externalIds?.tmdb ? Number(entry.externalIds.tmdb) : undefined,
    imdbId: entry.externalIds?.imdb || undefined,
    type,
    title: String(title),
    overview: entry.synopsis || '',
    poster: poster || backdrop || '',
    backdrop,
    logo: entry.images?.logo || undefined,
    year,
    rating: anicoreScore(entry.scores?.average),
    genres: (entry.genres || []).map((genre) => genre.name).filter((name): name is string => Boolean(name)).slice(0, 4),
    runtime: type === 'movie' ? anicoreRuntimeLabel(entry.durationMinutes) : undefined,
    maturity: entry.contentRating ? entry.contentRating.toUpperCase() : undefined,
    source: 'anicore',
    trailerKey: entry.trailer?.youtubeId || undefined,
    anime: animeReference(entry),
  };
}

export function mapAniCoreList(entries: AniCoreEntry[] | undefined): MediaItem[] {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  return entries
    .map((entry) => mapAniCoreItem(entry))
    .filter((item): item is MediaItem => Boolean(item))
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

export function mapAniCoreEpisodes(slug: string, episodes: AniCoreEpisode[] | undefined): TmdbEpisodeInfo[] {
  if (!Array.isArray(episodes)) return [];
  return episodes
    .filter((episode) => Number(episode?.number) > 0)
    .map((episode, index) => ({
      id: Number(episode.id) || index + 1,
      season: Number(episode.seasonNumber) || 1,
      episode: Number(episode.number),
      title: String(episode.title || `Episode ${episode.number}`),
      overview: String(episode.synopsis || ''),
      still: episode.thumbnail || undefined,
      airDate: episode.airDate || undefined,
      runtime: episode.runtimeMinutes || undefined,
    }))
    .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
}

/** Build a season summary list from a flat AniCore episode list. */
export function seasonsFromEpisodes(slug: string, episodes: TmdbEpisodeInfo[]): TmdbSeasonSummary[] {
  const grouped = new Map<number, number>();
  episodes.forEach((episode) => grouped.set(episode.season, (grouped.get(episode.season) || 0) + 1));
  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seasonNumber, episodeCount]) => ({
      id: seasonNumber,
      seasonNumber,
      name: `Season ${seasonNumber}`,
      episodeCount,
    }));
}

function buildAniCoreUrl(path: string, params: Record<string, string | number | undefined>) {
  const url = new URL(`${ANICORE_API_BASE}${path}`, typeof window === 'undefined' ? ANICORE_ORIGIN : window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '' || value === null) return;
    url.searchParams.set(key, String(value));
  });
  return useProxy ? `${url.pathname}${url.search}` : url.toString();
}

function buildAnikuraUrl(path: string, params: Record<string, string | number | undefined>) {
  const url = new URL(`${ANIKURA_API_BASE}${path}`, typeof window === 'undefined' ? ANIKURA_ORIGIN : window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '' || value === null) return;
    url.searchParams.set(key, String(value));
  });
  return useProxy ? `${url.pathname}${url.search}` : url.toString();
}

export interface AnimeBrowseOptions {
  page?: number;
  perPage?: number;
  sort?: 'trending' | 'popularity' | 'score' | 'newest';
  search?: string;
  format?: string;
  status?: string;
  season?: string;
  seasonYear?: number;
  minScore?: number;
}

export const animeService = {
  /** Browse the AniCore index. */
  async browse(options: AnimeBrowseOptions = {}): Promise<{ items: MediaItem[]; hasMore: boolean; total: number }> {
    const page = Math.max(1, options.page || 1);
    const perPage = Math.min(50, Math.max(1, options.perPage || 24));
    const url = buildAniCoreUrl('/anime', {
      page,
      perPage,
      sort: options.sort,
      search: options.search?.trim() || undefined,
      format: options.format,
      status: options.status,
      season: options.season,
      seasonYear: options.seasonYear,
      minScore: options.minScore,
    });
    const data = await fetchJson<AniCorePage<AniCoreEntry>>(url, 'AniCore');
    return {
      items: mapAniCoreList(data.items),
      hasMore: Boolean(data.pageInfo?.hasNextPage),
      total: Number(data.pageInfo?.total) || 0,
    };
  },

  async trending(perPage = 20) {
    const result = await this.browse({ sort: 'trending', perPage });
    return result.items;
  },

  async topRated(perPage = 20) {
    const result = await this.browse({ sort: 'score', perPage });
    return result.items;
  },

  async thisSeason(perPage = 20, date = new Date()) {
    const { season, year } = currentAnimeSeason(date);
    const result = await this.browse({ season, seasonYear: year, sort: 'trending', perPage });
    return result.items;
  },

  async airing(perPage = 20) {
    const result = await this.browse({ status: 'RELEASING', sort: 'trending', perPage });
    return result.items;
  },

  async movies(perPage = 20) {
    const result = await this.browse({ format: 'MOVIE', sort: 'score', perPage });
    return result.items;
  },

  async search(query: string, page = 1, perPage = 24) {
    const term = query.trim();
    if (!term) return { items: [] as MediaItem[], hasMore: false, total: 0 };
    return this.browse({ search: term, page, perPage });
  },

  /** Full AniCore record for one show (adds synopsis, IMDb id, exact score, studios). */
  async getAnime(slug: string): Promise<AniCoreEntry | null> {
    const key = `anicore:anime:${slug}`;
    const cached = readCache<AniCoreEntry>(key);
    if (cached) return cached;
    const entry = await fetchJson<AniCoreEntry>(buildAniCoreUrl(`/anime/${encodeURIComponent(slug)}`, {}), 'AniCore');
    if (entry?.slug) writeCache(key, entry);
    return entry || null;
  },

  /** Episode guide for one show, grouped by AniCore season number. */
  async getEpisodes(slug: string, pages = 3): Promise<TmdbEpisodeInfo[]> {
    const key = `anicore:episodes:${slug}`;
    const cached = readCache<TmdbEpisodeInfo[]>(key);
    if (cached) return cached;
    const collected: AniCoreEpisode[] = [];
    for (let page = 1; page <= pages; page += 1) {
      const data = await fetchJson<AniCorePage<AniCoreEpisode> & { hasNextPage?: boolean }>(
        buildAniCoreUrl(`/anime/${encodeURIComponent(slug)}/episodes`, { page, perPage: 100 }),
        'AniCore',
      );
      if (Array.isArray(data.items)) collected.push(...data.items);
      if (!data.pageInfo?.hasNextPage) break;
    }
    const mapped = mapAniCoreEpisodes(slug, collected);
    writeCache(key, mapped);
    return mapped;
  },

  /** Character / voice-cast strip for the details modal. */
  async getCharacters(slug: string, limit = 10): Promise<MediaCastMember[]> {
    const key = `anicore:characters:${slug}`;
    const cached = readCache<MediaCastMember[]>(key);
    if (cached) return cached;
    const data = await fetchJson<AniCorePage<{
      id?: number; name?: string; role?: string; image?: string;
      voiceActors?: Array<{ name?: string; image?: string; language?: string }>;
    }>>(
      buildAniCoreUrl(`/anime/${encodeURIComponent(slug)}/characters`, { limit }),
      'AniCore',
    );
    const cast: MediaCastMember[] = (data.items || []).slice(0, limit).map((character, index) => {
      const japanese = (character.voiceActors || []).find((actor) => actor.language === 'Japanese')
        || (character.voiceActors || [])[0];
      return {
        id: Number(character.id) || index + 1,
        name: String(japanese?.name || character.name || 'Unknown'),
        character: String(character.name || ''),
        profile: japanese?.image || character.image || undefined,
      };
    });
    writeCache(key, cast);
    return cast;
  },

  async getRecommendations(slug: string, limit = 12): Promise<MediaItem[]> {
    const key = `anicore:recommendations:${slug}`;
    const cached = readCache<MediaItem[]>(key);
    if (cached) return cached;
    const data = await fetchJson<AniCorePage<{ anime?: AniCoreEntry }>>(
      buildAniCoreUrl(`/anime/${encodeURIComponent(slug)}/recommendations`, { limit }),
      'AniCore',
    );
    const items = mapAniCoreList((data.items || []).map((entry) => entry.anime).filter(Boolean) as AniCoreEntry[]);
    writeCache(key, items);
    return items;
  },

  /** Merge the full AniCore record (plus cast and recommendations) into a list item. */
  async enrich(item: MediaItem): Promise<MediaItem> {
    const slug = item.anime?.slug || (item.id.startsWith('anicore:') ? item.id.slice(8) : '');
    if (!slug) return item;
    const entry = await this.getAnime(slug).catch(() => null);
    const mapped = entry ? mapAniCoreItem(entry) : null;
    const [cast, recommendations] = await Promise.all([
      this.getCharacters(slug).catch(() => []),
      this.getRecommendations(slug).catch(() => []),
    ]);
    const merged: MediaItem = {
      ...item,
      ...(mapped ? {
        tmdbId: mapped.tmdbId || item.tmdbId,
        imdbId: item.imdbId || mapped.imdbId,
        title: mapped.title,
        overview: mapped.overview || item.overview,
        poster: mapped.poster || item.poster,
        backdrop: mapped.backdrop || item.backdrop,
        logo: mapped.logo || item.logo,
        year: mapped.year || item.year,
        rating: mapped.rating ?? item.rating,
        genres: mapped.genres.length ? mapped.genres : item.genres,
        runtime: mapped.runtime || item.runtime,
        maturity: mapped.maturity || item.maturity,
        trailerKey: mapped.trailerKey || item.trailerKey,
      } : {}),
      anime: {
        ...(item.anime || { slug }),
        ...(mapped?.anime || {}),
      },
      cast: cast.length ? cast : item.cast,
      recommendations: recommendations.length ? recommendations : item.recommendations,
    };

    if (merged.type === 'series') {
      const episodes = await this.getEpisodes(slug).catch(() => []);
      if (episodes.length) {
        merged.seasons = seasonsFromEpisodes(slug, episodes);
        merged.numberOfSeasons = merged.seasons.length;
        merged.anime = { ...merged.anime!, episodeCount: episodes.length };
      }
    }
    return merged;
  },

  /**
   * Find the AniCore record for a TMDB / Stremio / IMDb title so anime discussions
   * and episode data are available outside the Anime tab too.
   */
  async findForMedia(item: MediaItem): Promise<MediaItem | null> {
    if (item.anime?.slug) return this.enrich(item).catch(() => item);
    if (item.source === 'anicore') return this.enrich(item).catch(() => item);
    const term = item.title;
    if (!term) return null;
    try {
      const { items } = await this.search(term, 1, 8);
      if (!items.length) return null;
      const targetYear = Number(item.year) || 0;
      const scored = items
        .map((candidate) => {
          const sameYear = targetYear && Number(candidate.year) === targetYear ? 3 : 0;
          const sameTmdb = item.tmdbId && candidate.tmdbId === item.tmdbId ? 10 : 0;
          const sameImdb = item.imdbId && candidate.imdbId === item.imdbId ? 10 : 0;
          const exact = candidate.title.toLowerCase() === item.title.toLowerCase() ? 2 : 0;
          return { candidate, score: sameTmdb + sameImdb + sameYear + exact };
        })
        .sort((a, b) => b.score - a.score);
      if (!scored[0] || scored[0].score < 3) return null;
      return await this.enrich(scored[0].candidate);
    } catch {
      return null;
    }
  },
};

/** Anikura only accepts one show id, so pass the most precise identifier available. */
export function anikuraIds(item: MediaItem): AnikuraIds {
  if (item.anime?.malId) return { mal: item.anime.malId };
  if (item.anime?.anilistId) return { anilist: item.anime.anilistId };
  if (item.tmdbId) return { tmdb: Number(item.tmdbId) };
  if (item.anime?.anikuraId) return { id: item.anime.anikuraId };
  return {};
}

export function hasAnikuraId(item: MediaItem): boolean {
  const ids = anikuraIds(item);
  return Boolean(ids.mal || ids.anilist || ids.tmdb || ids.id);
}

export const anikuraService = {
  /** Full Anikura catalog record (episode titles, synopsis, artwork, ids). */
  async getCatalog(ids: AnikuraIds): Promise<AnikuraCatalog | null> {
    if (!ids.mal && !ids.anilist && !ids.tmdb && !ids.id) return null;
    const key = `anikura:catalog:${JSON.stringify(ids)}`;
    const cached = readCache<AnikuraCatalog | null>(key);
    if (cached !== undefined) return cached;
    try {
      const data = await fetchJson<{ ok?: boolean; data?: AnikuraCatalog; error?: string }>(
        buildAnikuraUrl('/catalog', ids as Record<string, number | undefined>),
        'Anikura',
      );
      const value = data?.ok && data.data ? data.data : null;
      writeCache(key, value);
      return value;
    } catch {
      writeCache(key, null);
      return null;
    }
  },

  /** Episode discussion pulled from MyAnimeList forums, Anikoto and Reanime. */
  async getComments(
    ids: AnikuraIds,
    episode: number,
    options: { sort?: 'top' | 'newest'; limit?: number; offset?: number } = {},
  ): Promise<{ series?: AnikuraSeries; comments: AnikuraComment[]; total: number }> {
    if (!ids.mal && !ids.anilist && !ids.tmdb && !ids.id) return { comments: [], total: 0 };
    if (!Number.isFinite(episode) || episode < 1) return { comments: [], total: 0 };
    const key = `anikura:comments:${JSON.stringify(ids)}:${episode}:${options.sort || 'top'}:${options.limit || 30}:${options.offset || 0}`;
    const cached = readCache<{ series?: AnikuraSeries; comments: AnikuraComment[]; total: number }>(key);
    if (cached) return cached;
    try {
      const data = await fetchJson<{
        ok?: boolean; series?: AnikuraSeries; comments?: AnikuraComment[];
        page?: { total?: number };
      }>(
        buildAnikuraUrl('/comments', {
          ...ids,
          episode,
          sort: options.sort || 'top',
          limit: options.limit || 30,
          offset: options.offset || 0,
        } as Record<string, string | number | undefined>),
        'Anikura',
      );
      const value = {
        series: data?.series,
        comments: Array.isArray(data?.comments) ? data.comments : [],
        total: Number(data?.page?.total) || (Array.isArray(data?.comments) ? data.comments.length : 0),
      };
      writeCache(key, value);
      return value;
    } catch {
      const empty = { comments: [], total: 0 };
      writeCache(key, empty);
      return empty;
    }
  },
};

/** Test hook: clears the in-memory response cache. */
export function clearAnimeCache() {
  cache.clear();
}
