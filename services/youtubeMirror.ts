/**
 * Flow tab — mirror tier.
 *
 * YouTube's own key-free endpoints refuse a lot of client IPs (HTTP 429/500)
 * and send no CORS headers, so on the web the direct tier usually fails. When
 * it does, the tab retries through community **Piped** and **Invidious**
 * instances, normalising every payload into the shapes used by
 * `youtubeService`.
 *
 * Two rules keep this from being a lottery:
 *  1. Direct YouTube is always tried first, so a mirror only sees requests
 *     YouTube already refused.
 *  2. Nothing is trusted until it *validates*: a payload must contain at least
 *     one usable video. A mirror answering `{}` or `[]` is treated as broken and
 *     the next one is tried.
 */

import { nativeFetchText } from './androidBridge';
import {
  formatDuration, thumbFor, youtubeEmbedUrl,
  type YtChapter, type YtChannelFeed, type YtDetail, type YtHome, type YtSearchResult,
  type YtShelf, type YtVideo,
} from './youtubeService';

export type YtBackend = 'youtube' | 'mirror';
export type MirrorKind = 'piped' | 'invidious';

export interface FlowSource<T> {
  data: T;
  /** Which tier answered. `mirror` means a community instance answered. */
  backend: YtBackend;
}

export const MIRROR_STORAGE_KEY = 'praha.v2.flow-mirrors';

/** Mixed list so one dead ecosystem cannot take the tab down.
 * Order: instances verified live on 2026-11-13 (search endpoint answered);
 * dead ones removed rather than leaving them in the probe path. */
export const DEFAULT_MIRRORS = [
  'https://api.piped.private.coffee',
  'https://pipedapi.reallyaweso.me',
  'https://inv.nadeko.net',
  'https://invidious.tiekoetter.com',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
  'https://pipedapi.kavin.rocks',
];

/** Instances known to proxy media streams, used when a video has no audio URLs.
 * kavin.rocks dropped off (403); the rest answered /streams. */
const MEDIA_FALLBACKS = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.tiekoetter.com',
  'https://api.piped.private.coffee',
  'https://pipedapi.reallyaweso.me',
];

/** The last mirror that answered; reused so later calls are not re-probed. */
let preferredMirror: string | null = null;

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

export interface SourceProbe {
  base: string;
  kind: MirrorKind;
  ok: boolean;
  detail: string;
  videos?: number;
}

/** Where the last mirror sweep started from; shown in Mirror settings. */
export const lastProbeLog: SourceProbe[] = [];

function logProbe(entry: SourceProbe): void {
  lastProbeLog.unshift(entry);
  if (lastProbeLog.length > 24) lastProbeLog.length = 24;
}

/** Wall-clock budget for one mirror sweep; exposed so tests can shrink it. */
export let mirrorSweepBudgetMs = 14000;
export function setMirrorSweepBudget(ms: number): void {
  mirrorSweepBudgetMs = Math.max(0, ms);
}

export function readMirrors(): string[] {
  let stored: string[] = [];
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(MIRROR_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) stored = parsed.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch { /* corrupt storage falls back to defaults */ }
  const list = stored.length ? stored : DEFAULT_MIRRORS;
  return preferredMirror && list.includes(preferredMirror)
    ? [preferredMirror, ...list.filter((entry) => entry !== preferredMirror)]
    : list;
}

