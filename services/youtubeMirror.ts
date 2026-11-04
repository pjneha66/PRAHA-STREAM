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

/** Mixed list so one dead ecosystem cannot take the tab down. */
export const DEFAULT_MIRRORS = [
  'https://pipedapi.kavin.rocks',
  'https://inv.nadeko.net',
  'https://pipedapi.adminforge.de',
  'https://invidious.nerdvpn.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.drgns.space',
  'https://pipedapi.reallyaweso.me',
  'https://invidious.tiekoetter.com',
];

/** Instances known to proxy media streams, used when a video has no audio URLs. */
const MEDIA_FALLBACKS = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.tiekoetter.com',
  'https://pipedapi.kavin.rocks',
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

/** Piped lives on `pipedapi.*`; anything else is tried as Invidious first. */
function kindsFor(base: string): MirrorKind[] {
  return /piped/i.test(base) ? ['piped', 'invidious'] : ['invidious', 'piped'];
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
  for (const base of readMirrors()) {
    for (const kind of kindsFor(base)) {
      const started = Date.now();
      try {
        const response = await nativeFetchText(`${base}${paths[kind]}`, {
          timeoutMs: 9000,
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

/** Keeps the message readable when eight instances all fail. */
function summarise(problems: string[]): string {
  const unique = Array.from(new Set(problems));
  return unique.length <= 4
    ? unique.join(' · ')
    : `${unique.slice(0, 4).join(' · ')} · +${unique.length - 4} more`;
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
 * Music-tab heuristic: drop live streams, zero-length rows (news bulletins
 * report "0:00"), and clips too short to be a track.
 */
export function isMusicVideo(video: YtVideo): boolean {
  if (video.live) return false;
  return durationSeconds(video.duration) >= 45;
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
export async function fetchMirrorMusic(): Promise<YtHome> {
  const shelves: YtShelf[] = [];
  const attempts: Array<() => Promise<YtShelf>> = [
    async () => ({
      id: 'mirror-music-trending',
      title: 'Trending in music',
      videos: await mirrorFetch('Music trending', {
        piped: '/trending?region=US&type=music',
        invidious: '/api/v1/trending?type=Music',
      }, (payload, kind) => {
        const videos = videoList(payload, kind).filter(isMusicVideo);
        return videos.length ? videos : null;
      }),
    }),
    async () => ({
      id: 'mirror-music-hits',
      title: 'Top hits right now',
      videos: (await searchMirrorMusic('top hits this week')).videos,
    }),
    async () => ({
      id: 'mirror-music-mixes',
      title: 'Mixes & playlists',
      videos: (await searchMirrorMusic('lofi hip hop mix')).videos,
    }),
    async () => ({
      id: 'mirror-music-live',
      title: 'Live sessions',
      videos: (await searchMirrorMusic('live session')).videos,
    }),
  ];

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const shelf = await attempt();
      if (shelf.videos.length) shelves.push(shelf);
    } catch (error) {
      failures.push(describeFailure(error));
    }
  }

  if (!shelves.length) {
    throw new Error(failures.length ? summarise(Array.from(new Set(failures))) : 'Music is unavailable right now.');
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

/** Asks a media-capable instance for a track's audio, used when detail had none. */
async function fallbackAudioTracks(videoId: string): Promise<YtDetail['audioTracks']> {
  for (const base of MEDIA_FALLBACKS) {
    for (const kind of kindsFor(base)) {
      try {
        const path = kind === 'piped'
          ? `${base}/streams/${encodeURIComponent(videoId)}`
          : `${base}/api/v1/videos/${encodeURIComponent(videoId)}`;
        const response = await nativeFetchText(path, { timeoutMs: 9000, headers: { Accept: 'application/json' } });
        if (!response.ok) continue;
        const payload = JSON.parse(response.data) as Record<string, unknown>;
        const source = (kind === 'piped' ? payload.audioStreams : payload.adaptiveFormats) as Array<Record<string, unknown>> | undefined;
        const tracks = (Array.isArray(source) ? source : [])
          .map((stream) => ({
            url: str(stream.url) || '',
            mime: String(stream.mimeType ?? stream.type ?? 'audio/webm'),
            bitrate: num(stream.bitrate) ?? 0,
          }))
          .filter((track) => track.url.startsWith('https://') && track.mime.startsWith('audio'))
          .sort((a, b) => b.bitrate - a.bitrate)
          .map((track) => ({
            ...track,
            label: `${Math.round(track.bitrate / 1000)} kbps · ${track.mime.split(';')[0].replace('audio/', '').toUpperCase()}`,
          }));
        if (tracks.length) return tracks;
      } catch { /* try the next media host */ }
    }
  }
  return [];
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
  if (!audioTracks.length) audioTracks = await fallbackAudioTracks(videoId);

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
    embedUrl: youtubeEmbedUrl(videoId),
  };
}

/**
 * Direct YouTube first (nobody else sees the request), mirrors second. When
 * both fail the YouTube reason leads and the mirror sweep follows, so the
 * Mirror settings panel can explain itself.
 */
export async function withMirrorFallback<T>(direct: () => Promise<T>, mirror: () => Promise<T>): Promise<FlowSource<T>> {
  try {
    return { data: await direct(), backend: 'youtube' };
  } catch (directError) {
    try {
      return { data: await mirror(), backend: 'mirror' };
    } catch (mirrorError) {
      throw new Error(`YouTube: ${describeFailure(directError)}. ${describeFailure(mirrorError)}.`);
    }
  }
}
