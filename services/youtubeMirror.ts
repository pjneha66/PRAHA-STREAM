/**
 * Flow tab — mirror tier.
 *
 * YouTube's own key-free endpoints refuse a lot of client IPs (HTTP 429/500)
 * and never send CORS headers, so on the web the direct tier usually fails.
 * When it does, the tab retries through community mirrors — both the **Piped**
 * and **Invidious** JSON APIs — normalising every payload into the shapes used
 * by `youtubeService`. Direct YouTube is always tried first, so a mirror only
 * sees requests YouTube already refused.
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
];

/** The last mirror that answered; reused so later calls are not re-probed. */
let preferredMirror: string | null = null;

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

/** Piped instances live on `pipedapi.*`; anything else is tried as Invidious first. */
function kindsFor(base: string): MirrorKind[] {
  return /piped/i.test(base) ? ['piped', 'invidious'] : ['invidious', 'piped'];
}

const isErrorPayload = (payload: unknown): boolean =>
  Boolean(payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as Record<string, unknown>).error);

/**
 * Walks the mirror list, asking each for the Piped path and then the Invidious
 * path (host name decides the order), returning the first payload a parser
 * accepts. Anything that 404s, errors, or parses to `null` is skipped.
 */
async function mirrorFetch<T>(
  paths: Record<MirrorKind, string>,
  parse: (payload: unknown, kind: MirrorKind) => T | null,
): Promise<T> {
  let lastError = 'No mirror answered.';
  for (const base of readMirrors()) {
    for (const kind of kindsFor(base)) {
      try {
        const response = await nativeFetchText(`${base}${paths[kind]}`, {
          timeoutMs: 11000,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          lastError = `${new URL(base).host} answered ${response.status}`;
          continue;
        }
        const payload = JSON.parse(response.data) as unknown;
        if (isErrorPayload(payload)) {
          lastError = String((payload as Record<string, unknown>).error);
          continue;
        }
        const parsed = parse(payload, kind);
        if (parsed !== null) {
          preferredMirror = base;
          return parsed;
        }
        lastError = `${new URL(base).host} returned no usable data`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Mirror request failed.';
      }
    }
  }
  throw new Error(lastError);
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
    live: Boolean(entry.livestream) || (duration === -1),
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
  return {
    id,
    title: str(entry.title) || 'Untitled video',
    channel: str(entry.author),
    channelId: str(entry.authorId),
    views: str(entry.viewCountText) || (views !== undefined && views >= 0 ? `${views.toLocaleString()} views` : undefined),
    published: str(entry.publishedText) || publishedText(undefined, entry.published),
    duration: num(entry.lengthSeconds) ? formatDuration(num(entry.lengthSeconds)) : undefined,
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

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

export async function fetchMirrorHome(): Promise<YtHome> {
  const shelves: YtShelf[] = [];
  const trending = await mirrorFetch(
    { piped: '/trending?region=US', invidious: '/api/v1/trending?region=US' },
    (payload, kind) => {
      const videos = videoList(payload, kind);
      return videos.length ? videos : null;
    },
  );
  shelves.push({ id: 'mirror-trending', title: 'Trending now', videos: trending });

  // A second row keeps Home from looking empty when a mirror serves only one.
  try {
    const popular = await mirrorFetch(
      { piped: '/trending?region=US&type=music', invidious: '/api/v1/trending?type=Music' },
      (payload, kind) => {
        const videos = videoList(payload, kind);
        return videos.length ? videos : null;
      },
    );
    shelves.push({ id: 'mirror-music', title: 'Trending music', videos: popular });
  } catch { /* the music row is optional */ }

  return { shelves };
}

export async function searchMirror(query: string): Promise<YtSearchResult> {
  const videos = await mirrorFetch(
    {
      piped: `/search?q=${encodeURIComponent(query)}&filter=videos`,
      invidious: `/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
    },
    (payload, kind) => {
      const items = videoList(payload, kind);
      return items.length ? items : null;
    },
  );
  return { videos, channels: [] };
}

/** Music-only results — no live news, no podcasts, nothing without a length. */
export async function searchMirrorMusic(query: string): Promise<YtSearchResult> {
  const videos = await mirrorFetch(
    {
      piped: `/search?q=${encodeURIComponent(query)}&filter=music_videos`,
      invidious: `/api/v1/search?q=${encodeURIComponent(query)}&type=video&sort_by=relevance`,
    },
    (payload, kind) => {
      const items = videoList(payload, kind).filter(isMusicVideo);
      return items.length ? items : null;
    },
  );
  return { videos, channels: [] };
}

export async function fetchMirrorMusic(): Promise<YtHome> {
  const shelves: YtShelf[] = [];
  try {
    const trending = await mirrorFetch(
      { piped: '/trending?region=US&type=music', invidious: '/api/v1/trending?type=Music' },
      (payload, kind) => {
        const videos = videoList(payload, kind).filter(isMusicVideo);
        return videos.length ? videos : null;
      },
    );
    shelves.push({ id: 'mirror-music-trending', title: 'Trending in music', videos: trending });
  } catch { /* fall through to the search rows */ }

  for (const [id, title, query] of [
    ['mirror-music-hits', 'Top hits right now', 'top hits this week'],
    ['mirror-music-mixes', 'Mixes & playlists', 'lofi hip hop mix'],
  ] as const) {
    try {
      const payload = await searchMirrorMusic(query);
      if (payload.videos.length) shelves.push({ id, title, videos: payload.videos });
    } catch { /* each row is optional */ }
  }

  if (!shelves.length) throw new Error('Every music mirror failed too.');
  return { shelves };
}

/** "1:02:03" / "3:33" → seconds; anything unparseable is 0. */
export function durationSeconds(value?: string): number {
  if (!value) return 0;
  const parts = value.split(':').map((part) => Number(part));
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Music-tab heuristic: drop live streams, zero-length rows (news bulletins
 * report "0:00"), and clips too short to be a track. Keeps the tab from filling
 * up with the news/podcast rows YouTube mixes into its music recommendations.
 */
export function isMusicVideo(video: YtVideo): boolean {
  if (video.live) return false;
  return durationSeconds(video.duration) >= 45;
}

export async function fetchMirrorChannel(channelId: string): Promise<YtChannelFeed> {
  const payload = await mirrorFetch(
    {
      piped: `/channel/${encodeURIComponent(channelId)}`,
      invidious: `/api/v1/channels/${encodeURIComponent(channelId)}`,
    },
    (raw, kind) => {
      const record = raw as Record<string, unknown>;
      const videos = videoList(
        kind === 'piped' ? record.relatedStreams : record.latestVideos,
        kind,
      );
      return videos.length ? raw : null;
    },
  ) as Record<string, unknown>;

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

export async function fetchMirrorDetail(videoId: string): Promise<YtDetail> {
  const payload = await mirrorFetch(
    {
      piped: `/streams/${encodeURIComponent(videoId)}`,
      invidious: `/api/v1/videos/${encodeURIComponent(videoId)}`,
    },
    (raw) => {
      const record = raw as Record<string, unknown>;
      const hasTitle = typeof record.title === 'string' && record.title.length > 0;
      return hasTitle ? raw : null;
    },
  ) as Record<string, unknown>;

  const isInvidious = 'authorId' in payload || 'videoThumbnails' in payload;
  const relatedRaw = isInvidious ? payload.recommendedVideos : payload.relatedStreams;
  const related = videoList(relatedRaw, isInvidious ? 'invidious' : 'piped').filter((video) => video.id !== videoId);

  const audioSource = isInvidious ? payload.adaptiveFormats : payload.audioStreams;
  const audioTracks = (Array.isArray(audioSource) ? audioSource : [])
    .map((raw) => {
      const stream = raw as Record<string, unknown>;
      const mime = String(stream.mimeType ?? stream.type ?? 'audio/webm');
      return {
        url: str(stream.url) || '',
        mime,
        bitrate: num(stream.bitrate) ?? 0,
        label: `${Math.round((num(stream.bitrate) ?? 0) / 1000)} kbps`,
      };
    })
    .filter((track) => track.url.startsWith('https://') && track.mime.startsWith('audio'))
    .sort((a, b) => b.bitrate - a.bitrate)
    .map((track) => ({ ...track, label: `${track.label} · ${track.mime.split(';')[0].replace('audio/', '').toUpperCase()}` }));

  const chapterSource = Array.isArray(payload.chapters)
    ? payload.chapters
    : Array.isArray(payload.storyboards)
      ? payload.storyboards
      : [];
  const chapters = (chapterSource as Array<Record<string, unknown>>)
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
    description: String(payload.description ?? payload.descriptionHtml ?? ''),
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
    likes: num(payload.likes) !== undefined
      ? (num(payload.likes) as number).toLocaleString()
      : str(payload.likeCount),
    lengthSeconds: num(payload.duration) ?? num(payload.lengthSeconds),
    live: Boolean(payload.livestream ?? payload.liveNow),
    thumbnail: str(payload.thumbnailUrl) || str(bestThumb?.url) || thumbFor(videoId),
    keywords: Array.isArray(payload.tags) ? (payload.tags as string[]).slice(0, 12).filter((tag) => typeof tag === 'string') : undefined,
    comments: [],
    related: related.slice(0, 24),
    chapters,
    audioTracks,
    embedUrl: youtubeEmbedUrl(videoId),
  };
}

/**
 * Direct YouTube first (nobody else sees the request), mirrors second, and the
 * direct error is surfaced if both fail so the message stays actionable.
 */
export async function withMirrorFallback<T>(direct: () => Promise<T>, mirror: () => Promise<T>): Promise<FlowSource<T>> {
  try {
    return { data: await direct(), backend: 'youtube' };
  } catch (directError) {
    try {
      return { data: await mirror(), backend: 'mirror' };
    } catch (mirrorError) {
      // Keep YouTube's answer first — it is the actionable one — and name the
      // mirror failure after it so the settings panel makes sense.
      throw new Error(`${describeFailure(directError)}. Mirrors: ${describeFailure(mirrorError)}.`);
    }
  }
}

/** Browser network failures are opaque ("Failed to fetch"); say what it means. */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'unknown error');
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return 'the request was blocked before it reached the server (CORS or offline)';
  }
  return message.replace(/\s+$/, '').replace(/[.\s]+$/, '');
}
