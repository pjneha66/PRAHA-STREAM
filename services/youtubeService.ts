/**
 * Key-free YouTube data for the Flow tab.
 *
 * The tab is modelled after https://github.com/Flow-Tube/Flow — a privacy-first
 * YouTube / YouTube Music client — and reuses the same public, key-less data
 * source Flow's web (non-Extractor) tier reads: the YouTube InnerTube
 * `youtubei/v1` web endpoints, plus plain RSS for channel feeds.
 *
 * Nothing is proxied through a third-party service and no API key or account is
 * required. On the Android build the request is issued by the native HTTP
 * bridge, which also dodges browser CORS.
 *
 * Everything here talks to YouTube directly. Nothing is proxied through this
 * app's own dev server or a third party — `vite.config.ts` only relays the other
 * metadata APIs (AniCore, Sanka, IMDx). YouTube's CDN *images* are not
 * CORS-enabled, so thumbnails are loaded as plain `<img>` sources.
 */

import { nativeFetchText } from './androidBridge';

const INNERTUBE_ORIGIN = 'https://www.youtube.com';
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const CLIENT_VERSION = '2.20240101.00.00';
const INTERNET_RADIO_URL = 'https://stream-relay-geo.ntslive.net/stream';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface YtVideo {
  id: string;
  title: string;
  channel?: string;
  channelId?: string;
  /** Human-readable view count, e.g. "1.2M views". */
  views?: string;
  /** Human-readable publish time, e.g. "3 days ago". */
  published?: string;
  /** Length, e.g. "12:04". */
  duration?: string;
  thumbnail?: string;
  live?: boolean;
}

export interface YtShelf {
  id: string;
  title: string;
  videos: YtVideo[];
}

export interface YtHome {
  shelves: YtShelf[];
}

export interface YtSearchResult {
  videos: YtVideo[];
  channels: Array<{ id: string; name: string; handle?: string; subscribers?: string; thumbnail?: string; description?: string }>;
  continuation?: string;
}

export interface YtChannelFeed {
  channelId: string;
  title: string;
  description?: string;
  avatar?: string;
  banner?: string;
  subscribers?: string;
  videos: YtVideo[];
}

export interface YtComment {
  id: string;
  author: string;
  avatar?: string;
  text: string;
  likes?: string;
  published?: string;
  replies?: number;
}

export interface YtChapter {
  title: string;
  /** Seconds. */
  start: number;
}

export interface YtMediaTrack {
  url: string;
  mime: string;
  bitrate?: number;
  label: string;
  /** Rough height in pixels for video tracks. */
  height?: number;
}

export interface YtDetail {
  id: string;
  title: string;
  description: string;
  channel: string;
  channelId?: string;
  channelAvatar?: string;
  channelSubscribers?: string;
  views?: string;
  published?: string;
  likes?: string;
  /** Seconds. */
  lengthSeconds?: number;
  live?: boolean;
  thumbnail?: string;
  keywords?: string[];
  comments: YtComment[];
  related: YtVideo[];
  chapters: YtChapter[];
  /** Streamable audio-only URLs, best first. */
  audioTracks: YtMediaTrack[];
  /** Streamable muxed (video+audio) URLs, best first — used when the embed refuses. */
  videoTracks: YtMediaTrack[];
  /** Best muxed stream URL, ready for a `<video>` element. */
  playbackUrl?: string;
  /** Embedded player fallback when direct playback is unavailable. */
  embedUrl: string;
}

export interface YtMusicSection {
  title: string;
  items: Array<{ id: string; title: string; subtitle?: string; thumbnail?: string; kind: 'song' | 'video' | 'album' | 'artist' | 'playlist' }>;
}


