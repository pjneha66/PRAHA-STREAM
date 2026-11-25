// Metadata addons: the details, episodes, collections and id-matching of the
// titles Stremio-format addons list.
//
// A port of VyseTV's `lib/data/catalog/meta_addons.dart` (GPL-3.0-or-later).
// Three quarters of that file's value is in the parts that are easy to skip and
// expensive to get wrong, so all of them are kept:
//
//   * the addon that listed a title is asked for its details first
//     (`_metaSources`), because a catalog-only addon knows nothing and an
//     unrelated addon may know a different title under the same id;
//   * a collection (TMDB Collections, and any addon that lists a set of films as
//     one entry) is detected by its videos not sharing the title's id, and each
//     film becomes a title of its own that opens, plays and is kept on its own;
//   * an addon title with no details anywhere is still a title: TMDB's copy is
//     looked up by IMDb id and then by name-and-year, and failing that the
//     catalog's own stub is used, so the page always opens;
//   * the ids the stream addons are asked by (`tt…:s:e`, `kitsu:…:s`) are the
//     addon's own, not TMDB's — Kitsu especially counts episodes differently,
//     which is why `tmdbEpisode` exists.
//
// PRAHA has no `Tmdb.details` equivalent, so the TMDB fallback is composed from
// `tmdbService.enrich` (which already returns a MediaItem with cast, seasons,
// trailer and certification) plus `getSeason` for the episodes.

import type { AddonVideo, InstalledAddon, MediaCastMember, MediaItem, TmdbEpisodeInfo, TmdbSeasonSummary } from '../types';
import { nativeFetchText } from './androidBridge';
import * as pluginCatalogs from './pluginCatalogs';
import { tmdbService } from './tmdbService';

/** A title's details as a metadata addon gives them. */
export interface AddonMeta {
  /** The title as its details page shows it, enriched as far as the addon goes. */
  media: MediaItem;
  /** Every episode, by season and then number. */
  videos: AddonVideo[];
  /** What the stream addons are asked for it as (the details' own type). */
  type: string;
  /** The addon the details came from. */
  from: InstalledAddon | null;
  logo?: string;
  imdb?: string;
  /** The one video a film-like title plays (`behaviorHints.defaultVideoId`). */
  defaultVideo?: string;
  /**
   * A collection's films, each a title of its own. Empty for anything else —
   * check `parts.length`, never `Boolean(parts)`.
   */
  parts: MediaItem[];
}

/** What the stream and subtitle addons are asked for a title (or one episode). */
export interface AddonTarget {
  type: string;
  /** The title's own addon id (`tt0944947`, `kitsu:7442`, `pl:…`). */
  raw: string;
  /** The video's id, when the title is one video (`tt0944947:1:1`). */
  video?: string;
  imdb?: string;
  tmdb?: number;
  season?: number;
  episode?: number;
  imdbSeason?: number;
  imdbEpisode?: number;
  title: string;
  year?: number;
  videos: AddonVideo[];
  /** Streams the addon put inside the video itself. */
  inline: Array<Record<string, unknown>>;
  inlineFrom?: InstalledAddon;
}

/** The addon's own type words that mean a show. */
const SERIES_LIKE = new Set(['series', 'anime', 'channel']);

const isSeriesLike = (type?: string) => Boolean(type && SERIES_LIKE.has(type));

// What catalogs and details said about titles, kept for this run: their logo
// art, their IMDb id, and which addon listed them (asked first for details).
const logos = new Map<string, string>();
const imdbIds = new Map<string, string>();
const origins = new Map<string, string>();

/** Every answer, shared while it is on its way and kept for the run. */
const answers = new Map<string, Promise<unknown>>();
/** Bounded: a long browsing session must not pin every addon page it ever read. */
const ANSWER_CAP = 160;

function memo<T>(key: string, fetch: () => Promise<T>): Promise<T> {
  const had = answers.get(key);
  if (had) return had as Promise<T>;
  const job = fetch();
  answers.set(key, job);
  // A failed answer is forgotten so the next call asks again, rather than
  // serving the failure for the rest of the session.
  job.catch(() => {
    if (answers.get(key) === job) answers.delete(key);
  });
  while (answers.size > ANSWER_CAP) {
    const oldest = answers.keys().next();
    if (oldest.done) break;
    answers.delete(oldest.value);
  }
  return job;
}

/** Test seam: forget everything this module remembered. */
export function resetMetaAddons(): void {
  answers.clear();
  logos.clear();
  imdbIds.clear();
  origins.clear();
}