export function normalizeMirrorUrl(value: string): string {
  const term = value.trim();
  if (!term) throw new Error('Enter a Piped or Invidious API URL.');
  let url: URL;
  try {
    url = new URL(term.startsWith('http') ? term : `https://${term}`);
  } catch {
    throw new Error('That does not look like a URL.');
  }
  if (url.protocol !== 'https:') throw new Error('Mirrors must use HTTPS.');
  if (url.username || url.password) throw new Error('Mirror URLs cannot contain credentials.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Pick the API family from the host name. Asking a Piped host for `/api/v1/…`
 * only produces a CORS-masked 404 that looks like a network failure, so we only
 * try both shapes on hosts we cannot classify.
 */
export function kindsFor(base: string): MirrorKind[] {
  let host = base;
  try { host = new URL(base).host; } catch { /* keep raw */ }
  if (/piped/i.test(host)) return ['piped'];
  if (/invidious|^inv\.|^yt\.|^iv\./i.test(host)) return ['invidious'];
  return ['invidious', 'piped'];
}

const isErrorPayload = (payload: unknown): boolean =>
  Boolean(payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as Record<string, unknown>).error);

/**
 * Walks the mirror list, asking each host for the Piped path and then the
 * Invidious path (host name decides the order), returning the first payload a
 * parser accepts. A parser returning `null` means "this host has nothing for
 * us", so the sweep continues instead of giving up.
 */
async function mirrorFetch<T>(
  label: string,
  paths: Record<MirrorKind, string>,
  parse: (payload: unknown, kind: MirrorKind) => T | null,
): Promise<T> {
  const problems: string[] = [];
  // Hard budget for the whole sweep: twelve dead instances at 6s each would
  // otherwise keep the spinner up for over a minute.
  const deadline = Date.now() + mirrorSweepBudgetMs;
  for (const base of readMirrors()) {
    if (Date.now() > deadline) {
      problems.push(`${problems.length ? 'sweep' : 'mirrors'}: gave up after ${problems.length} failed hosts`);
      break;
    }
    for (const kind of kindsFor(base)) {
      if (Date.now() > deadline) break;
      const started = Date.now();
      try {
        const response = await nativeFetchText(`${base}${paths[kind]}`, {
          timeoutMs: 6000,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          const detail = `HTTP ${response.status}`;
          problems.push(`${new URL(base).host}: ${detail}`);
          logProbe({ base, kind, ok: false, detail, });
          continue;
        }
        const payload = JSON.parse(response.data) as unknown;
        if (isErrorPayload(payload)) {
          const detail = `API error: ${String((payload as Record<string, unknown>).error)}`;
          problems.push(`${new URL(base).host}: ${detail}`);
          logProbe({ base, kind, ok: false, detail });
          continue;
        }
        const parsed = parse(payload, kind);
        if (parsed !== null) {
          preferredMirror = base;
          logProbe({ base, kind, ok: true, detail: `${Math.max(1, Math.round((Date.now() - started) / 100) / 10)}s`, videos: countVideos(parsed) });
          return parsed;
        }
        const detail = 'answered, but had nothing usable';
        problems.push(`${new URL(base).host}: ${detail}`);
        logProbe({ base, kind, ok: false, detail });
      } catch (error) {
        const detail = describeFailure(error);
        problems.push(`${new URL(base).host}: ${detail}`);
        logProbe({ base, kind, ok: false, detail });
      }
    }
  }
  throw new Error(problems.length
    ? `${label} failed on every mirror — ${summarise(problems)}`
    : `${label}: no mirrors configured.`);
}

/** Keeps the message readable when a dozen instances all fail: one line per host. */
export function summarise(problems: string[]): string {
  const byHost = new Map<string, string>();
  for (const problem of problems) {
    const [host, ...rest] = problem.split(': ');
    if (!byHost.has(host)) byHost.set(host, rest.join(': ') || 'failed');
  }
  const lines = Array.from(byHost, ([host, reason]) => `${host}: ${reason}`);
  return lines.length <= 4
    ? lines.join(' · ')
    : `${lines.slice(0, 4).join(' · ')} · +${lines.length - 4} more`;
}

function countVideos(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.videos)) return record.videos.length;
  if (Array.isArray(record.items)) return record.items.length;
  if (Array.isArray(record.shelves)) {
    return (record.shelves as Array<Record<string, unknown>>).reduce((total, shelf) => total + (Array.isArray(shelf.videos) ? shelf.videos.length : 0), 0);
  }
  return 0;
}

/** Browser network failures are opaque ("Failed to fetch"); say what it means. */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'unknown error');
  if (/abort/i.test(message)) return 'timed out';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return 'blocked before it reached the server (CORS/offline)';
  }
  return message.replace(/\s+$/, '').replace(/[.\s]+$/, '');
}

/* ------------------------------------------------------------------ *
 * Normalising helpers
 * ------------------------------------------------------------------ */

const str = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.trim() ? value.trim() : undefined);