/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function normalizeChannelInput(input: string): string {
  const term = input.trim();
  if (!term) throw new Error('Enter a channel URL, @handle, or channel ID.');
  if (/^UC[\w-]{20,}$/.test(term)) return term;
  const url = term.startsWith('http') ? term : term.startsWith('@') ? `https://www.youtube.com/${term}` : `https://www.youtube.com/@${term}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That does not look like a YouTube channel.');
  }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(parsed.hostname)) {
    throw new Error('Only youtube.com channel links are supported.');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0] === 'channel' && parts[1] && /^UC[\w-]{20,}$/.test(parts[1])) return parts[1];
  if (parts[0]?.startsWith('@')) return `@${parts[0].slice(1)}`;
  if (parts[0] === 'c' || parts[0] === 'user') return parts[1] ? `${parts[0]}/${parts[1]}` : term;
  throw new Error('Use a /channel/, /@handle/, /c/, or /user/ channel link.');
}

export const youtubeWatchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
export const youtubeChannelUrl = (channelId: string) => `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`;
export const youtubeEmbedUrl = (videoId: string, startSeconds = 0) =>
  `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?rel=0&modestbranding=1${startSeconds > 0 ? `&start=${Math.floor(startSeconds)}` : ''}`;

/** Accepts a raw ID, youtu.be short link, /shorts/ link, or a full watch URL. */
export function parseVideoId(input: string): string {
  const term = input.trim();
  if (!term) throw new Error('Paste a YouTube link or video ID.');
  if (/^[\w-]{11}$/.test(term)) return term;

  let url: URL;
  try {
    url = new URL(term.startsWith('http') ? term : `https://${term.replace(/^\/+/, '')}`);
  } catch {
    throw new Error('Could not find a video ID in that link.');
  }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(url.hostname)) {
    throw new Error('Only YouTube links are supported.');
  }
  if (/(^|\.)youtu\.be$/i.test(url.hostname)) {
    const id = url.pathname.split('/').filter(Boolean)[0];
    if (id && /^[\w-]{11}$/.test(id)) return id;
  }
  const param = url.searchParams.get('v');
  if (param && /^[\w-]{11}$/.test(param)) return param;
  const parts = url.pathname.split('/').filter(Boolean);
  if (['shorts', 'embed', 'live', 'v'].includes(parts[0] || '') && parts[1] && /^[\w-]{11}$/.test(parts[1])) {
    return parts[1];
  }
  throw new Error('Could not find a video ID in that link.');
}

export function parseIsoDuration(value?: string): number | undefined {
  if (!value) return undefined;
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(value.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  const total = Number(days || 0) * 86400 + Number(hours || 0) * 3600 + Number(minutes || 0) * 60 + Number(seconds || 0);
  return total > 0 ? total : undefined;
}

export function formatDuration(totalSeconds?: number): string | undefined {
  if (!totalSeconds || totalSeconds <= 0) return undefined;
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

export const thumbFor = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

export function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const node = value as Record<string, unknown>;
  if (typeof node.simpleText === 'string') return node.simpleText.trim() || undefined;
  if (Array.isArray(node.runs)) {
    const text = node.runs
      .map((run) => (run && typeof run === 'object' ? String((run as Record<string, unknown>).text ?? '') : ''))
      .join('')
      .trim();
    return text || undefined;
  }
  if (typeof node.content === 'string') return node.content.trim() || undefined;
  return undefined;
}

function endpointOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.watchEndpoint && typeof record.watchEndpoint === 'object') return record.watchEndpoint as Record<string, unknown>;
  if (record.watchPlaylistEndpoint && typeof record.watchPlaylistEndpoint === 'object') return record.watchPlaylistEndpoint as Record<string, unknown>;
  if (record.browseEndpoint && typeof record.browseEndpoint === 'object') return record.browseEndpoint as Record<string, unknown>;
  const command = record.commandExecutorCommand as Record<string, unknown> | undefined;
  if (command && typeof command.commands === 'object') {
    const commands = command.commands as Array<Record<string, unknown>>;
    for (const entry of commands) if (entry?.watchEndpoint) return entry.watchEndpoint as Record<string, unknown>;
  }
  return undefined;
}

function videoFromRenderer(renderer: Record<string, unknown>): YtVideo | null {
  const id = String(renderer.videoId ?? '');
  if (!/^[\w-]{11}$/.test(id)) return null;
  const title = textOf(renderer.title) || textOf(renderer.headline) || 'Untitled video';
  const thumbs = ((renderer.thumbnail as Record<string, unknown> | undefined)?.thumbnails as Array<Record<string, unknown>> | undefined) || [];
  const best = thumbs[thumbs.length - 1];
  return {
    id,
    title,
    channel: textOf(renderer.longBylineText) || textOf(renderer.shortBylineText) || textOf(renderer.ownerText),
    channelId: String((endpointOf(renderer.longBylineText) || endpointOf(renderer.shortBylineText) || endpointOf(renderer.ownerText) || {}).browseId ?? '') || undefined,
    views: textOf(renderer.viewCountText) || textOf(renderer.shortViewCountText) || textOf(renderer.videoInfo),
    published: textOf(renderer.publishedTimeText),
    duration: textOf(renderer.lengthText),
    thumbnail: (typeof best?.url === 'string' ? best.url : undefined) || thumbFor(id),
    live: Boolean(renderer.isLiveNow || /watching|live/i.test(textOf(renderer.viewCountText) || '')),
  };
}

