import { nativeFetchText } from '../androidBridge';
import type { TorrServerSettings } from './torrServerSettings';

/**
 * Typed REST client for TorrServer's /torrents, /settings and /stream API.
 *
 * Ported from `packages/torrserver_flutter/lib/src/rest_client.dart`. Every
 * call goes through `nativeFetchText` — a bare `fetch` would be CORS-blocked
 * inside the app WebView and cannot set the headers the scraper sources need.
 */

export interface TorrentInfo {
  hash?: string;
  title?: string;
  category?: string;
  poster?: string;
  data?: string;
  size?: number;
  stat?: Record<string, unknown>;
  files?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export class TorrServerHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body = '',
  ) {
    super(message);
    this.name = 'TorrServerHttpError';
  }
}

function parseJson<T>(data: string, fallback: T): T {
  if (!data) return fallback;
  try {
    return JSON.parse(data) as T;
  } catch {
    return fallback;
  }
}

export class TorrServerClient {
  constructor(private readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  get host(): string {
    return this.baseUrl;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** Health check. Returns the trimmed server version string. */
  async echo(timeoutMs = 5000): Promise<string> {
    const res = await nativeFetchText(this.url('/echo'), { timeoutMs });
    if (res.ok && res.status >= 200 && res.status < 300) {
      return (res.data || '').trim();
    }
    throw new TorrServerHttpError(
      `Echo failed with status ${res.status}`,
      res.status,
      res.data,
    );
  }

  async shutdown(): Promise<void> {
    try {
      await nativeFetchText(this.url('/shutdown'), { timeoutMs: 2000 });
    } catch {
      // A graceful shutdown often closes the socket before the reply is read.
    }
  }

  private async post<T>(path: string, body: Record<string, unknown>, timeoutMs = 12000): Promise<T> {
    const res = await nativeFetchText(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      timeoutMs,
    });
    if (!res.ok || res.status < 200 || res.status >= 300) {
      throw new TorrServerHttpError(
        `TorrServer ${path} failed with status ${res.status}`,
        res.status,
        res.data,
      );
    }
    return parseJson<T>(res.data, undefined as unknown as T);
  }

  async addTorrent(options: {
    link: string;
    title?: string;
    category?: string;
    poster?: string;
    data?: string;
    saveToDb?: boolean;
  }): Promise<TorrentInfo> {
    const body: Record<string, unknown> = {
      action: 'add',
      link: options.link,
      save_to_db: options.saveToDb ?? false,
    };
    for (const key of ['title', 'category', 'poster', 'data'] as const) {
      const value = options[key];
      if (value) body[key] = value;
    }
    const result = await this.post<TorrentInfo | TorrentInfo[]>('/torrents', body);
    if (Array.isArray(result)) return result[0] || {};
    if (result && typeof result === 'object') return result;
    throw new TorrServerHttpError('Unexpected response when adding a torrent', 200);
  }

  /** Multipart upload. Uses WebView fetch because the native bridge carries strings, not bytes. */
  async uploadTorrentFile(
    bytes: Uint8Array,
    filename = 'torrent.torrent',
    options: { title?: string; category?: string; poster?: string; data?: string; saveToDb?: boolean } = {},
  ): Promise<TorrentInfo> {
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart], { type: 'application/x-bittorrent' }), filename);
    for (const key of ['title', 'category', 'poster', 'data'] as const) {
      const value = options[key];
      if (value) form.append(key, value);
    }
    if (options.saveToDb) form.append('save', 'true');

    const res = await fetch(this.url('/torrent/upload'), { method: 'POST', body: form });
    if (!res.ok) {
      throw new TorrServerHttpError(`Upload failed with status ${res.status}`, res.status);
    }
    const decoded = parseJson<TorrentInfo | TorrentInfo[]>(await res.text(), [] as TorrentInfo[]);
    return Array.isArray(decoded) ? decoded[0] || {} : decoded;
  }

  async listTorrents(): Promise<TorrentInfo[]> {
    const result = await this.post<TorrentInfo[]>('/torrents', { action: 'list' });
    return Array.isArray(result) ? result : [];
  }

  async getTorrent(hash: string): Promise<TorrentInfo> {
    const result = await this.post<TorrentInfo>('/torrents', { action: 'get', hash });
    if (result && typeof result === 'object') return result;
    throw new TorrServerHttpError(`Torrent ${hash} not found`, 404);
  }

  async removeTorrent(hash: string): Promise<void> {
    await this.post('/torrents', { action: 'rem', hash });
  }

  async dropTorrent(hash: string): Promise<void> {
    await this.post('/torrents', { action: 'drop', hash });
  }

  async setTorrent(
    hash: string,
    fields: { title?: string; poster?: string; category?: string; data?: string },
  ): Promise<void> {
    await this.post('/torrents', { action: 'set', hash, ...fields });
  }

  async getSettings(): Promise<TorrServerSettings> {
    const result = await this.post<TorrServerSettings>('/settings', { action: 'get' });
    if (result && typeof result === 'object') return result;
    throw new TorrServerHttpError('Failed to parse TorrServer settings', 200);
  }

  async setSettings(settings: TorrServerSettings): Promise<void> {
    await this.post('/settings', { action: 'set', sets: settings });
  }

  async setDefaultSettings(): Promise<void> {
    await this.post('/settings', { action: 'def' });
  }

  /** Direct sequential stream URL for a torrent file index (1-based). */
  streamUrl(hashOrLink: string, fileIndex = 1): string {
    const index = fileIndex > 0 ? fileIndex : 1;
    const query = new URLSearchParams({
      link: hashOrLink,
      index: String(index),
      play: '',
    });
    return this.url(`/stream?${query.toString()}`);
  }
}