const num = (value: unknown): number | undefined =>
  (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** "3 days ago" from an epoch (seconds or ms). Empty/garbage values stay empty. */
export function relativeTime(value: unknown): string | undefined {
  const raw = num(value);
  if (!raw || raw <= 0) return undefined;
  const ms = raw < 1e12 ? raw * 1000 : raw;
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 90) return 'just now';
  const units: Array<[number, string]> = [
    [31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return `${count} ${name}${count === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/** Trims Piped's `""` and 0 sentinels; falls back to a relative form. */
function publishedText(text: unknown, epoch: unknown): string | undefined {
  const label = str(text);
  if (label) return label;
  const stamp = num(epoch);
  return stamp && stamp > 0 ? relativeTime(stamp) : undefined;
}

interface PipedStream {
  url?: string;
  title?: string;
  thumbnail?: string;
  uploaderName?: string;
  uploaderUrl?: string;
  duration?: number;
  views?: number;
  uploadedDate?: string;
  uploaded?: number;
  livestream?: boolean;
  type?: string;
}

/** Piped reports watch links as `/watch?v=ID`; keep only the id. */
export function pipedVideo(entry: PipedStream): YtVideo | null {
  const id = typeof entry.url === 'string' ? entry.url.replace(/^.*[?&]v=/, '').split('&')[0] : '';
  if (!/^[\w-]{11}$/.test(id)) return null;
  const duration = num(entry.duration);
  return {
    id,
    title: str(entry.title) || 'Untitled video',
    channel: str(entry.uploaderName),
    channelId: str(entry.uploaderUrl)?.replace(/^\/channel\//, ''),
    views: (num(entry.views) ?? -1) >= 0 ? `${(num(entry.views) ?? 0).toLocaleString()} views` : undefined,
    published: publishedText(entry.uploadedDate, entry.uploaded),
    duration: duration && duration > 0 ? formatDuration(duration) : undefined,
    thumbnail: str(entry.thumbnail) || thumbFor(id),
    live: Boolean(entry.livestream) || duration === -1,
  };
}

const pipedList = (payload: unknown): YtVideo[] => (Array.isArray(payload) ? payload : [])
  .map((entry) => pipedVideo(entry as PipedStream))
  .filter((video): video is YtVideo => Boolean(video));

interface InvidiousVideo {
  videoId?: string;
  title?: string;
  author?: string;
  authorId?: string;
  viewCount?: number;
  viewCountText?: string;
  publishedText?: string;
  published?: number;
  lengthSeconds?: number;
  liveNow?: boolean;
  videoThumbnails?: Array<{ url?: string; quality?: string; width?: number }>;
}

function invidiousVideo(entry: InvidiousVideo): YtVideo | null {
  const id = str(entry.videoId);
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const thumbs = Array.isArray(entry.videoThumbnails) ? entry.videoThumbnails : [];
  const bestThumb = thumbs.find((thumb) => thumb.quality === 'high') || thumbs[0];
  const views = num(entry.viewCount);
  const length = num(entry.lengthSeconds);
  return {
    id,
    title: str(entry.title) || 'Untitled video',
    channel: str(entry.author),
    channelId: str(entry.authorId),
    views: str(entry.viewCountText) || (views !== undefined && views >= 0 ? `${views.toLocaleString()} views` : undefined),
    published: str(entry.publishedText) || publishedText(undefined, entry.published),
    duration: length && length > 0 ? formatDuration(length) : undefined,
    thumbnail: str(bestThumb?.url) || thumbFor(id),
    live: Boolean(entry.liveNow),
  };
}

const invidiousList = (payload: unknown): YtVideo[] => {
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as Record<string, unknown> | undefined)?.items)
      ? (payload as { items: unknown[] }).items
      : [];
  return items
    .filter((entry) => !(entry && typeof entry === 'object' && (entry as Record<string, unknown>).type
      && (entry as Record<string, unknown>).type !== 'video'))
    .map((entry) => invidiousVideo(entry as InvidiousVideo))
    .filter((video): video is YtVideo => Boolean(video));
};

/**
 * Height for a mirror video stream. Piped sends `quality: "720p"`, Invidious
 * sends `resolution: "720p"` or only `res=` inside the mime string, and both may
 * include a numeric `height`. Missing this collapsed every quality into one
 * button labelled "?p".
 */
/**
 * Does this video stream carry an audio track? Piped says so with
 * `videoOnly: false`; Invidious' `formatStreams` are muxed and its
 * `adaptiveFormats` are not. Getting this wrong plays a silent picture.
 */
export function streamHasAudio(stream: Record<string, unknown>, kind: MirrorKind): boolean {
  if (stream.videoOnly === true) return false;
  if (stream.videoOnly === false) return true;
  const audioQuality = String(stream.audioQuality ?? '').toUpperCase();
  if (audioQuality.includes('AUDIO_QUALITY_')) return !audioQuality.endsWith('UNKNOWN');
  if (typeof stream.audioTrackId === 'string' || typeof stream.audio_itag === 'number') return true;
  if (stream.audioChannels) return true;
  // Invidious reports `type`, not `mimeType`. Muxed formats live in
  // formatStreams (adaptive: false); adaptiveFormats never carry audio.
  const mime = String(stream.mimeType ?? stream.type ?? 'video/mp4');
  if (kind === 'invidious') return stream.adaptive !== true && mime.includes('mp4');
  // Piped omits videoOnly on some instances; assume muxed unless it says otherwise.
  return true;
}

export function trackHeight(stream: Record<string, unknown>, mime: string): number | undefined {
  const direct = num(stream.height);
  if (direct) return direct;
  const fromLabel = Number(String(stream.qualityLabel ?? stream.quality ?? stream.resolution ?? '').replace(/[^0-9]/g, ''));
  if (fromLabel) return fromLabel;
  const fromMime = Number(/res=([0-9]+)x/.exec(mime)?.[1] || 0);
  return fromMime || undefined;
}

const videoList = (payload: unknown, kind: MirrorKind): YtVideo[] =>
  (kind === 'piped' ? pipedList(payload) : invidiousList(payload));

/** "1:02:03" / "3:33" → seconds; anything unparseable is 0. */
export function durationSeconds(value?: string): number {
  if (!value) return 0;
  const parts = value.split(':').map((part) => Number(part));
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Music-tab heuristic (strict): drop live streams, zero-length rows (news
 * bulletins report "0:00"), and clips too short to be a track.
 */
export function isMusicVideo(video: YtVideo): boolean {
  if (video.live) return false;
  return durationSeconds(video.duration) >= 45;
}

const MUSIC_HINTS = /music|song|album|track|official audio|lyric|lyrics|remix|mix|beat|instrumental|acoustic|live session|radio|soundtrack|ost|feat\.?|ft\.?/i;
const NON_MUSIC_HINTS = /news|election|breaking|press conference|interview|speech|debate|weather|sports?|highlights|full episode|podcast|documentary|vlog|tutorial|trailer/i;

/**
 * Music-tab heuristic (loose) for instances that only serve general video
 * search: keep anything that looks like a song by title or channel, minus the
 * obvious news/talk rows. Used only after the strict filter left nothing.
 */
export function looksLikeMusic(video: YtVideo): boolean {
  if (!isMusicVideo(video)) return false;
  const text = `${video.title} ${video.channel || ''}`;
  if (NON_MUSIC_HINTS.test(text) && !MUSIC_HINTS.test(text)) return false;
  return MUSIC_HINTS.test(text) || /vevo|topic|records|music/i.test(video.channel || '');
}

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

const videoShelf = (label: string) => (payload: unknown, kind: MirrorKind): YtVideo[] | null => {
  const videos = videoList(payload, kind);
  return videos.length ? videos : null;
};

export async function fetchMirrorHome(): Promise<YtHome> {
  const trending = await mirrorFetch('Trending', {
    piped: '/trending?region=US',
    invidious: '/api/v1/trending?region=US',
  }, videoShelf('trending'));
  const shelves: YtShelf[] = [{ id: 'mirror-trending', title: 'Trending now', videos: trending }];

  try {
    const popular = await mirrorFetch('Popular music', {
      piped: '/trending?region=US&type=music',
      invidious: '/api/v1/trending?type=Music',
    }, videoShelf('music'));
    shelves.push({ id: 'mirror-music', title: 'Trending music', videos: popular });
  } catch { /* the music row is optional */ }

  return { shelves };
}

export async function searchMirror(query: string): Promise<YtSearchResult> {
  const videos = await mirrorFetch('Search', {
    piped: `/search?q=${encodeURIComponent(query)}&filter=videos`,
    invidious: `/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
  }, videoShelf('search'));
  return { videos, channels: [] };
}