export function collectShelves(node: unknown, shelves: YtShelf[], depth = 0, maxDepth = 9): void {
  if (!node || typeof node !== 'object' || depth > maxDepth) return;
  if (Array.isArray(node)) {
    for (const child of node) collectShelves(child, shelves, depth, maxDepth);
    return;
  }
  const record = node as Record<string, unknown>;

  const shelfRenderer = record.shelfRenderer as Record<string, unknown> | undefined;
  if (shelfRenderer) {
    const title = textOf(shelfRenderer.title) || textOf(shelfRenderer.headline) || '';
    const videos = collectVideos(shelfRenderer.content ?? shelfRenderer);
    if (title && videos.length) shelves.push({ id: `shelf-${shelves.length}`, title, videos });
    return;
  }
  const richShelf = record.richShelfRenderer as Record<string, unknown> | undefined;
  if (richShelf) {
    const title = textOf(richShelf.title) || '';
    const videos = collectVideos(richShelf.contents ?? richShelf);
    if (title && videos.length) shelves.push({ id: `shelf-${shelves.length}`, title, videos });
    return;
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') collectShelves(value, shelves, depth + 1, maxDepth);
  }
}

/** Depth-first walk that pulls every video renderer out of an arbitrary payload. */
export function collectVideos(node: unknown, depth = 0): YtVideo[] {
  const found: YtVideo[] = [];
  const seen = new Set<string>();
  const walk = (value: unknown, level: number) => {
    if (!value || typeof value !== 'object' || level > 12) return;
    if (Array.isArray(value)) { value.forEach((child) => walk(child, level)); return; }
    const record = value as Record<string, unknown>;
    const renderer = (record.videoRenderer || record.gridVideoRenderer || record.compactVideoRenderer || record.playlistVideoRenderer || record.reelItemRenderer) as Record<string, unknown> | undefined;
    if (renderer) {
      const video = videoFromRenderer(renderer);
      if (video && !seen.has(video.id)) { seen.add(video.id); found.push(video); }
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') walk(child, level + 1);
    }
  };
  walk(node, depth);
  return found;
}

export function collectComments(node: unknown): YtComment[] {
  const found: YtComment[] = [];
  const seen = new Set<string>();
  const walk = (value: unknown, level: number) => {
    if (!value || typeof value !== 'object' || level > 14 || found.length >= 20) return;
    if (Array.isArray(value)) { value.forEach((child) => walk(child, level)); return; }
    const record = value as Record<string, unknown>;
    const renderer = record.commentRenderer || record.commentThreadRenderer;
    if (renderer && typeof renderer === 'object') {
      const body = renderer as Record<string, unknown>;
      const comment = (body.comment ?? body) as Record<string, unknown>;
      const entity = (comment.commentRenderer ?? comment) as Record<string, unknown>;
      const id = String(entity.commentId ?? '');
      const text = textOf(entity.contentText) || textOf(entity.content);
      if (id && text && !seen.has(id)) {
        seen.add(id);
        found.push({
          id,
          author: textOf(entity.authorText) || 'YouTube user',
          avatar: typeof (entity.authorThumbnail as Record<string, unknown> | undefined)?.thumbnails === 'object'
            ? String(((entity.authorThumbnail as { thumbnails: Array<Record<string, unknown>> }).thumbnails[0]?.url) ?? '') || undefined
            : undefined,
          text,
          likes: textOf(entity.voteCount),
          published: textOf(entity.publishedTimeText) || undefined,
          replies: typeof entity.replyCount === 'number' ? entity.replyCount : undefined,
        });
      }
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') walk(child, level + 1);
    }
  };
  walk(node, 0);
  return found;
}

