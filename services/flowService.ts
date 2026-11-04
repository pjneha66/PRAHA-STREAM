/**
 * Flow tab — data facade.
 *
 * The tab always calls these functions rather than the raw services so every
 * request gets the documented order of preference: YouTube's own key-free
 * endpoints first, community mirrors only when YouTube refuses (429/500/block).
 * Each result reports which tier answered, so the UI can say so honestly.
 */

import {
  fetchYoutubeChannel, fetchYoutubeDetail, fetchYoutubeHome, searchYoutube,
  type YtChannelFeed, type YtDetail, type YtHome, type YtSearchResult,
} from './youtubeService';
import {
  fetchMirrorChannel, fetchMirrorDetail, fetchMirrorHome, searchMirror, withMirrorFallback,
} from './youtubeMirror';

export { DEFAULT_MIRRORS, MIRROR_STORAGE_KEY, normalizeMirrorUrl, readMirrors } from './youtubeMirror';
export type { FlowSource, YtBackend } from './youtubeMirror';

export const flowHome = () => withMirrorFallback<YtHome>(fetchYoutubeHome, fetchMirrorHome);
export const flowSearch = (query: string) =>
  withMirrorFallback<YtSearchResult>(() => searchYoutube(query), () => searchMirror(query));
export const flowDetail = (videoId: string) =>
  withMirrorFallback<YtDetail>(() => fetchYoutubeDetail(videoId), () => fetchMirrorDetail(videoId));
export const flowChannel = (channelId: string) =>
  withMirrorFallback<YtChannelFeed>(() => fetchYoutubeChannel(channelId), () => fetchMirrorChannel(channelId));