/** Music-only results — no live news, no podcasts, nothing without a length. */
export async function searchMirrorMusic(query: string): Promise<YtSearchResult> {
  const videos = await mirrorFetch('Music search', {
    piped: `/search?q=${encodeURIComponent(query)}&filter=music_videos`,
    invidious: `/api/v1/search?q=${encodeURIComponent(query)}&type=video&sort_by=relevance`,
  }, (payload, kind) => {
    const items = videoList(payload, kind).filter(isMusicVideo);
    return items.length ? items : null;
  });
  return { videos, channels: [] };
}

/**
 * Music home. Every row is optional, so one grumpy instance cannot turn the
 * whole tab into an error: trending music, then two searches.
 */
/**
 * Trending music, in three increasingly forgiving passes. Most instances expose
 * `/trending?type=music`; when one does not, its *general* trending list still
 * works, so we filter that for songs rather than failing the tab.
 */
async function mirrorMusicTrending(strict: boolean): Promise<YtVideo[]> {
  const filter = strict ? isMusicVideo : looksLikeMusic;
  return mirrorFetch(strict ? 'Music trending' : 'Music trending (filtered)', {
    piped: '/trending?region=US&type=music',
    invidious: '/api/v1/trending?type=Music',
  }, (payload, kind) => {
    const videos = videoList(payload, kind).filter(filter);
    return videos.length ? videos : null;
  });
}

