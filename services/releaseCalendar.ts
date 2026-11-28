import { nativeFetchText } from './androidBridge';
import { getTmdbApiKey } from './tmdbConfig';
import { GENRES, tmdbImage } from './tmdbService';

/**
 * Release calendar — port of Hikari's AnimeReleaseCalendarRepository.kt and
 * ReleaseCalendarRepository.kt (GPL-3.0).
 *
 * Anime comes from SIMKL's public calendar. Hikari prefers the v2 endpoint
 * (which needs a SIMKL tracker client_id) and falls back to the legacy
 * endpoint; PRAHA has no SIMKL client, so it uses the legacy endpoint only.
 * Movies and series come from TMDB (/movie/upcoming, /tv/on_the_air,
 * /tv/airing_today) grouped into day buckets with Today/Tomorrow labels.
 * Both layers cache for 3 hours, matching the Kotlin originals.
 */

// ── Anime (SIMKL) ─────────────────────────────────────────────────────────────

export interface AnimeRelease {
  simklId: number;
  title: string;
  titleRomaji?: string;
  poster?: string;
  airAt: number;
  episode?: number;
  episodeTitle?: string;
  finaleType?: number;
  totalEpisodes?: number;
  status?: string;
  tmdbId?: string;
  anilistId?: string;
  url?: string;
}

const SIMKL_LEGACY_URL = 'https://data.simkl.in/calendar/anime.json';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;

interface CacheEntry<T> { at: number; items: T }

let animeCache: CacheEntry<AnimeRelease[]> | null = null;