async function getJson(url: string): Promise<unknown> {
  const response = await nativeFetchText(url, {
    headers: { Accept: 'application/json' },
    timeoutMs: 20000,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = (response.data || '').trim();
  if (!text) throw new Error('The addon returned an empty response.');
  if (text.startsWith('<')) throw new Error('This addon returned an HTML page instead of JSON.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('This addon returned malformed JSON.');
  }
}

// ── small coercion helpers ──

const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** A picture: a full address, or a TMDB picture path (`/abc.jpg`). */
function picture(value: unknown): string | undefined {
  const s = text(value);
  if (s.startsWith('http')) return s;
  if (s.startsWith('/') && s.length > 1) return `https://image.tmdb.org/t/p/w500${s}`;
  return undefined;
}

function httpUrl(value: unknown): string | undefined {
  const s = text(value);
  return s.startsWith('http') ? s : undefined;
}

function positive(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/** TMDB's id for an addon title, when the addon gives it. */
function tmdbOf(id: string, raw: Record<string, unknown>): number | undefined {
  if (id.startsWith('tmdb:')) return positive(id.slice(5).split(':')[0]);
  return positive(raw.moviedb_id) ?? positive(raw.tmdb_id) ?? positive(raw.tmdbId);
}

/** Minutes from "57 min", "1h 42min" or a plain number. */
export function minutes(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 0 ? Math.trunc(value) : undefined;
  const s = text(value).toLowerCase();
  if (!s) return undefined;
  const hours = s.match(/(\d+)\s*h/);
  const mins = s.match(/(\d+)\s*m/);
  const total = (hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0);
  if (total > 0) return total;
  return positive(s.trim());
}

/** `1h 42m`, the shape PRAHA's details rows use. */
function runtimeLabel(value: unknown): string | undefined {
  const total = minutes(value);
  if (!total) return undefined;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (!hours) return `${mins}m`;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

/** An id or type as a path segment, with its colons left as Stremio sends them. */
export function segment(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ':');
}

// ── titles ──

/**
 * A title from a catalog or a details answer, as the app shows titles. Null
 * when it has no id or name — a catalog row that cannot be opened is not a row.
 */
export function mediaFromAddon(
  raw: unknown,
  options: { type?: string; from?: InstalledAddon } = {},
): MediaItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = text(record.id ?? record.imdb_id).trim();
  const name = text(record.name ?? record.title).trim();
  if (!id || !name) return null;

  const kind = text(record.type ?? options.type ?? 'movie').trim();
  const released = text(record.released);
  const info = text(record.releaseInfo ?? record.year);
  const year = (info || released).match(/(1[89]|20)\d\d/)?.[0];
  const videos = Array.isArray(record.videos) ? record.videos : [];
  const imdb = text(record.imdb_id);
  const tmdbId = tmdbOf(id, record);

  const item: MediaItem = {
    id,
    tmdbId,
    imdbId: imdb.startsWith('tt') ? imdb : id.startsWith('tt') ? id.split(':')[0] : undefined,
    type: isSeriesLike(kind) || isEpisodic(id, videos) ? 'series' : 'movie',
    // The addon's own word is kept: it is what the addon is asked by, and an
    // anime/channel addon will not answer a request for a "series".
    addonType: kind,
    title: name,
    overview: text(record.description ?? record.overview).trim(),
    poster: picture(record.poster) ?? '',
    backdrop: picture(record.background),
    year,
    rating: Number(text(record.imdbRating)) || undefined,
    genres: [],
    source: 'stremio',
    addonUrl: options.from?.manifestUrl,
  };

  const logo = httpUrl(record.logo);
  if (logo) logos.set(item.id, logo);
  if (imdb.startsWith('tt')) imdbIds.set(item.id, imdb);
  if (options.from) {
    if (!origins.has(item.id)) origins.set(item.id, options.from.manifestUrl);
  }
  return item;
}

/** A title made from a link or an id alone; its page fills in the rest. */
export function bareAddonMedia(type: string, id: string): MediaItem {
  return {
    id,
    tmdbId: tmdbOf(id, {}),
    imdbId: id.startsWith('tt') ? id.split(':')[0] : undefined,
    type: isSeriesLike(type) ? 'series' : 'movie',
    addonType: type,
    title: '',
    overview: '',
    poster: '',
    genres: [],
    source: 'stremio',
  };
}

// More than one video, and they are the title's own (`tt0944947:1:1` under
// `tt0944947`), not other titles (a collection's films).
function isEpisodic(id: string, videos: unknown[]): boolean {
  const ids = videos
    .map((video) => (video && typeof video === 'object' ? text((video as Record<string, unknown>).id) : ''))
    .filter(Boolean);
  return ids.length > 1 && ids.some((videoId) => videoId.startsWith(id));
}

/** What a catalog of `type` lists, for headings. */
export function typeLabel(type: string): string {
  switch (type) {
    case 'movie': return 'Movies';
    case 'series': return 'Series';
    case 'anime': return 'Anime';
    case 'channel': return 'Channels';
    case 'tv': return 'TV channels';
    case 'other': return 'Videos';
    case 'collections':
    case 'collection': return 'Collections';
    case '': return 'Titles';
    default: return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

/** "Popular · Movies": a catalog's name and what it lists. */
export function catalogTitle(catalog: { name?: string; type: string }): string {
  const name = (catalog.name || '').trim() || typeLabel(catalog.type);
  const kind = typeLabel(catalog.type);
  const lower = name.toLowerCase();
  if (lower.includes(kind.toLowerCase()) || lower.includes(catalog.type.toLowerCase())) return name;
  return `${name} · ${kind}`;
}

// ── details ──

/**
 * The addons that are on and give the details of `item`: the one that listed it
 * first, then the rest in install order.
 *
 * Matched the way the addon declared itself (`metaTypes` / `metaPrefixes`),
 * because that is what it will actually answer: an addon that only gives
 * details for `tt…` ids must not be asked for a `kitsu:…` title, and asking
 * anyway costs a round trip and a misleading failure.
 */
function metaSources(item: MediaItem, addons: InstalledAddon[]): InstalledAddon[] {
  const type = addonTypeOf(item);
  const origin = origins.get(item.id);
  const eligible = addons.filter((addon) => {
    // The catalog switch is the browse-page toggle; details are the addon's
    // `meta` resource and stay on with it, or a title turned off for browsing
    // would lose its page and its playback.
    if (!addon.enabled) return false;
    const resource = addon.manifest.resources.find((entry) => entry.name === 'meta');
    if (!resource) return false;
    // A resource that names no types or prefixes inherits the manifest's own.
    const types = resource.types?.length ? resource.types : addon.manifest.types ?? [];
    const prefixes = resource.idPrefixes?.length ? resource.idPrefixes : addon.manifest.idPrefixes ?? [];
    const takesType = !types.length || types.includes(type);
    const takesId = !prefixes.length || prefixes.some((prefix) => item.id.startsWith(prefix));
    return takesType && takesId;
  });
  // A stable sort is enough: the origin addon goes first, everything else keeps
  // the user's install order.
  return eligible.slice().sort((a, b) => {
    const aOrigin = a.manifestUrl === origin ? 1 : 0;
    const bOrigin = b.manifestUrl === origin ? 1 : 0;
    return bOrigin - aOrigin;
  });
}

/** The addon type a title is asked by ("series" for anything show-like). */
export function addonTypeOf(item: MediaItem): string {
  if (item.addonType) return item.addonType;
  return item.type === 'series' ? 'series' : 'movie';
}

/**
 * `item`'s details from the first addon that has them (the one it came from
 * first). When no addon has them — a catalog-only addon, like a list — TMDB's,
 * while TMDB is on and knows the title; else the catalog's own copy. Its page
 * opens and it plays either way.
 */
export function meta(item: MediaItem, addons: InstalledAddon[]): Promise<AddonMeta> {
  return memo(`meta|${item.addonUrl || ''}|${item.id}`, async () => {
    const type = addonTypeOf(item);
    let failure: unknown;
    let answered = false;
    for (const addon of metaSources(item, addons)) {
      try {
        // A plugin repository answers its own titles' details by asking the
        // plugin that listed them (VyseTV's `PluginCatalogs.meta`).
        const payload = addon.plugins
          ? await pluginCatalogs.meta(addon, type, item.id)
          : await getJson(metaUrl(addon, type, item.id));
        answered = true;
        const raw = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).meta : null;
        if (raw && typeof raw === 'object' && Object.keys(raw).length) {
          return parseMeta(raw as Record<string, unknown>, item, addon);
        }
      } catch (error) {
        failure = error;
      }
    }
    // Every addon asked failed to answer: try again another time rather than
    // quietly showing less than the addon knows.
    if (failure && !answered) throw failure;

    try {
      const fromTmdbDetails = await fromTmdb(item, addons);
      if (fromTmdbDetails) return fromTmdbDetails;
    } catch { /* TMDB is optional; a miss is not an error. */ }

    const from = addons.find((addon) => addon.manifestUrl === origins.get(item.id)) ?? null;
    return parseMeta({ id: item.id, type, name: item.title }, item, from);
  });
}

function metaUrl(addon: InstalledAddon, type: string, id: string): string {
  const url = new URL(addon.manifestUrl);
  url.pathname = url.pathname.replace(/\/manifest\.json$/, '');
  const query = url.search;
  url.pathname = `${url.pathname.replace(/\/$/, '')}/meta/${segment(type)}/${segment(id)}.json`;
  url.search = '';
  return `${url.toString()}${query}`;
}

/** Its logo art: as its catalog or details gave it (nothing is asked for it here). */
export async function addonLogo(item: MediaItem): Promise<string | undefined> {
  const known = logos.get(item.id);
  if (known) return known;
  const running = answers.get(`meta|${item.addonUrl || ''}|${item.id}`);
  if (!running) return undefined;
  try {
    return ((await running) as AddonMeta).logo;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => text(entry).trim()).filter(Boolean);
  const s = text(value).trim();
  return s ? s.split(',').map((entry) => entry.trim()).filter(Boolean) : [];
}

function parseMeta(raw: Record<string, unknown>, base: MediaItem, from: InstalledAddon | null): AddonMeta {
  const own = mediaFromAddon(raw, { type: addonTypeOf(base), from: from ?? undefined });
  const kind = text(raw.type ?? addonTypeOf(base) ?? 'movie');
  const videos = parseVideos(raw.videos);
  const id = base.id;
  const hints = raw.behaviorHints && typeof raw.behaviorHints === 'object'
    ? (raw.behaviorHints as Record<string, unknown>)
    : {};

  // A collection: its videos are other titles (TMDB Collections lists each film
  // by its own IMDb id), not its own episodes. A series, an anime or a channel
  // is never one.
  const parted = !isSeriesLike(kind)
    && hints.defaultVideoId === undefined
    && videos.length > 1
    && videos.every((video) => !video.id.startsWith(id));
  const parts = parted ? videos.map((video) => partToMedia(video, base.addonUrl)) : [];
  const episodic = !parted && (isSeriesLike(kind) || videos.length > 1);

  const links = Array.isArray(raw.links)
    ? (raw.links as unknown[]).filter((link): link is Record<string, unknown> => Boolean(link) && typeof link === 'object' && (link as Record<string, unknown>).name != null)
    : [];
  const linked = (category: string) => links
    .filter((link) => text(link.category).toLowerCase() === category)
    .map((link) => text(link.name).trim())
    .filter(Boolean);
  const either = (value: unknown, category: string) => {
    const list = stringList(value);
    return list.length ? list : linked(category);
  };

  const genres = Array.from(new Set([...stringList(raw.genres), ...stringList(raw.genre)]));
  const cast = either(raw.cast, 'cast');

  const bySeason = new Map<number, AddonVideo[]>();
  for (const video of parted ? [] : videos) {
    const bucket = bySeason.get(video.season);
    if (bucket) bucket.push(video);
    else bySeason.set(video.season, [video]);
  }
  // Specials stay out when there are real seasons, as on TMDB's pages.
  const numbers = Array.from(bySeason.keys())
    .filter((number) => number > 0 || bySeason.size === 1)
    .sort((a, b) => a - b);
  const seasons: TmdbSeasonSummary[] = numbers.map((number) => {
    const episodes = bySeason.get(number) ?? [];
    return {
      id: number,
      seasonNumber: number,
      name: number === 0 ? 'Episodes' : `Season ${number}`,
      episodeCount: episodes.length,
      airDate: episodes.map((episode) => episode.released).find(Boolean),
    };
  });

  const trailerKey = firstYoutubeKey(raw);
  const imdb = text(raw.imdb_id).startsWith('tt')
    ? text(raw.imdb_id)
    : id.startsWith('tt') ? id.split(':')[0] : imdbIds.get(id);
  const logo = httpUrl(raw.logo) ?? logos.get(id);

  const title = (own?.title || '').trim() ? own!.title : base.title;
  const item: MediaItem = {
    ...base,
    id: base.id,
    // The catalog's copy fills what the details leave out; the key (its addon
    // id) stays the catalog's so a stream request still names the same title.
    tmdbId: (own?.tmdbId ?? 0) > 0 ? own!.tmdbId : base.tmdbId,
    imdbId: imdb,
    type: episodic ? 'series' : 'movie',
    addonType: kind,
    title,
    overview: (own?.overview || '').trim() ? own!.overview : base.overview,
    poster: own?.poster || base.poster,
    backdrop: own?.backdrop || base.backdrop || parts.map((part) => part.backdrop).find(Boolean),
    logo,
    rating: (own?.rating ?? 0) > 0 ? own!.rating : base.rating,
    year: own?.year || base.year,
    runtime: parted ? undefined : runtimeLabel(raw.runtime),
    genres: genres.length ? genres : linked('genres'),
    maturity: typeof raw.certification === 'string' && raw.certification ? raw.certification : base.maturity,
    status: typeof raw.status === 'string' && raw.status.trim()
      ? raw.status.trim().charAt(0).toUpperCase() + raw.status.trim().slice(1)
      : base.status,
    director: either(raw.director, 'directors').slice(0, 3).join(', ') || base.director,
    cast: cast.length
      ? cast.slice(0, 24).map((name): MediaCastMember => ({ id: 0, name }))
      : base.cast,
    trailerKey: trailerKey || base.trailerKey,
    seasons: seasons.length ? seasons : base.seasons,
    numberOfSeasons: episodic && numbers.some((number) => number > 0)
      ? numbers.filter((number) => number > 0).length
      : base.numberOfSeasons,
    addonUrl: base.addonUrl,
    source: 'stremio',
  };

  return {
    media: item,
    videos,
    type: kind,
    from,
    logo,
    imdb,
    defaultVideo: typeof hints.defaultVideoId === 'string' ? hints.defaultVideoId : undefined,
    parts,
  };
}

/** The first YouTube trailer a details answer carries, as a key. */
function firstYoutubeKey(raw: Record<string, unknown>): string | undefined {
  const streams = Array.isArray(raw.trailerStreams) ? raw.trailerStreams : [];
  for (const entry of streams) {
    if (entry && typeof entry === 'object') {
      const key = text((entry as Record<string, unknown>).ytId);
      if (key) return key;
    }
  }
  const trailers = Array.isArray(raw.trailers) ? raw.trailers : [];
  for (const entry of trailers) {
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const source = text(record.source);
      // `trailers` carries either a YouTube id or a full address; only the key
      // form is playable as a trailer.
      if (source && !source.includes('/')) return source;
    }
  }
  return undefined;
}

/** A collection's film as a title of its own. */
function partToMedia(video: AddonVideo, addonUrl?: string): MediaItem {
  const imdb = video.id.startsWith('tt') ? video.id.split(':')[0] : undefined;
  const tmdbId = video.tmdbId ?? (video.id.startsWith('tmdb:') ? positive(video.id.slice(5).split(':')[0]) : undefined);
  const released = video.released && Number(video.released.slice(0, 4)) < 2900 ? video.released : undefined;
  const item: MediaItem = {
    id: video.id,
    tmdbId,
    imdbId: imdb,
    type: 'movie',
    addonType: 'movie',
    title: video.name,
    overview: video.overview,
    poster: video.poster ?? (imdb ? `https://images.metahub.space/poster/medium/${imdb}/img` : ''),
    backdrop: video.thumbnail,
    year: released ? released.slice(0, 4) : undefined,
    genres: [],
    source: 'stremio',
    // The film is opened and played on its own, so it has to carry the addon it
    // came from — that is what its own details and sources are asked through.
    addonUrl,
  };
  if (imdb) imdbIds.set(item.id, imdb);
  return item;
}

/**
 * The episodes in a details answer, by season and number. A run with no seasons
 * (a channel's videos) is season 0, numbered from the oldest.
 */
export function parseVideos(raw: unknown): AddonVideo[] {
  const list = (Array.isArray(raw) ? raw : []).filter((video): video is Record<string, unknown> => Boolean(video) && typeof video === 'object');

  // A collection's film with no id of its own goes by TMDB's, when the addon says.
  const idOf = (video: Record<string, unknown>) => {
    const id = text(video.id).trim();
    const tmdb = positive(video.tmdbId ?? video.tmdb_id);
    return id || (tmdb ? `tmdb:${tmdb}` : '');
  };
  const usable = list.filter((video) => idOf(video) !== '');
  const seasoned = usable.some((video) => typeof video.season === 'number');
  const number = (value: unknown) => (typeof value === 'number' ? Math.trunc(value) : positive(value));
  const when = (video: Record<string, unknown>) => {
    const value = text(video.released ?? video.firstAired);
    return value.match(/^\d{4}-\d\d-\d\d/) ? value.slice(0, 10) : undefined;
  };

  if (!seasoned) {
    usable.sort((a, b) => (when(a) ?? '9999').localeCompare(when(b) ?? '9999'));
  }

  const seen = new Set<string>();
  const out: AddonVideo[] = [];
  usable.forEach((video, index) => {
    const season = seasoned ? number(video.season) ?? 0 : 0;
    const episode = seasoned ? number(video.episode) ?? number(video.number) ?? index + 1 : index + 1;
    const key = `${season}:${episode}`;
    if (seen.has(key)) return;
    seen.add(key);
    const name = text(video.title ?? video.name).trim();
    out.push({
      id: idOf(video),
      season,
      episode,
      name: name || `Episode ${episode}`,
      overview: text(video.overview ?? video.description).trim(),
      thumbnail: picture(video.thumbnail),
      poster: picture(video.poster),
      released: when(video),
      runtime: minutes(video.runtime),
      imdbSeason: number(video.imdbSeason),
      imdbEpisode: number(video.imdbEpisode),
      tmdbId: positive(video.tmdbId ?? video.tmdb_id ?? video.moviedb_id),
      inline: (Array.isArray(video.streams) ? video.streams : [])
        .filter((stream): stream is Record<string, unknown> => Boolean(stream) && typeof stream === 'object'),
    });
  });
  out.sort((a, b) => (a.season !== b.season ? a.season - b.season : a.episode - b.episode));
  return out;
}

// ── the TMDB fallback ──

/**
 * `item`'s details from TMDB, when no addon has them: the addon title as TMDB
 * knows it (its key stays the addon's), with a show's episodes from TMDB's
 * seasons. Null when TMDB does not know it.
 */
async function fromTmdb(item: MediaItem, addons: InstalledAddon[]): Promise<AddonMeta | null> {
  const twin = await match(item, null);
  if (!twin) return null;
  const isTv = twin.type === 'series';
  const enriched = await tmdbService.enrich({
    ...twin,
    // The merge must not leak TMDB's id back into the addon title's key.
    id: twin.id,
    title: item.title || twin.title,
    year: item.year,
  });
  const tmdbId = enriched.tmdbId;
  const imdb = imdbIds.get(item.id) ?? (item.id.startsWith('tt') ? item.id.split(':')[0] : undefined);

  const videos: AddonVideo[] = [];
  if (isTv && tmdbId) {
    const seasons = enriched.seasons ?? [];
    const lists = await Promise.all(seasons.map((season) => tmdbService
      .getSeason(tmdbId, season.seasonNumber)
      .catch(() => [] as TmdbEpisodeInfo[])));
    lists.forEach((episodes, index) => {
      const seasonNumber = seasons[index].seasonNumber;
      for (const episode of episodes) {
        const number = positive(episode.episode);
        if (number == null) continue;
        videos.push({
          id: imdb ? `${imdb}:${seasonNumber}:${number}` : `tmdb:${tmdbId}:${seasonNumber}:${number}`,
          season: seasonNumber,
          episode: number,
          name: episode.title || `Episode ${number}`,
          overview: episode.overview || '',
          thumbnail: episode.still,
          released: episode.airDate,
          runtime: episode.runtime,
          imdbSeason: seasonNumber,
          imdbEpisode: number,
          inline: [],
        });
      }
    });
  }

  const merged: MediaItem = {
    ...enriched,
    id: item.id,
    imdbId: imdb ?? enriched.imdbId,
    poster: item.poster || enriched.poster,
    backdrop: item.backdrop || enriched.backdrop,
    rating: enriched.rating ?? item.rating,
    year: item.year || enriched.year,
    addonType: item.addonType ?? (isTv ? 'series' : 'movie'),
    addonUrl: item.addonUrl,
    source: 'stremio',
  };

  return {
    media: merged,
    videos,
    type: isTv ? 'series' : 'movie',
    from: addons.find((addon) => addon.manifestUrl === origins.get(item.id)) ?? null,
    logo: logos.get(item.id) ?? merged.logo,
    imdb,
    parts: [],
  };
}

// ── playing ──

/**
 * What the stream and subtitle addons are asked for `item` (an episode when
 * given): its own ids (the episode's video id), and IMDb's and TMDB's where they
 * are known, with the streams its addon put in the video itself.
 */
export async function addonTarget(
  item: MediaItem,
  addons: InstalledAddon[],
  episodeOf?: { season?: number; episode?: number },
): Promise<AddonTarget> {
  let details: AddonMeta | undefined;
  try {
    details = await meta(item, addons);
  } catch { /* An unreachable addon still leaves the ids we have. */ }

  const season = episodeOf?.season;
  const episode = episodeOf?.episode;
  const raw = item.id;
  // Cinemeta's and TMDB's numbers are IMDb's own; Kitsu says where IMDb counts
  // each episode.
  const imdbNumbers = raw.startsWith('tt') || raw.startsWith('tmdb:');
  const videos = details?.videos ?? [];
  const episodeOfKnown = season != null || episode != null;
  const video = episodeOfKnown
    ? videos.find((entry) => entry.season === (season ?? 0) && entry.episode === episode)
    : undefined;
  // A film: the video it plays (the one the details name, or its only one).
  const film = episodeOfKnown || !details || details.parts.length > 0
    ? undefined
    : videos.find((entry) => entry.id === details!.defaultVideo) ?? (videos.length === 1 ? videos[0] : undefined);
  const tmdb = item.tmdbId ?? ((details?.media.tmdbId ?? 0) > 0 ? details!.media.tmdbId : undefined);

  return {
    type: details?.type ?? addonTypeOf(item),
    raw,
    video: video?.id ?? (episodeOfKnown ? undefined : details?.defaultVideo ?? film?.id),
    imdb: details?.imdb ?? imdbIds.get(item.id) ?? (raw.startsWith('tt') ? raw.split(':')[0] : undefined),
    tmdb,
    season,
    episode,
    imdbSeason: video?.imdbSeason ?? (imdbNumbers ? season : undefined),
    imdbEpisode: video?.imdbEpisode ?? (imdbNumbers ? episode : undefined),
    title: item.title,
    year: item.year ? Number(item.year) || undefined : undefined,
    videos,
    inline: video?.inline ?? film?.inline ?? [],
    inlineFrom: video || film ? details?.from ?? undefined : undefined,
  };
}

/** Whether the title's own id is already a TMDB one. */
const tmdbKnown = (item: MediaItem) => Boolean(item.tmdbId) || item.id.startsWith('tmdb:');

/**
 * The id `target` should be asked by, for an addon whose `idPrefixes` are
 * `prefixes` — or null when that addon cannot be asked for this title.
 *
 * This is the piece that makes "any metadata addon" work rather than just the
 * IMDb-based ones. A port of VyseTV's `AddonTarget.idFor`:
 *
 *   * an addon with no prefixes takes IMDb ids, as Stremio's own addons assume;
 *   * the title's own addon id is used when the addon accepts it — that is how
 *     a Kitsu-sourced title is asked by its Kitsu id, and how a plugin
 *     repository's own title is asked by the id its plugin gave it;
 *   * otherwise the IMDb id is offered, and then TMDB's;
 *   * an episode is only offered under an id whose episode numbering is known.
 *     A show whose episodes came from Kitsu has no IMDb numbers, so it is not
 *     asked by `tt…:season:episode` — that would fetch a different episode.
 */
export function idFor(target: AddonTarget, prefixes: string[]): string | null {
  const takes = (id: string) => (prefixes.length ? prefixes.some((prefix) => id.startsWith(prefix)) : id.startsWith('tt'));
  const episodeOf = Boolean(target.video) || (target.season != null && target.episode != null);
  const own = target.video ?? (episodeOf ? `${target.raw}:${target.season}:${target.episode}` : target.raw);
  if (takes(own)) return own;

  // IMDb's and TMDB's ids, for an episode only where IMDb's numbers for it are known.
  const known = !episodeOf || target.type === 'movie' || (target.imdbSeason != null && target.imdbEpisode != null);
  if (!known) return null;
  const forEpisode = episodeOf && target.type !== 'movie';
  const candidates: Array<string | undefined> = [
    target.imdb ? (forEpisode ? `${target.imdb}:${target.imdbSeason}:${target.imdbEpisode}` : target.imdb) : undefined,
    target.tmdb ? (forEpisode ? `tmdb:${target.tmdb}:${target.imdbSeason}:${target.imdbEpisode}` : `tmdb:${target.tmdb}`) : undefined,
  ];
  return candidates.find((id): id is string => Boolean(id) && takes(id!)) ?? null;
}

/** Whether an addon that lists `types` takes this title's kind. */
export function typeOk(target: AddonTarget, types: string[]): boolean {
  return !types.length || types.includes(target.type);
}

/** The `stream` resource's own id prefixes and types, as the addon declared them. */
function streamShape(addon: InstalledAddon): { prefixes: string[]; types: string[] } {
  const resource = addon.manifest.resources.find((entry) => entry.name === 'stream');
  return { prefixes: resource?.idPrefixes ?? [], types: resource?.types ?? [] };
}

/**
 * The id `addon` should be asked for `target` by, or null when it cannot be
 * asked at all — the addon names prefixes the title has no id for, or it only
 * carries types the title is not.
 */
export function streamIdFor(addon: InstalledAddon, target: AddonTarget): string | null {
  const { prefixes, types } = streamShape(addon);
  if (!typeOk(target, types)) return null;
  return idFor(target, prefixes);
}

/**
 * `item` matched to TMDB, so the built-in film sources can play it: by the TMDB
 * id its addon gave, else by its IMDb id, else by its name and year on TMDB.
 * Null when it cannot be.
 */
export function twin(item: MediaItem, addons: InstalledAddon[]): Promise<MediaItem | null> {
  if (tmdbKnown(item)) return Promise.resolve(item);
  return memo(`twin|${item.addonUrl || ''}|${item.id}`, async () => {
    let details: AddonMeta | undefined;
    try {
      details = await meta(item, addons);
    } catch { /* Fall through to the fuzzy match. */ }
    return match(item, details ?? null);
  });
}

async function match(item: MediaItem, details: AddonMeta | null): Promise<MediaItem | null> {
  if (tmdbKnown(item)) return item;
  const isTv = details ? details.media.type === 'series' : item.type === 'series';
  const base: MediaItem = details
    ? {
      ...item,
      title: item.title || details.media.title,
      poster: item.poster || details.media.poster,
      backdrop: item.backdrop || details.media.backdrop,
      year: item.year || details.media.year,
    }
    : item;

  if (details?.media.tmdbId) return withTmdb(base, details.media.tmdbId);
  if (item.tmdbId) return item;

  const imdb = details?.imdb ?? imdbIds.get(item.id) ?? (item.id.startsWith('tt') ? item.id.split(':')[0] : undefined);
  if (imdb) {
    try {
      const found = await tmdbService.findByImdb(imdb);
      const pick = isTv ? found.tvId ?? found.movieId : found.movieId ?? found.tvId;
      if (pick) return withTmdb(base, pick, pick === found.tvId);
    } catch { /* Fall through to the name search. */ }
  }
  // No id TMDB knows: its name (and year) on TMDB, taken only when the name is
  // the same, letter for letter (case, spaces and marks aside).
  const byName = await matchByName(base.title, base.year, isTv);
  return byName ? withTmdb(base, byName.id, byName.tv) : null;
}

function withTmdb(item: MediaItem, tmdbId: number, isTv = item.type === 'series'): MediaItem {
  return { ...item, tmdbId, id: `tmdb:${tmdbId}`, type: isTv ? 'series' : 'movie' };
}

/**
 * TMDB's title of this `title` (and `year`, give or take one). Null unless the
 * name is the same, letter for letter (case, spaces and marks aside).
 */
async function matchByName(title: string, year: string | undefined, isTv: boolean): Promise<{ id: number; tv: boolean } | null> {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const want = normalize(title);
  if (!want) return null;
  const wanted = Number.parseInt(year || '', 10);
  const kinds: Array<'movie' | 'tv'> = isTv ? ['tv', 'movie'] : ['movie', 'tv'];
  for (const kind of kinds) {
    let results: Array<{ id: number; names: string[]; year?: number }>;
    try {
      results = await tmdbService.searchTitles(title, kind);
    } catch {
      continue;
    }
    for (const result of results) {
      const names = result.names.map(normalize);
      const closeEnough = !Number.isFinite(wanted) || !result.year || Math.abs(result.year - wanted) <= 1;
      if (names.includes(want) && closeEnough) return { id: result.id, tv: kind === 'tv' };
    }
  }
  return null;
}

/**
 * Where TMDB counts the episode `season` x `episode` of `item` (an addon title):
 * the numbers the built-in film sources go by. Kitsu says where IMDb (and so
 * TMDB) counts each episode; other addons count them as IMDb does.
 */
export async function tmdbEpisode(
  item: MediaItem,
  addons: InstalledAddon[],
  season: number | null | undefined,
  episode: number | null | undefined,
): Promise<{ season?: number; episode?: number }> {
  if (item.source !== 'stremio' || episode == null) return { season: season ?? undefined, episode: episode ?? undefined };
  try {
    const details = await meta(item, addons);
    const video = details.videos.find((entry) => entry.season === (season ?? 0) && entry.episode === episode);
    if (video?.imdbSeason != null && video?.imdbEpisode != null) {
      return { season: video.imdbSeason, episode: video.imdbEpisode };
    }
  } catch { /* Fall back to the addon's own numbering. */ }
  return { season: season ?? undefined, episode: episode ?? undefined };
}

/**
 * The film of collection `item` to play: the first not watched to the end (the
 * first, once all are). Null when `item` is not a collection.
 */
export async function partToPlay(
  item: MediaItem,
  addons: InstalledAddon[],
  watched: (part: MediaItem) => boolean,
): Promise<MediaItem | null> {
  if (item.source !== 'stremio') return null;
  let details: AddonMeta;
  try {
    details = await meta(item, addons);
  } catch {
    return null;
  }
  if (!details.parts.length) return null;
  return details.parts.find((part) => !watched(part)) ?? details.parts[0];
}

/** A details answer's videos as the episode list the details page shows. */
export function videosToEpisodes(videos: AddonVideo[]): TmdbEpisodeInfo[] {
  return videos.map((video) => ({
    id: video.tmdbId ?? video.season * 10000 + video.episode,
    season: video.season,
    episode: video.episode,
    title: video.name,
    overview: video.overview,
    still: video.thumbnail,
    airDate: video.released,
    runtime: video.runtime,
  }));
}