async function mirrorTrendingLoose(): Promise<YtVideo[]> {
  const videos = await mirrorFetch('Trending', {
    piped: '/trending?region=US',
    invidious: '/api/v1/trending?region=US',
  }, videoShelf('trending'));
  return videos.filter(looksLikeMusic);
}

export async function fetchMirrorMusic(): Promise<YtHome> {
  const shelves: YtShelf[] = [];
  const failures: string[] = [];

  const push = (id: string, title: string, videos: YtVideo[]) => {
    if (videos.length) shelves.push({ id, title, videos });
  };

  const tryRow = async (runner: () => Promise<YtVideo[]>): Promise<YtVideo[]> => {
    try { return await runner(); } catch (error) {
      failures.push(describeFailure(error));
      return [];
    }
  };

  // Note: an empty array is truthy, so compare lengths instead of relying on ||.
  let trending: YtVideo[] = [];
  for (const runner of [
    () => mirrorMusicTrending(true),
    () => mirrorMusicTrending(false),
    mirrorTrendingLoose,
  ]) {
    if (trending.length) break;
    trending = await tryRow(runner);
  }
  push('mirror-music-trending', 'Trending in music', trending);

  for (const [id, title, query] of [
    ['mirror-music-hits', 'Top hits right now', 'top hits this week'],
    ['mirror-music-mixes', 'Mixes & playlists', 'lofi hip hop mix'],
    ['mirror-music-live', 'Live sessions', 'live session music'],
  ] as const) {
    push(id, title, await tryRow(async () => {
      try {
        const strict = await searchMirrorMusic(query);
        if (strict.videos.length) return strict.videos;
      } catch { /* fall back to the general search below */ }
      const broad = await searchMirror(query);
      return broad.videos.filter(looksLikeMusic);
    }));
  }

  if (!shelves.length) {
    throw new Error(failures.length
      ? `Music is unavailable right now — ${summarise(failures)}`
      : 'Music is unavailable right now.');
  }
  return { shelves };
}

