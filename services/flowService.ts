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

export function youtubeStream(video: FlowVideoRef): StreamResult {
  return {
    id: `youtube:${video.id}`,
    title: video.title,
    url: youtubeWatchUrl(video.id),
    sourceName: 'YouTube · Flow',
    sourceType: 'nuvio',
    provider: 'flow',
    format: 'youtube',
    externalUrl: youtubeWatchUrl(video.id),
    ytId: video.id,
  };
}

export { DEFAULT_MIRRORS, MIRROR_STORAGE_KEY, normalizeMirrorUrl, readMirrors, isMusicVideo } from './youtubeMirror';
export type { FlowSource, MirrorKind, YtBackend } from './youtubeMirror';

export const flowHome = () => withMirrorFallback<YtHome>(fetchYoutubeHome, fetchMirrorHome);
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
    () => searchMirrorMusic(query),
  );
export const flowDetail = (videoId: string) =>
  withMirrorFallback<YtDetail>(() => fetchYoutubeDetail(videoId), () => fetchMirrorDetail(videoId));
export const flowChannel = (channelId: string) =>
  withMirrorFallback<YtChannelFeed>(() => fetchYoutubeChannel(channelId), () => fetchMirrorChannel(channelId));
