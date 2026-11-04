/**
 * Flow tab — data facade.
 *
 * The tab always calls these functions rather than the raw services so every
 * request gets the documented order of preference: YouTube's own key-free
 * endpoints first, community mirrors only when YouTube refuses (429/500/block).
 * Each result reports which tier answered, so the UI can say so honestly.
 */

import {
  fetchYoutubeChannel, fetchYoutubeDetail, fetchYoutubeHome, searchYoutube, youtubeWatchUrl,
  type YtChannelFeed, type YtDetail, type YtHome, type YtSearchResult, type YtVideo,
} from './youtubeService';
import {
  fetchMirrorChannel, fetchMirrorDetail, fetchMirrorHome, fetchMirrorMusic, isMusicVideo,
  searchMirror, searchMirrorMusic, withMirrorFallback,
} from './youtubeMirror';
import type { FlowSource } from './youtubeMirror';
import type { MediaItem, StreamResult } from '../types';

/** Minimal video shape the Flow cards and player mapping need. */
export type FlowVideoRef = Pick<YtVideo, 'id' | 'title' | 'channel' | 'thumbnail' | 'duration' | 'views' | 'published'>;

/** Turn a Flow video into the MediaItem-shaped record PRAHA's player expects. */
export function youtubeMedia(video: FlowVideoRef, fallbackId = 'youtube:unknown'): MediaItem {
  return {
    id: `youtube:${video.id || fallbackId}`,
    type: 'movie',
    title: video.title || 'YouTube video',
    overview: '',
    poster: video.thumbnail || '',
    backdrop: video.thumbnail || '',
    year: video.published,
    genres: ['YouTube'],
    source: 'youtube',
  };
}

/**
 * Player payload for a Flow video. When the detail request returned a direct
 * stream, that URL is used so PRAHA's own player (MpvPlayer / HTML5) plays it
 * without YouTube's embed, which blocks localhost and preview origins.
 */
export function youtubeStream(
  video: FlowVideoRef,
  media?: { url?: string; format?: 'audio' | 'video' },
): StreamResult {
  return {
    id: `youtube:${video.id}`,
    title: video.title,
    sourceName: 'YouTube · Flow',
    sourceType: 'nuvio',
    provider: 'flow',
    format: media?.url ? (media.format === 'audio' ? 'audio' : 'mp4') : 'youtube',
    externalUrl: youtubeWatchUrl(video.id),
    // Keep ytId only when there is no direct URL: PlayerModal then falls back to
    // the embed, which is the right behaviour for blocked-origin environments.
    ytId: media?.url ? undefined : video.id,
    url: media?.url || youtubeWatchUrl(video.id),
  };
}

export { DEFAULT_MIRRORS, MIRROR_STORAGE_KEY, normalizeMirrorUrl, readMirrors, isMusicVideo } from './youtubeMirror';
export { lastProbeLog, describeFailure, probeMirrors, resetDirectState, type SourceProbe } from './youtubeMirror';

/**
 * YouTube's image CDN sends no CORS headers, but `<img>` does not need them —
 * yet a missing referer or a blocked CDN can still fail. This free image proxy
 * is only used as an `onError` fallback for thumbnails, never for data.
 */
export function proxiedImage(url?: string, width = 480): string | undefined {
  if (!url || !/^https:\/\//i.test(url)) return undefined;
  return `https://images.weserv.nl/?url=${encodeURIComponent(url.replace(/^https:\/\//i, ''))}&w=${width}&output=webp`;
}
export type { FlowSource, MirrorKind, YtBackend } from './youtubeMirror';

export const flowHome = (): Promise<FlowSource<YtHome>> =>
  cached(listCache as unknown as Map<string, { at: number; value: Promise<FlowSource<YtHome>> }>,
    'home', LIST_TTL, () => withMirrorFallback<YtHome>(fetchYoutubeHome, fetchMirrorHome));
export const flowMusicHome = () => withMirrorFallback<YtHome>(
  async () => {
    const home = await fetchYoutubeHome();
    const shelves = home.shelves
      .map((shelf) => ({ ...shelf, videos: shelf.videos.filter(isMusicVideo) }))
      .filter((shelf) => /music|mix|song|album|playlist|radio/i.test(shelf.title) && shelf.videos.length);
    if (!shelves.length) throw new Error('YouTube returned no music shelves.');
    return { shelves };
  },
  fetchMirrorMusic,
);
/** Mirror-only variants, used by "Mirrors only" retries after YouTube is ruled out. */
export const flowHomeViaMirror = async (): Promise<FlowSource<YtHome>> => ({
  data: await fetchMirrorHome(), backend: 'mirror',
});
export const flowMusicViaMirror = async (): Promise<FlowSource<YtHome>> => ({
  data: await fetchMirrorMusic(), backend: 'mirror',
});

export const flowSearch = (query: string) =>
  withMirrorFallback<YtSearchResult>(() => searchYoutube(query), () => searchMirror(query));
export const flowMusicSearch = (query: string) =>
  withMirrorFallback<YtSearchResult>(
    async () => {
      const result = await searchYoutube(`${query} music`);
      const videos = result.videos.filter(isMusicVideo);
      if (!videos.length) throw new Error('No music results from YouTube.');
      return { ...result, videos, channels: [] };
    },
    async () => {
      try {
        return await searchMirrorMusic(query);
      } catch (musicError) {
        // Some instances only implement the plain video search; filter it here.
        const broad = await searchMirror(query);
        const videos = broad.videos.filter(isMusicVideo);
        if (!videos.length) throw musicError;
        return { ...broad, videos, channels: [] };
      }
    },
  );
/** Short-lived caches: re-opening a video or a shelf is instant instead of re-fetching. */
const DETAIL_TTL = 10 * 60 * 1000;
const LIST_TTL = 3 * 60 * 1000;
const detailCache = new Map<string, { at: number; value: Promise<FlowSource<YtDetail>> }>();
const listCache = new Map<string, { at: number; value: Promise<FlowSource<unknown>> }>();

function cached<T>(store: Map<string, { at: number; value: Promise<T> }>, key: string, ttl: number, run: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = run();
  store.set(key, { at: Date.now(), value });
  // A failed request must not poison the cache.
  value.catch(() => { if (store.get(key)?.value === value) store.delete(key); });
  return value;
}

/** Clears the caches — used by Retry so a stale failure is never replayed. */
export function resetFlowCache(): void {
  detailCache.clear();
  listCache.clear();
}

export const flowDetail = (videoId: string) =>
  cached(detailCache as unknown as Map<string, { at: number; value: Promise<FlowSource<YtDetail>> }>,
    videoId, DETAIL_TTL, () => flowDetailUncached(videoId));

const flowDetailUncached = (videoId: string) =>
  withMirrorFallback<YtDetail>(() => fetchYoutubeDetail(videoId), () => fetchMirrorDetail(videoId));
export const flowChannel = (channelId: string) =>
  withMirrorFallback<YtChannelFeed>(() => fetchYoutubeChannel(channelId), () => fetchMirrorChannel(channelId));