export async function fetchMirrorChannel(channelId: string): Promise<YtChannelFeed> {
  const payload = await mirrorFetch('Channel', {
    piped: `/channel/${encodeURIComponent(channelId)}`,
    invidious: `/api/v1/channels/${encodeURIComponent(channelId)}`,
  }, (raw, kind) => {
    const record = raw as Record<string, unknown>;
    const videos = videoList(kind === 'piped' ? record.relatedStreams : record.latestVideos, kind);
    return videos.length ? raw : null;
  }) as Record<string, unknown>;

  const invidious = 'author' in payload;
  const videos = videoList(invidious ? payload.latestVideos : payload.relatedStreams, invidious ? 'invidious' : 'piped');
  const avatarThumbs = Array.isArray(payload.authorThumbnails) ? payload.authorThumbnails as Array<Record<string, unknown>> : [];

  return {
    channelId,
    title: String(payload.name ?? payload.author ?? 'YouTube channel'),
    description: str(payload.description),
    avatar: str(payload.avatarUrl) || str(avatarThumbs[avatarThumbs.length - 1]?.url),
    banner: str(payload.bannerUrl),
    subscribers: num(payload.subscriberCount) !== undefined
      ? `${(num(payload.subscriberCount) as number).toLocaleString()} subscribers`
      : str(payload.subCountText),
    videos,
  };
}

/**
 * Asks media-capable instances for stream URLs. Piped's `/streams` payload and
 * Invidious' `/videos` payload usually carry more qualities than the instance
 * that answered the metadata call, so this is how a 360p-only row is upgraded.
 */
async function fallbackStreams(videoId: string): Promise<{ audio: YtDetail['audioTracks']; video: YtDetail['videoTracks'] }> {
  const deadline = Date.now() + 8000;
  for (const base of MEDIA_FALLBACKS.slice(0, 2)) {
    if (Date.now() > deadline) break;
    for (const kind of kindsFor(base)) {
      try {
        const path = kind === 'piped'
          ? `${base}/streams/${encodeURIComponent(videoId)}`
          : `${base}/api/v1/videos/${encodeURIComponent(videoId)}`;
        const response = await nativeFetchText(path, { timeoutMs: 6000, headers: { Accept: 'application/json' } });
        if (!response.ok) continue;
        const payload = JSON.parse(response.data) as Record<string, unknown>;
        const audioSource = kind === 'piped' ? payload.audioStreams : payload.adaptiveFormats;
        const videoSource = kind === 'piped'
          ? payload.videoStreams
          : [...(Array.isArray(payload.formatStreams) ? payload.formatStreams : []), ...(Array.isArray(payload.adaptiveFormats) ? payload.adaptiveFormats : [])];

        const audio = (Array.isArray(audioSource) ? audioSource : [])
          .map((raw) => {
            const stream = raw as Record<string, unknown>;
            return { url: str(stream.url) || '', mime: String(stream.mimeType ?? stream.type ?? 'audio/webm'), bitrate: num(stream.bitrate) ?? 0 };
          })
          .filter((track) => track.url.startsWith('https://') && track.mime.startsWith('audio'))
          .sort((a, b) => b.bitrate - a.bitrate)
          .map((track) => ({ ...track, label: `${Math.round(track.bitrate / 1000)} kbps · ${track.mime.split(';')[0].replace('audio/', '').toUpperCase()}` }));

        const video = (Array.isArray(videoSource) ? videoSource : [])
          .map((raw) => {
            const stream = raw as Record<string, unknown>;
            const mime = String(stream.mimeType ?? stream.type ?? 'video/mp4');
            const quality = str(stream.qualityLabel) || str(stream.quality);
            return { url: str(stream.url) || '', mime, bitrate: num(stream.bitrate) ?? 0, height: trackHeight(stream, mime), quality, hasAudio: streamHasAudio(stream, kind), raw: stream };
          })
          .filter((track) => track.url.startsWith('https://') && track.mime.startsWith('video/'))
          .filter((track) => kind === 'piped' ? track.hasAudio !== false : true)
          .map((track) => ({ ...track, hasAudio: kind === 'piped' ? track.hasAudio : streamHasAudio(track.raw, kind) }))
          .sort((a, b) => {
            // Muxed first, then highest quality.
            if (Boolean(b.hasAudio) !== Boolean(a.hasAudio)) return b.hasAudio ? 1 : -1;
            return (b.height || 0) - (a.height || 0);
          })
          .map((track) => ({
            url: track.url,
            mime: track.mime,
            bitrate: track.bitrate,
            height: track.height,
            hasAudio: track.hasAudio,
            label: `${track.quality || (track.height ? `${track.height}p` : 'auto')} · ${track.mime.split(';')[0].replace('video/', '').toUpperCase()}${track.hasAudio === false ? ' · silent' : ''}`,
          }));

        if (audio.length || video.length) {
          preferredMirror = preferredMirror || base;
          logProbe({ base, kind, ok: true, detail: `streams ${audio.length}a/${video.length}v`, videos: video.length });
          return { audio, video };
        }
      } catch { /* try the next media host */ }
    }
  }
  return { audio: [], video: [] };
}