export function collectChapters(node: unknown): YtChapter[] {
  const chapters: YtChapter[] = [];
  const walk = (value: unknown, level: number) => {
    if (!value || typeof value !== 'object' || level > 14) return;
    if (Array.isArray(value)) { value.forEach((child) => walk(child, level)); return; }
    const record = value as Record<string, unknown>;
    const renderer = record.macroMarkersListItemRenderer as Record<string, unknown> | undefined;
    if (renderer) {
      const title = textOf(renderer.title);
      const start = Number(typeof renderer.timeDescription === 'object'
        ? ((renderer.timeDescription as Record<string, unknown>).simpleText as string | undefined)?.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)
        : NaN);
      if (title && Number.isFinite(start)) chapters.push({ title, start });
      return;
    }
    const chapterRenderer = record.chapterRenderer as Record<string, unknown> | undefined;
    if (chapterRenderer) {
      const title = textOf(chapterRenderer.title);
      const time = ((chapterRenderer.timeRangeStartMillis as number | undefined) ?? NaN) / 1000;
      if (title && Number.isFinite(time)) chapters.push({ title, start: time });
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') walk(child, level + 1);
    }
  };
  walk(node, 0);
  return chapters.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

const browserHeaders = { 'Content-Type': 'application/json' };

export async function postInnerTube(path: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${INNERTUBE_ORIGIN}/youtubei/v1/${path}?key=${INNERTUBE_KEY}&prettyPrint=false`;
  const payload = JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'US' } }, ...body });
  const response = await nativeFetchText(url, { method: 'POST', headers: browserHeaders, body: payload, timeoutMs: 20000 });
  if (!response.ok) throw new Error(`YouTube responded with ${response.status}. Try again in a moment.`);
  try {
    return JSON.parse(response.data) as unknown;
  } catch {
    throw new Error('YouTube returned a response PRAHA could not read.');
  }
}

/** Best-effort: key-less endpoints sometimes rate-limit; callers keep their own fallbacks. */
export async function tryInnerTube(path: string, body: Record<string, unknown>): Promise<unknown | undefined> {
  try {
    return await postInnerTube(path, body);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Home / trending
 * ------------------------------------------------------------------ */

export async function fetchYoutubeHome(): Promise<YtHome> {
  const home = await postInnerTube('browse', { browseId: 'FEwhat_to_watch' });
  const shelves: YtShelf[] = [];
  collectShelves(home, shelves);
  if (!shelves.length) {
    const trending = await postInnerTube('browse', { browseId: 'FEtrending' });
    const videos = collectVideos(trending);
    if (videos.length) shelves.push({ id: 'trending', title: 'Trending now', videos });
  }
  if (!shelves.length) throw new Error('YouTube did not return any recommendations. Try refreshing.');
  return { shelves };
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

export async function searchYoutube(term: string): Promise<YtSearchResult> {
  const query = term.trim();
  if (!query) return { videos: [], channels: [] };
  const payload = await postInnerTube('search', { query, params: 'EgIQAQ%3D%3D' });
  const videos = collectVideos(payload);
  const channels: YtSearchResult['channels'] = [];
  const seen = new Set<string>();
  const walk = (value: unknown, level: number) => {
    if (!value || typeof value !== 'object' || level > 11) return;
    if (Array.isArray(value)) { value.forEach((child) => walk(child, level)); return; }
    const record = value as Record<string, unknown>;
    const renderer = record.channelRenderer as Record<string, unknown> | undefined;
    if (renderer) {
      const id = String(renderer.channelId ?? '');
      if (id && !seen.has(id)) {
        seen.add(id);
        const thumbs = ((renderer.thumbnail as Record<string, unknown> | undefined)?.thumbnails as Array<Record<string, unknown>> | undefined) || [];
        channels.push({
          id,
          name: textOf(renderer.title) || 'YouTube channel',
          handle: textOf(renderer.subscriberCountText)?.startsWith('@') ? textOf(renderer.subscriberCountText) : undefined,
          subscribers: textOf(renderer.videoCountText) || textOf(renderer.subscriberCountText),
          thumbnail: typeof thumbs[thumbs.length - 1]?.url === 'string' ? String(thumbs[thumbs.length - 1].url) : undefined,
          description: textOf(renderer.descriptionSnippet),
        });
      }
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') walk(child, level + 1);
    }
  };
  walk(payload, 0);
  return { videos, channels };
}

/* ------------------------------------------------------------------ *
 * Channel feed
 * ------------------------------------------------------------------ */

/** Resolve @handle / c / user / channel URLs to a UC… id using the web page. */
export async function resolveChannelId(input: string): Promise<string> {
  const handle = normalizeChannelInput(input);
  if (/^UC[\w-]{20,}$/.test(handle)) return handle;
  const pageUrl = `${INNERTUBE_ORIGIN}/${handle.replace(/^\/+/, '')}`;
  const response = await nativeFetchText(pageUrl, { timeoutMs: 20000 });
  if (!response.ok) throw new Error(`YouTube returned ${response.status} for that channel.`);
  const match = /"channelId":"(UC[\w-]{20,})"/.exec(response.data) || /channel\/(UC[\w-]{20,})/.exec(response.data);
  if (!match) throw new Error('Could not resolve that channel. Paste the /channel/UC… URL instead.');
  return match[1];
}

export async function fetchYoutubeChannel(channelId: string): Promise<YtChannelFeed> {
  if (!/^UC[\w-]{20,}$/.test(channelId)) throw new Error('That is not a valid YouTube channel ID.');
  const response = await nativeFetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { timeoutMs: 20000 });
  if (!response.ok) throw new Error(`YouTube returned ${response.status} for this channel feed.`);
  const xml = response.data;
  const feedTitle = /<title>([\s\S]*?)<\/title>/.exec(xml)?.[1]?.trim() || 'YouTube channel';
  const entries = xml.split(/<entry>/).slice(1);
  const videos: YtVideo[] = [];
  for (const entry of entries) {
    const id = /<yt:videoId>([\w-]{11})<\/yt:videoId>/.exec(entry)?.[1];
    if (!id) continue;
    const title = decodeXml(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] || 'Untitled video');
    const published = /<published>([\s\S]*?)<\/published>/.exec(entry)?.[1];
    const stars = /<media:starRating[^>]*count="(\d+)"/.exec(entry)?.[1];
    videos.push({
      id,
      title,
      channel: feedTitle,
      channelId,
      thumbnail: /<media:thumbnail[^>]*url="([^"]+)"/.exec(entry)?.[1] || thumbFor(id),
      published: published ? new Date(published).toLocaleDateString() : undefined,
      views: stars ? `${Number(stars).toLocaleString()} ratings` : undefined,
    });
  }
  if (!videos.length) throw new Error('This channel has no public uploads in its feed.');
  return {
    channelId,
    title: feedTitle,
    description: decodeXml(/<media:description>([\s\S]*?)<\/media:description>/.exec(xml)?.[1] || ''),
    avatar: /<media:thumbnail[^>]*url="([^"]+)"/.exec(xml)?.[1],
    videos,
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ *
 * Watch page detail
 * ------------------------------------------------------------------ */

/** InnerTube sometimes omits the URL (signatureCipher) — those formats are skipped. */
export function formatUrl(format: Record<string, unknown>): string {
  if (typeof format.url === 'string' && format.url.startsWith('https://')) return format.url;
  const cipher = typeof format.signatureCipher === 'string'
    ? format.signatureCipher
    : typeof format.cipher === 'string' ? format.cipher : '';
  if (!cipher) return '';
  try {
    const params = new URLSearchParams(cipher);
    const url = params.get('url');
    return url && url.startsWith('https://') ? url : '';
  } catch { return ''; }
}

/** Splits InnerTube adaptive formats into audio-only and muxed video tracks. */
export function parseInnerTubeFormats(formats: Array<Record<string, unknown>>): {
  audioTracks: YtMediaTrack[];
  videoTracks: YtMediaTrack[];
  /** Best muxed stream URL, ready for a `<video>` element. */
  playbackUrl?: string;
} {
  const toTrack = (format: Record<string, unknown>): YtMediaTrack | null => {
    const url = formatUrl(format);
    if (!url) return null;
    const mime = String(format.mimeType ?? '');
    const bitrate = Number(format.bitrate || 0);
    const height = Number((format.height as number | undefined) ?? 0) || undefined;
    return {
      url,
      mime,
      bitrate,
      height,
      label: mime.startsWith('audio/')
        ? `${Math.round(bitrate / 1000)} kbps · ${mime.split(';')[0].replace('audio/', '').toUpperCase()}`
        : `${height ?? '?'}p · ${mime.split(';')[0].replace('video/', '').toUpperCase()}`,
    };
  };

  const audioTracks = formats
    .filter((format) => String(format.mimeType ?? '').startsWith('audio/'))
    .map(toTrack)
    .filter((track): track is YtMediaTrack => Boolean(track))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  const videoTracks = formats
    .filter((format) => String(format.mimeType ?? '').startsWith('video/'))
    // Muxed streams only: an adaptive video track has audioQuality "AUDIO_QUALITY_UNKNOWN".
    .filter((format) => String(format.audioQuality ?? 'AUDIO_QUALITY_UNKNOWN').toUpperCase().includes('AUDIO_QUALITY_') && !/UNKNOWN$/.test(String(format.audioQuality ?? '')))
    .map(toTrack)
    .filter((track): track is YtMediaTrack => Boolean(track))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  return { audioTracks, videoTracks };
}

export async function fetchYoutubeDetail(videoId: string): Promise<YtDetail> {
  const watch = await postInnerTube('player', {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
  }) as Record<string, unknown>;

  const details = (watch.videoDetails ?? {}) as Record<string, unknown>;
  const micro = (watch.microformat ?? {}) as Record<string, unknown>;
  const microPlayer = (micro.playerMicroformatRenderer ?? {}) as Record<string, unknown>;
  const streaming = (watch.streamingData ?? {}) as Record<string, unknown>;
  const formats = (Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : []) as Array<Record<string, unknown>>;

  const { audioTracks, videoTracks } = parseInnerTubeFormats(formats);
  const playbackUrl = videoTracks[0]?.url;

  let comments: YtComment[] = [];
  let related: YtVideo[] = [];
  let chapters: YtChapter[] = [];

  const next = await tryInnerTube('next', { videoId });
  if (next) {
    comments = collectComments(next);
    related = collectVideos(next).filter((video) => video.id !== videoId).slice(0, 24);
    chapters = collectChapters(next);
  }

  if (!chapters.length && streaming) {
    const markers = (streaming.markers as Array<Record<string, unknown>> | undefined) || [];
    for (const marker of markers) {
      const map = (marker.chapters as Array<Record<string, unknown>> | undefined) || [];
      for (const chapter of map) {
        const title = String(chapter.title ?? '').trim();
        const start = Number(chapter.timeRangeStartMillis ?? NaN) / 1000;
        if (title && Number.isFinite(start)) chapters.push({ title, start });
      }
    }
    chapters.sort((a, b) => a.start - b.start);
  }

  const lengthSeconds = Number(details.lengthSeconds ?? microPlayer.lengthSeconds ?? 0) || undefined;
  const thumbSource = ((details.thumbnail as Record<string, unknown> | undefined)?.thumbnails as Array<Record<string, unknown>> | undefined) || [];
  const bestThumb = thumbSource[thumbSource.length - 1];
  const channelId = String(details.channelId ?? microPlayer.externalChannelId ?? '') || undefined;

  return {
    id: videoId,
    title: String(details.title ?? 'YouTube video'),
    description: String(details.shortDescription ?? micro.description ?? ''),
    channel: String(details.author ?? micro.ownerChannelName ?? 'YouTube'),
    channelId,
    channelAvatar: channelId ? `https://yt3.googleusercontent.com/${channelId}` : undefined,
    views: typeof details.viewCount === 'string' ? `${Number(details.viewCount).toLocaleString()} views` : undefined,
    published: String(microPlayer.publishDate ?? details.publishDate ?? '') || undefined,
    likes: typeof details.likeCount === 'string' ? Number(details.likeCount).toLocaleString() : undefined,
    lengthSeconds,
    live: Boolean(details.isLiveContent || details.isLive),
    thumbnail: (typeof bestThumb?.url === 'string' ? String(bestThumb.url) : undefined) || thumbFor(videoId),
    keywords: Array.isArray(details.keywords) ? (details.keywords as string[]).slice(0, 12) : undefined,
    comments,
    related,
    chapters,
    audioTracks,
    videoTracks,
    playbackUrl,
    embedUrl: youtubeEmbedUrl(videoId),
  };
}

/* ------------------------------------------------------------------ *
 * Radio (Flow & YouTube Music tab uses a key-free stream as its "radio")
 * ------------------------------------------------------------------ */

/** NTS Radio's public relay — used for the always-on radio in the Flow tab. */
export const FLOW_RADIO = {
  name: 'NTS Radio · Flow picks',
  url: INTERNET_RADIO_URL,
  description: 'A continuous, account-free radio stream that keeps the Flow tab playing even when YouTube is unreachable.',
};

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export const FLOW_SEARCH_SUGGESTIONS = [
  'lofi hip hop radio',
  'jazz standards',
  'how it\'s made',
  'live news',
  'synthwave mix',
  'documentary 4k',
];


