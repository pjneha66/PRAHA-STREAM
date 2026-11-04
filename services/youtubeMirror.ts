/**
 * Flow tab — mirror tier.
 *
 * YouTube's own key-free endpoints block or rate-limit a lot of client IPs
 * (HTTP 429/500), which left the tab showing "YouTube did not answer". When the
 * direct tier fails, the tab retries through the community-run Piped /
 * Invidious JSON APIs that Flow-style clients use, normalising their payloads
 * into the same shapes as `youtubeService`. Direct YouTube is always tried
 * first, so a mirror only ever sees requests YouTube already refused.
 */

import { nativeFetchText } from './androidBridge';
import {
  formatDuration, thumbFor, youtubeEmbedUrl,
  type YtChapter, type YtDetail, type YtHome, type YtSearchResult, type YtShelf,
  type YtChannelFeed, type YtVideo,
} from './youtubeService';

export type YtBackend = 'youtube' | 'mirror';

export interface FlowSource<T> {
  data: T;
  /** Which tier answered. `mirror` means a third-party instance answered. */
  backend: YtBackend;
}

export const MIRROR_STORAGE_KEY = 'praha.v2.flow-mirrors';

export const DEFAULT_MIRRORS = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.drgns.space',
  'https://pipedapi.reallyaweso.me',
  'https://piped-api.privesc.eu',
];

/** The first mirror that answered; reused so later calls are not re-probed. */
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

async function mirrorJson(path: string): Promise<unknown> {
  const bases = readMirrors();
  let lastError = 'No mirror answered.';
  for (const base of bases) {
    try {
      const response = await nativeFetchText(`${base}${path}`, {
        timeoutMs: 12000,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        lastError = `${new URL(base).host} answered ${response.status}`;
        continue;
      }
      const parsed = JSON.parse(response.data) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).error) {
        lastError = String((parsed as Record<string, unknown>).error);
        continue;
      }
      preferredMirror = base;
      return parsed;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Mirror request failed.';
    }
  }
  throw new Error(lastError);
}

const mirrorThumb = (value: unknown): string | undefined =>
  (typeof value === 'string' && value ? value : undefined);

interface PipedStream {
  title?: string;
  url?: string;
  thumbnail?: string;
  uploaderName?: string;
  uploaderUrl?: string;
  duration?: number;
  views?: number;
  uploadedDate?: string;
  uploaded?: number;
}