export async function fetchMirrorDetail(videoId: string): Promise<YtDetail> {
  const payload = await mirrorFetch('Video details', {
    piped: `/streams/${encodeURIComponent(videoId)}`,
    invidious: `/api/v1/videos/${encodeURIComponent(videoId)}`,
  }, (raw) => {
    const record = raw as Record<string, unknown>;
    return typeof record.title === 'string' && record.title.length > 0 ? raw : null;
  }) as Record<string, unknown>;

  const isInvidious = 'authorId' in payload || 'videoThumbnails' in payload;
  const relatedRaw = isInvidious ? payload.recommendedVideos : payload.relatedStreams;
  const related = videoList(relatedRaw, isInvidious ? 'invidious' : 'piped').filter((video) => video.id !== videoId);

  const muxedInvidious = (Array.isArray(payload.formatStreams) ? payload.formatStreams : []) as Array<Record<string, unknown>>;
  const adaptiveInvidious = (Array.isArray(payload.adaptiveFormats) ? payload.adaptiveFormats : []) as Array<Record<string, unknown>>;
  const videoSource = isInvidious
    // Muxed mp4 first: adaptive formats here never contain audio.
    ? [...muxedInvidious.map((entry) => ({ ...entry, adaptive: false })), ...adaptiveInvidious.map((entry) => ({ ...entry, adaptive: true }))]
    : payload.videoStreams;
  let videoTracks: YtDetail['videoTracks'] = (Array.isArray(videoSource) ? videoSource : [])
    .map((raw) => {
      const stream = raw as Record<string, unknown>;
      const mime = String(stream.mimeType ?? stream.type ?? 'video/mp4');
      const height = trackHeight(stream, mime);
      const hasAudio = streamHasAudio(stream, isInvidious ? 'invidious' : 'piped');
      return {
        url: str(stream.url) || '',
        mime,
        bitrate: num(stream.bitrate) ?? 0,
        height,
        hasAudio,
        label: `${height ? `${height}p` : String(stream.quality ?? 'auto')} · ${mime.split(';')[0].replace('video/', '').toUpperCase()}${hasAudio ? '' : ' · silent'}`,
      };
    })
    .filter((track) => track.url.startsWith('https://') && track.mime.startsWith('video/'))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const audioSource = isInvidious ? payload.adaptiveFormats : payload.audioStreams;
  let audioTracks: YtDetail['audioTracks'] = (Array.isArray(audioSource) ? audioSource : [])
    .map((raw) => {
      const stream = raw as Record<string, unknown>;
      const mime = String(stream.mimeType ?? stream.type ?? 'audio/webm');
      return { url: str(stream.url) || '', mime, bitrate: num(stream.bitrate) ?? 0 };
    })
    .filter((track) => track.url.startsWith('https://') && track.mime.startsWith('audio'))
    .sort((a, b) => b.bitrate - a.bitrate)
    .map((track) => ({
      ...track,
      label: `${Math.round(track.bitrate / 1000)} kbps · ${track.mime.split(';')[0].replace('audio/', '').toUpperCase()}`,
    }));

  // Piped sometimes answers without media URLs (its proxy is separate); ask a
  // media-capable instance before giving up on in-app playback.
  if (!audioTracks.length || !videoTracks.length) {
    const extra = await fallbackStreams(videoId);
    if (!audioTracks.length) audioTracks = extra.audio;
    // Always take the fullest video list: mirrors often return only 360p.
    if (extra.video.length && extra.video.length >= videoTracks.length) videoTracks = extra.video;
  }

  const chapters = (Array.isArray(payload.chapters) ? payload.chapters : []) as Array<Record<string, unknown>>;
  const parsedChapters = chapters
    .map((chapter) => {
      const title = str(chapter.title);
      const start = num(chapter.start);
      return title && start !== undefined ? { title, start } : null;
    })
    .filter((chapter): chapter is YtChapter => Boolean(chapter))
    .sort((a, b) => a.start - b.start);

  const thumbs = Array.isArray(payload.videoThumbnails) ? payload.videoThumbnails as Array<Record<string, unknown>> : [];
  const bestThumb = thumbs.find((thumb) => thumb.quality === 'maxres') || thumbs[thumbs.length - 1];
  const uploaderUrl = str(payload.uploaderUrl) || str(payload.authorId);

  return {
    id: videoId,
    title: String(payload.title ?? 'YouTube video'),
    description: String(payload.description ?? ''),
    channel: String(payload.uploader ?? payload.author ?? 'YouTube'),
    channelId: uploaderUrl?.replace(/^\/channel\//, ''),
    channelAvatar: str(payload.uploaderAvatar) || str((payload.authorThumbnails as Array<Record<string, unknown>> | undefined)?.[0]?.url),
    channelSubscribers: num(payload.uploaderSubscriberCount) !== undefined
      ? `${(num(payload.uploaderSubscriberCount) as number).toLocaleString()} subscribers`
      : str(payload.subCountText),
    views: num(payload.views) !== undefined
      ? `${(num(payload.views) as number).toLocaleString()} views`
      : str(payload.viewCountText),
    published: str(payload.uploadDate) || str(payload.publishedText),
    likes: num(payload.likes) !== undefined ? (num(payload.likes) as number).toLocaleString() : str(payload.likeCount),
    lengthSeconds: num(payload.duration) ?? num(payload.lengthSeconds),
    live: Boolean(payload.livestream ?? payload.liveNow),
    thumbnail: str(payload.thumbnailUrl) || str(bestThumb?.url) || thumbFor(videoId),
    keywords: Array.isArray(payload.tags) ? (payload.tags as string[]).slice(0, 12).filter((tag) => typeof tag === 'string') : undefined,
    comments: [],
    related: related.slice(0, 24),
    chapters: parsedChapters,
    audioTracks,
    videoTracks,
    playbackUrl: (videoTracks.find((track) => track.hasAudio !== false) || videoTracks[0])?.url,
    embedUrl: youtubeEmbedUrl(videoId),
  };
}

/**
 * Direct YouTube first (nobody else sees the request), mirrors second. When
 * both fail the YouTube reason leads and the mirror sweep follows, so the
 * Mirror settings panel can explain itself.
 */
/**
 * Once YouTube answers with a network-level block, every later call would pay
 * the same failed request. Remember it for the session and go straight to the
 * mirrors; `resetDirectState()` (the Retry button) clears the flag.
 */
let directBlocked = false;

export const shouldTryDirect = (): boolean => !directBlocked;

export function resetDirectState(): void {
  directBlocked = false;
  preferredMirror = null;
}

/** Probes every configured mirror once and returns the sweep result. */
export async function probeMirrors(): Promise<SourceProbe[]> {
  lastProbeLog.length = 0;
  try {
    await fetchMirrorHome();
  } catch { /* the log already holds the reason for each host */ }
  return [...lastProbeLog];
}

export async function withMirrorFallback<T>(direct: () => Promise<T>, mirror: () => Promise<T>): Promise<FlowSource<T>> {
  if (directBlocked) return { data: await mirror(), backend: 'mirror' };
  try {
    return { data: await direct(), backend: 'youtube' };
  } catch (directError) {
    const reason = describeFailure(directError);
    if (reason.startsWith('blocked') || reason === 'timed out') directBlocked = true;
    try {
      return { data: await mirror(), backend: 'mirror' };
    } catch (mirrorError) {
      throw new Error(`YouTube: ${describeFailure(directError)}. ${describeFailure(mirrorError)}.`);
    }
  }
}