function epochFromIso(iso: string): number | null {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickDateField(o: Record<string, unknown>): string {
  for (const key of ['airing_at', 'airingAt', 'release_date', 'releaseDate', 'date']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** Port of the legacy SIMKL parse: an array of entries, each with an `anime` object. */
export function parseLegacySimkl(raw: string): AnimeRelease[] {
  let root: unknown;
  try { root = JSON.parse(raw); } catch { return []; }
  const list = Array.isArray(root)
    ? root
    : Array.isArray((root as Record<string, unknown>)?.anime)
      ? (root as Record<string, unknown>).anime as unknown[]
      : Array.isArray((root as Record<string, unknown>)?.items)
        ? (root as Record<string, unknown>).items as unknown[]
        : [];
  const out: AnimeRelease[] = [];
  for (const entry of list) {
    const o = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
    if (!o) continue;
    const media = o.anime && typeof o.anime === 'object' && !Array.isArray(o.anime)
      ? o.anime as Record<string, unknown>
      : null;
    const title = String(media?.title ?? media?.name ?? '').trim();
    if (!title) continue;
    const date = pickDateField(o) || String(media?.airing_at ?? '');
    const at = date ? epochFromIso(date) : null;
    if (at === null) continue;
    const ids = media?.ids && typeof media.ids === 'object' && !Array.isArray(media.ids)
      ? media.ids as Record<string, unknown>
      : null;
    const id = typeof ids?.simkl === 'number' ? ids.simkl : Number(o.id ?? 0) || 0;
    out.push({ simklId: id, title, airAt: at });
  }
  return out.sort((a, b) => a.airAt - b.airAt);
}

export async function loadAnimeCalendar(): Promise<AnimeRelease[]> {
  const now = Date.now();
  if (animeCache && now - animeCache.at < CACHE_TTL_MS) return animeCache.items;
  const answer = await nativeFetchText(SIMKL_LEGACY_URL, { timeoutMs: 30000 });
  const parsed = answer.data ? parseLegacySimkl(answer.data) : [];
  if (parsed.length) animeCache = { at: now, items: parsed };
  return parsed.length ? parsed : animeCache?.items ?? [];
}

// ── Movies and series (TMDB) ──────────────────────────────────────────────────

export type CalendarKind = 'movie' | 'tv' | 'episode';

export interface CalendarEntry {
  kind: CalendarKind;
  tmdbId: number;
  title: string;
  year?: string;
  poster?: string;
  genres: string[];
  blurb?: string;
  dateMillis: number;
  dateLabel: string;
  raw: Record<string, unknown>;
}

export interface DayGroup { label: string; sortKey: number; entries: CalendarEntry[] }

export const CALENDAR_COUNTRIES: Array<[string, string]> = [
  ['US', 'United States'], ['IN', 'India'], ['GB', 'United Kingdom'], ['JP', 'Japan'],
  ['KR', 'South Korea'], ['FR', 'France'], ['DE', 'Germany'], ['ES', 'Spain'],
  ['IT', 'Italy'], ['BR', 'Brazil'], ['MX', 'Mexico'], ['CA', 'Canada'],
  ['AU', 'Australia'], ['AE', 'UAE'], ['SA', 'Saudi Arabia'], ['TR', 'Turkiye'],
  ['RU', 'Russia'], ['CN', 'China'], ['TW', 'Taiwan'], ['TH', 'Thailand'],
];

export function countryName(code: string): string {
  return CALENDAR_COUNTRIES.find(([c]) => c === code)?.[1] ?? code;
}

const tmdbCaches = new Map<string, CacheEntry<DayGroup[]>>();

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function dayMillis(iso: string): number | null {
  const dateOnly = iso.slice(0, 10);
  const parsed = Date.parse(`${dateOnly}T00:00:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function dayLabel(millis: number): string {
  const date = new Date(millis);
  const fmtDate = `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()]} ${String(date.getDate()).padStart(2, '0')}, ${date.getFullYear()}`;
  const today = new Date(startOfToday());
  const tomorrow = new Date(today.getTime() + 86400000);
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  if (same(date, today)) return `Today, ${fmtDate}`;
  if (same(date, tomorrow)) return `Tomorrow, ${fmtDate}`;
  return `${weekday}, ${fmtDate}`;
}

function group(entries: CalendarEntry[]): DayGroup[] {
  const byDay = new Map<number, CalendarEntry[]>();
  for (const entry of entries) {
    const list = byDay.get(entry.dateMillis) ?? [];
    list.push(entry);
    byDay.set(entry.dateMillis, list);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([millis, list]) => ({ label: dayLabel(millis), sortKey: millis, entries: [...list].sort((a, b) => a.title.localeCompare(b.title)) }));
}

async function tmdbGet(path: string, params: Record<string, string>): Promise<Record<string, unknown> | null> {
  const apiKey = getTmdbApiKey();
  if (!apiKey) return null;
  const query = new URLSearchParams({ api_key: apiKey, ...params });
  try {
    const response = await fetch(`https://api.themoviedb.org/3${path}?${query.toString()}`);
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function genresOf(raw: Record<string, unknown>, kind: 'movie' | 'tv'): string[] {
  const ids = Array.isArray(raw.genre_ids) ? raw.genre_ids : [];
  return ids
    .map((id) => (typeof id === 'number' ? GENRES[id] : undefined))
    .filter((name): name is string => Boolean(name))
    .slice(0, 3);
}

function parseMovie(raw: Record<string, unknown>): CalendarEntry | null {
  const id = typeof raw.id === 'number' ? raw.id : 0;
  const title = String(raw.title ?? '').trim() || String(raw.original_title ?? '').trim();
  if (!id || !title) return null;
  const date = String(raw.release_date ?? '');
  const millis = dayMillis(date);
  if (millis === null) return null;
  return {
    kind: 'movie',
    tmdbId: id,
    title,
    year: /^\d/.test(date.slice(0, 4)) ? date.slice(0, 4) : undefined,
    poster: tmdbImage(String(raw.poster_path ?? ''), 'w500') ?? undefined,
    genres: genresOf(raw, 'movie'),
    blurb: String(raw.overview ?? '').trim() || undefined,
    dateMillis: millis,
    dateLabel: dayLabel(millis),
    raw,
  };
}

function parseTv(raw: Record<string, unknown>, kind: 'tv' | 'episode', region: string): CalendarEntry | null {
  const id = typeof raw.id === 'number' ? raw.id : 0;
  const title = String(raw.name ?? '').trim();
  if (!id || !title) return null;
  const millis = startOfToday();
  const firstAir = String(raw.first_air_date ?? '').trim();
  const blurb = kind === 'episode'
    ? `Airing today · ${countryName(region)}`
    : String(raw.overview ?? '').trim() || undefined;
  return {
    kind,
    tmdbId: id,
    title,
    year: /^\d/.test(firstAir.slice(0, 4)) ? firstAir.slice(0, 4) : undefined,
    poster: tmdbImage(String(raw.poster_path ?? ''), 'w500') ?? undefined,
    genres: genresOf(raw, 'tv'),
    blurb,
    dateMillis: millis,
    dateLabel: dayLabel(millis),
    raw,
  };
}

async function loadMovies(region: string): Promise<CalendarEntry[]> {
  const out: CalendarEntry[] = [];
  const upper = region.toUpperCase();
  for (let page = 1; page <= 3; page++) {
    const data = await tmdbGet('/movie/upcoming', { region: upper, page: String(page) });
    const results = Array.isArray(data?.results) ? data.results as Record<string, unknown>[] : [];
    if (!results.length) break;
    for (const raw of results) {
      const entry = parseMovie(raw);
      if (entry) out.push(entry);
    }
    const totalPages = typeof data?.total_pages === 'number' ? data.total_pages : 1;
    if (page >= totalPages) break;
  }
  const seen = new Set<number>();
  const floor = startOfToday() - 86400000;
  return out
    .filter((entry) => { if (seen.has(entry.tmdbId)) return false; seen.add(entry.tmdbId); return true; })
    .filter((entry) => entry.dateMillis >= floor)
    .slice(0, 90);
}

async function loadTv(path: string, region: string, kind: 'tv' | 'episode'): Promise<CalendarEntry[]> {
  const out: CalendarEntry[] = [];
  for (let page = 1; page <= 3; page++) {
    const data = await tmdbGet(path, { region: region.toUpperCase(), page: String(page) });
    const results = Array.isArray(data?.results) ? data.results as Record<string, unknown>[] : [];
    if (!results.length) break;
    for (const raw of results) {
      const entry = parseTv(raw, kind, region);
      if (entry) out.push(entry);
    }
    const totalPages = typeof data?.total_pages === 'number' ? data.total_pages : 1;
    if (page >= totalPages) break;
  }
  const seen = new Set<number>();
  return out.filter((entry) => { if (seen.has(entry.tmdbId)) return false; seen.add(entry.tmdbId); return true; });
}

export async function loadTmdbCalendar(kind: CalendarKind, region: string): Promise<DayGroup[]> {
  const key = `${kind}|${region.toUpperCase()}`;
  const now = Date.now();
  const cached = tmdbCaches.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.items;
  const entries = kind === 'movie'
    ? await loadMovies(region)
    : await loadTv(kind === 'tv' ? '/tv/on_the_air' : '/tv/airing_today', region, kind);
  const groups = group(entries);
  if (groups.length) tmdbCaches.set(key, { at: now, items: groups });
  return groups.length ? groups : cached?.items ?? [];
}

/** Group anime releases into day buckets for the same UI the TMDB side uses. */
export function groupAnime(releases: AnimeRelease[]): DayGroup[] {
  const byDay = new Map<number, AnimeRelease[]>();
  for (const release of releases) {
    const day = new Date(release.airAt);
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const list = byDay.get(dayStart) ?? [];
    list.push(release);
    byDay.set(dayStart, list);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([millis, list]) => ({
      label: dayLabel(millis),
      sortKey: millis,
      entries: [...list]
        .sort((a, b) => a.airAt - b.airAt)
        .map((release) => ({
          kind: 'episode' as const,
          tmdbId: Number(release.tmdbId ?? 0) || release.simklId,
          title: release.titleRomaji && release.titleRomaji !== release.title ? `${release.title} · ${release.titleRomaji}` : release.title,
          poster: release.poster,
          genres: [] as string[],
          blurb: release.episode
            ? `Episode ${release.episode}${release.episodeTitle ? ` · ${release.episodeTitle}` : ''}${release.finaleType ? ' · finale' : ''}`
            : release.status ?? undefined,
          dateMillis: release.airAt,
          dateLabel: dayLabel(millis),
          raw: release as unknown as Record<string, unknown>,
        })),
    }));
}
