import { prahaRpc, safeRemoteUrl } from './androidBridge';
import type { MediaItem, StreamResult } from '../types';

export const HIKARI_REPO = 'https://raw.githubusercontent.com/codegeasse1/hikari-extensions/builds/repo.json';

export interface HikiEntry {
  name: string;
  url: string;
  fileHash: string;
  version: string;
  description?: string;
  adult: boolean;
}

export interface InstalledHiki extends HikiEntry {
  id: string;
  enabled: boolean;
  providers: string[];
}

export interface HikiRepo { name: string; url: string; plugins: HikiEntry[] }
export interface HikiProvider { key: string; name: string; description: string }
export interface HikiCatalog { id: string; name: string }
export interface HikiMedia {
  id: string;
  title: string;
  type: 'MOVIE' | 'SERIES' | 'UNKNOWN';
  posterUrl?: string;
  backdropUrl?: string;
  year?: number;
  overview?: string;
  genres?: string[];
  rawType?: string;
}
export interface HikiEpisode { id: string; number: number; season: number; name?: string; image?: string }
export interface HikiTitle { provider: HikiProvider; media: HikiMedia; episodes: HikiEpisode[] }

interface HikiStream {
  name: string;
  url?: string;
  headers?: Record<string, string>;
  subtitles?: { lang: string; url: string }[];
  isM3u8?: boolean;
  isMpd?: boolean;
  isTorrent?: boolean;
  infoHash?: string;
  fileIdx?: number;
  trackers?: string[];
  ytId?: string;
  externalUrl?: boolean;
}

function hikariRepoUrl(input: string) {
  const trimmed = input.trim();
  const url = new URL(trimmed.startsWith('github.com/') ? `https://${trimmed}` : trimmed);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Enter an HTTPS Hikari repository URL.');
  return url;
}

export async function loadHikiRepo(input: string): Promise<HikiRepo> {
  const url = hikariRepoUrl(input);
  if (url.hostname === 'github.com') {
    const [owner, repo, kind, branch, ...path] = url.pathname.split('/').filter(Boolean);
    if (owner && repo && !kind) {
      const base = `https://raw.githubusercontent.com/${owner}/${repo}`;
      try { return await prahaRpc<HikiRepo>('hikiRepo', [`${base}/builds/repo.json`], 40000); }
      catch { return await prahaRpc<HikiRepo>('hikiRepo', [`${base}/HEAD/repo.json`], 40000); }
    }
    if (owner && repo && kind === 'blob' && branch && path.length) {
      return await prahaRpc<HikiRepo>('hikiRepo', [`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path.join('/')}`], 40000);
    }
  }
  return await prahaRpc<HikiRepo>('hikiRepo', [url.href], 40000);
}

export function installHiki(entry: HikiEntry) {
  return prahaRpc<InstalledHiki>('hikiInstall', [JSON.stringify(entry)], 90000);
}
export function installedHiki() {
  return prahaRpc<InstalledHiki[]>('hikiInstalled', []);
}
export function setHikiEnabled(id: string, enabled: boolean) {
  return prahaRpc('hikiSetEnabled', [id, enabled]);
}
export function hikiProviders(id: string) {
  return prahaRpc<HikiProvider[]>('hikiProviders', [id], 45000);
}
export function hikiCatalogs(key: string) {
  return prahaRpc<HikiCatalog[]>('hikiCatalogs', [key], 80000);
}
export function hikiBrowse(key: string, catalog: string, query: string, page = 1) {
  return prahaRpc<HikiMedia[]>('hikiBrowse', [key, catalog, query, page], 80000);
}

export async function openHikiTitle(provider: HikiProvider, media: HikiMedia): Promise<MediaItem> {
  const detail = await prahaRpc<Omit<HikiTitle, 'provider'>>('hikiDetails', [provider.key, media], 80000);
  const item = detail.media;
  const counts = new Map<number, number>();
  for (const episode of detail.episodes) counts.set(episode.season, (counts.get(episode.season) ?? 0) + 1);
  return {
    id: `hiki:${provider.key}:${media.id}`,
    title: item.title || media.title || provider.name,
    source: 'hikari',
    type: detail.episodes.length || item.type === 'SERIES' ? 'series' : 'movie',
    poster: item.posterUrl || media.posterUrl || '',
    backdrop: item.backdropUrl,
    overview: item.overview || '',
    year: item.year ? String(item.year) : undefined,
    genres: item.genres ?? [],
    seasons: [...counts.entries()].sort(([a], [b]) => a - b).map(([seasonNumber, episodeCount]) => ({
      id: seasonNumber, seasonNumber, name: `Season ${seasonNumber}`, episodeCount,
    })),
    hikari: { provider, ...detail },
  };
}

export function toHikiStreams(provider: HikiProvider, rows: HikiStream[]): StreamResult[] {
  return rows.flatMap((row, index) => {
    const infoHash = row.infoHash?.trim();
    const torrent = row.isTorrent && infoHash && /^[a-f\d]{40}$|^[a-z2-7]{32}$/i.test(infoHash);
    const youtube = row.ytId && /^[\w-]{11}$/.test(row.ytId) ? row.ytId : undefined;
    const magnet = row.url?.startsWith('magnet:?') ? row.url : torrent
      ? `magnet:?xt=urn:btih:${infoHash}${(row.trackers ?? []).map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join('')}`
      : '';
    const url = magnet || (row.url ? safeRemoteUrl(row.url) : '') || '';
    if (!url && !youtube) return [];
    return [{
      id: `hiki:${provider.key}:${index}`,
      title: row.name || provider.name,
      sourceName: provider.name,
      sourceType: 'hikari' as const,
      url,
      infoHash: torrent ? infoHash : undefined,
      fileIdx: row.fileIdx,
      ytId: youtube,
      format: row.isM3u8 ? 'hls' : row.isMpd ? 'dash' : undefined,
      headers: row.headers,
      externalUrl: row.externalUrl && !magnet ? url : undefined,
      subtitles: row.subtitles?.flatMap((subtitle) => {
        const url = safeRemoteUrl(subtitle.url);
        return url ? [{ url, language: subtitle.lang }] : [];
      }),
    }];
  });
}

export async function hikiStreams(title: HikiTitle, season?: number, episode?: number) {
  const selected = title.episodes.find((item) => item.season === season && item.number === episode);
  if (title.episodes.length && !selected) return [];
  const rows = await prahaRpc<HikiStream[]>('hikiStreams', [title.provider.key, title.media, selected ?? null], 80000);
  return toHikiStreams(title.provider, rows);
}
