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
import type { MediaItem, StreamResult } from '../types';
import {
  fetchMirrorChannel, fetchMirrorDetail, fetchMirrorHome, searchMirror, withMirrorFallback,
} from './youtubeMirror';

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

export { DEFAULT_MIRRORS, MIRROR_STORAGE_KEY, normalizeMirrorUrl, readMirrors } from './youtubeMirror';
export type { FlowSource, YtBackend } from './youtubeMirror';

export const flowHome = () => withMirrorFallback<YtHome>(fetchYoutubeHome, fetchMirrorHome);
export const flowSearch = (query: string) =>
  withMirrorFallback<YtSearchResult>(() => searchYoutube(query), () => searchMirror(query));
export const flowDetail = (videoId: string) =>
  withMirrorFallback<YtDetail>(() => fetchYoutubeDetail(videoId), () => fetchMirrorDetail(videoId));
export const flowChannel = (channelId: string) =>
  withMirrorFallback<YtChannelFeed>(() => fetchYoutubeChannel(channelId), () => fetchMirrorChannel(channelId));