/** Piped reports watch links as `/watch?v=ID`; keep only the id. */
export function pipedVideo(entry: PipedStream): YtVideo | null {
  const id = typeof entry.url === 'string' ? entry.url.replace(/^.*[?&]v=/, '').split('&')[0] : '';
  if (!/^[\w-]{11}$/.test(id)) return null;
  return {
    id,
    title: entry.title || 'Untitled video',
    channel: entry.uploaderName,
    channelId: typeof entry.uploaderUrl === 'string' ? entry.uploaderUrl.replace(/^\/channel\//, '') : undefined,
    views: typeof entry.views === 'number' && entry.views >= 0 ? `${entry.views.toLocaleString()} views` : undefined,
    published: entry.uploadedDate || (entry.uploaded ? new Date(entry.uploaded).toLocaleDateString() : undefined),
    duration: typeof entry.duration === 'number' && entry.duration > 0 ? formatDuration(entry.duration) : undefined,
    thumbnail: mirrorThumb(entry.thumbnail) || thumbFor(id),
  };
}

const pipedList = (payload: unknown): YtVideo[] => (Array.isArray(payload) ? payload : [])
  .map((entry) => pipedVideo(entry as PipedStream))
  .filter((video): video is YtVideo => Boolean(video));

export async function fetchMirrorHome(): Promise<YtHome> {
  const [trending, music] = await Promise.all([
    mirrorJson('/trending?region=US').catch(() => []),
    mirrorJson('/trending?region=US&type=music').catch(() => []),
  ]);
  const shelves: YtShelf[] = [];
  const trendingVideos = pipedList(trending);
  if (trendingVideos.length) shelves.push({ id: 'mirror-trending', title: 'Trending now', videos: trendingVideos });
  const musicVideos = pipedList(music);
  if (musicVideos.length) shelves.push({ id: 'mirror-music', title: 'Trending music', videos: musicVideos });
  if (!shelves.length) throw new Error('Every YouTube mirror failed too.');
  return { shelves };
}

export async function searchMirror(query: string): Promise<YtSearchResult> {
  const payload = await mirrorJson(`/search?q=${encodeURIComponent(query)}&filter=videos`) as Record<string, unknown>;
  return { videos: pipedList(payload.items).filter((video) => video.title !== 'Untitled video'), channels: [] };
}

export async function fetchMirrorChannel(channelId: string): Promise<YtChannelFeed> {
  const payload = await mirrorJson(`/channel/${encodeURIComponent(channelId)}`) as Record<string, unknown>;
  const videos = pipedList(payload.relatedStreams);
  if (!videos.length) throw new Error('That mirror returned no uploads for this channel.');
  return {
    channelId,
    title: String(payload.name ?? 'YouTube channel'),
    description: typeof payload.description === 'string' ? payload.description : undefined,
    avatar: mirrorThumb(payload.avatarUrl),
    banner: mirrorThumb(payload.bannerUrl),
    subscribers: typeof payload.subscriberCount === 'number' ? `${payload.subscriberCount.toLocaleString()} subscribers` : undefined,
    videos,
  };
}

export async function fetchMirrorDetail(videoId: string): Promise<YtDetail> {
  const payload = await mirrorJson(`/streams/${encodeURIComponent(videoId)}`) as Record<string, unknown>;

  const related = pipedList(payload.relatedStreams).filter((video) => video.id !== videoId);

  const audioStreams = (Array.isArray(payload.audioStreams) ? payload.audioStreams : []) as Array<Record<string, unknown>>;
  const audioTracks = audioStreams
    .map((stream) => ({
      url: typeof stream.url === 'string' ? stream.url : '',
      mime: String(stream.mimeType ?? 'audio/webm'),
      bitrate: Number(stream.bitrate || 0),
      label: `${Math.round(Number(stream.bitrate || 0) / 1000)} kbps · ${String(stream.codec ?? 'audio').toUpperCase()}`,
    }))
    .filter((track) => track.url.startsWith('https://'))
    .sort((a, b) => b.bitrate - a.bitrate);

  const chapters = (Array.isArray(payload.chapters) ? payload.chapters : [])
    .map((chapter) => {
      const record = chapter as Record<string, unknown>;
      const title = String(record.title ?? '').trim();
      const start = Number(record.start ?? NaN);
      return title && Number.isFinite(start) ? { title, start } : null;
    })
    .filter((chapter): chapter is YtChapter => Boolean(chapter))
    .sort((a, b) => a.start - b.start);

  return {
    id: videoId,
    title: String(payload.title ?? 'YouTube video'),
    description: String(payload.description ?? ''),
    channel: String(payload.uploader ?? 'YouTube'),
    channelId: typeof payload.uploaderUrl === 'string' ? payload.uploaderUrl.replace(/^\/channel\//, '') : undefined,
    channelAvatar: mirrorThumb(payload.uploaderAvatar),
    channelSubscribers: typeof payload.uploaderSubscriberCount === 'number'
      ? `${payload.uploaderSubscriberCount.toLocaleString()} subscribers`
      : undefined,
    views: typeof payload.views === 'number' ? `${payload.views.toLocaleString()} views` : undefined,
    published: typeof payload.uploadDate === 'string' ? payload.uploadDate : undefined,
    likes: typeof payload.likes === 'number' ? payload.likes.toLocaleString() : undefined,
    lengthSeconds: Number(payload.duration ?? 0) || undefined,
    live: Boolean(payload.livestream),
    thumbnail: mirrorThumb(payload.thumbnailUrl) || thumbFor(videoId),
    keywords: Array.isArray(payload.tags) ? (payload.tags as string[]).slice(0, 12) : undefined,
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
    } catch {
      throw directError;
    }
  }
}
