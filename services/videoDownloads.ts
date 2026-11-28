import { prahaRpc } from './androidBridge';
import type { MediaItem, StreamResult } from '../types';
import { sourceKey, streamQuality } from './sourcePreferences';

const KEY = 'praha.video-downloads.v1';
export const DOWNLOADS_CHANGED = 'praha:video-downloads-changed';

export interface VideoDownload {
  id: string;
  title: string;
}

export interface VideoDownloadStatus {
  state: 'queued' | 'downloading' | 'converting' | 'paused' | 'complete' | 'failed' | 'missing';
  bytes: number;
  total: number;
  duration?: number;
  downloadedDuration?: number;
  error?: string;
  shareable?: boolean;
  canExport?: boolean;
}

export interface VideoDownloadPlan {
  title: string;
  stream: StreamResult;
  export?: boolean;
}

export function videoDownloads(): VideoDownload[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

export function canDownloadVideo(stream: StreamResult): boolean {
  if (stream.sourceType === 'embed' || stream.sourceType === 'iptv' || stream.sourceType === 'torrserver' || stream.ytId || stream.externalUrl) return false;
  try {
    const url = new URL(stream.url);
    return /^https?:$/.test(url.protocol) &&
      !url.username && !url.password && !/\.mpd$/i.test(url.pathname) &&
      !/^(dash|mpd)$/i.test(stream.format ?? '');
  } catch {
    return false;
  }
}

export function planVideoDownload(media: MediaItem, stream: StreamResult, season?: number, episode?: number): VideoDownloadPlan {
  const episodeLabel = media.type === 'series' ? ` S${season ?? 1}E${episode ?? 1}` : '';
  const extension = /\.(mp4|mkv|webm|mov|avi|m4v|ts)$/i.exec(new URL(stream.url).pathname)?.[0] ?? '.mp4';
  return { title: media.title.slice(0, 68) + episodeLabel + (isHls(stream) ? '' : extension), stream };
}

function isHls(stream: StreamResult) {
  return /\.m3u8$/i.test(new URL(stream.url).pathname) || /^(hls|m3u8)$/i.test(stream.format ?? '');
}

function downloadHeight(stream: StreamResult) {
  const quality = streamQuality(stream);
  return quality === '4K' ? 2160 : Number.parseInt(quality, 10) || 0;
}

// Same-language fallback follows Hikari's BatchServerPlanner.
export function matchEpisodeDownload(streams: StreamResult[], wanted: StreamResult): StreamResult | undefined {
  const language = wanted.language?.trim().toLowerCase();
  const candidates = streams.filter((stream) =>
    canDownloadVideo(stream) && (!language || stream.language?.trim().toLowerCase() === language));
  const provider = sourceKey(wanted);
  const sameSource = candidates.filter((stream) => sourceKey(stream) === provider);
  const pool = sameSource.length ? sameSource : candidates;
  const height = downloadHeight(wanted);
  if (!height) return pool[0];
  const distance = (stream: StreamResult) => downloadHeight(stream) ? Math.abs(downloadHeight(stream) - height) : Infinity;
  return pool.reduce<StreamResult | undefined>((best, item) => !best || distance(item) < distance(best) ? item : best, undefined);
}

export async function queueVideoDownloads(plans: VideoDownloadPlan[]): Promise<VideoDownloadPlan[]> {
  const remaining: VideoDownloadPlan[] = [];
  for (const plan of plans) {
    const { title, stream } = plan;
    if (!canDownloadVideo(stream)) {
      remaining.push(plan);
      continue;
    }
    const id = await prahaRpc<string>('queueHikariDownload', [JSON.stringify({
      url: stream.url, title: title.replace(/\.(mp4|mkv|webm|mov|avi|m4v|ts)$/i, ''),
      headers: { ...(stream.referer ? { Referer: stream.referer } : {}), ...stream.headers },
      hls: isHls(stream), height: downloadHeight(stream), export: Boolean(plan.export),
    })]).catch(() => '');
    if (!id) {
      remaining.push(plan);
      continue;
    }
    window.dispatchEvent(new Event(DOWNLOADS_CHANGED));
  }
  return remaining;
}

export async function allVideoDownloads() {
  const rows = await prahaRpc<VideoDownload[]>('hikariDownloads', []).catch(() => []);
  return [...rows, ...videoDownloads()];
}

export function getVideoDownloadStatus(id: string) {
  return prahaRpc<VideoDownloadStatus>('videoDownloadStatus', [id]);
}

export async function useVideoDownload(id: string, action: 'play' | 'share' | 'remove' | 'pause' | 'resume' | 'export') {
  const ok = await prahaRpc<boolean>('videoDownloadAction', [id, action]);
  if (ok && action === 'remove' && !id.startsWith('hikari-')) {
    localStorage.setItem(KEY, JSON.stringify(videoDownloads().filter((item) => item.id !== id)));
    window.dispatchEvent(new Event(DOWNLOADS_CHANGED));
  }
  return ok;
}
