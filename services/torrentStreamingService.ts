import { nativeFetchText } from './androidBridge';
import type { StreamResult } from '../types';
import { parseTorrentTitle, torrentFileMatches } from './torrentTitle';

// ── In-app P2P engine (WebTorrent) ────────────────────────────────────────────
// No TorrServer needed: webtorrent runs inside the WebView over WebRTC +
// WebSocket trackers and streams the largest video file straight into the
// HTML5 player. Coverage depends on the swarm, so it is the second engine in
// the chain (TorrServer first, debrid and external apps after).

interface WebTorrentFile {
  name: string;
  length: number;
  streamToURL: () => Promise<string>;
}
interface WebTorrentInstance {
  files: WebTorrentFile[];
  infoHash: string;
  progress: number;
  destroy: () => void;
}
interface WebTorrentClient {
  add: (magnet: string, opts: Record<string, unknown>, onTorrent: (torrent: WebTorrentInstance) => void) => void;
  remove: (torrent: WebTorrentInstance, cb?: () => void) => void;
  destroy: () => void;
}

const VIDEO_FILE_RE = /\.(mp4|mkv|webm|avi|mov|m4v)$/i;

let webTorrentClient: WebTorrentClient | null = null;
let activeWebTorrent: WebTorrentInstance | null = null;

async function getWebTorrentClient(): Promise<WebTorrentClient | null> {
  if (webTorrentClient) return webTorrentClient;
  try {
    const mod = await import('webtorrent');
    const WebTorrent = (mod.default || mod) as new () => WebTorrentClient;
    webTorrentClient = new WebTorrent();
    return webTorrentClient;
  } catch {
    return null;
  }
}

function pickVideoFile(files: WebTorrentFile[], releaseTitle?: string): WebTorrentFile | null {
  const videos = files.filter((file) => VIDEO_FILE_RE.test(file.name));
  if (!videos.length) return null;
  // PTT-driven episode matching (port of PlayTorrio): when the release name
  // carries S/E info, prefer files of that episode over plain size ranking.
  const parsed = releaseTitle ? parseTorrentTitle(releaseTitle) : null;
  const matching = videos.filter((file) => torrentFileMatches(parsed, file.name));
  const pool = matching.length ? matching : videos;
  return pool.reduce((best, file) => (file.length > best.length ? file : best), pool[0]);
}

export interface TorrentStreamStats {
  speedMbps: number;
  activePeers: number;
  totalPeers: number;
  cachePercent: number;
  loadedBytes: number;
  totalBytes: number;
  hash: string;
  isConnected: boolean;
  speedLabel: string;
  peersLabel: string;
}

export class TorrentStreamingEngine {
  private static defaultHost = 'http://127.0.0.1:8090';
  private static activeHash: string | null = null;
  private static pollingTimer: number | null = null;
  private static listeners: ((stats: TorrentStreamStats) => void)[] = [];

  static getHost(): string {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('praha.torrent.host');
      if (saved) return saved.replace(/\/$/, '');
    }
    return this.defaultHost;
  }

  static setHost(host: string): void {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('praha.torrent.host', host);
    }
  }

  /**
   * In-app P2P: adds the magnet to the WebTorrent engine (WebRTC + WebSocket
   * trackers), waits for metadata and the first playable buffer of the largest
   * video file, and returns a blob URL the HTML5 <video> element streams
   * directly. Resolves null on timeout or when the swarm has no WebRTC peers.
   */
  static async resolveViaWebTorrent(
    magnetOrHash: string,
    options: { title?: string; timeoutMs?: number } = {},
  ): Promise<{ url: string; fileName: string; infoHash: string } | null> {
    const client = await getWebTorrentClient();
    if (!client) return null;

    const hashMatch = magnetOrHash.match(/urn:btih:([a-zA-Z0-9]+)/i);
    const infoHash = hashMatch ? hashMatch[1].toLowerCase() : '';
    if (!magnetOrHash.startsWith('magnet:') && !infoHash) return null;
    const magnetLink = magnetOrHash.startsWith('magnet:')
      ? magnetOrHash
      : `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(options.title || 'PRAHA-Torrent')}`;

    // One torrent at a time — tearing down the previous one frees bandwidth.
    if (activeWebTorrent) {
      try { client.remove(activeWebTorrent); } catch { /* already gone */ }
      activeWebTorrent = null;
    }

    const timeoutMs = options.timeoutMs ?? 90000;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { url: string; fileName: string; infoHash: string } | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);

      try {
        client.add(magnetLink, { strategy: 'sequential' }, (torrent: WebTorrentInstance) => {
          activeWebTorrent = torrent;
          if (settled) return;
          const file = pickVideoFile(torrent.files, options.title);
          if (!file) { finish(null); return; }
          file.streamToURL()
            .then((url) => {
              // Give the stream a moment to buffer the head of the file so
              // playback does not stall on the first frame.
              finish({ url, fileName: file.name, infoHash: torrent.infoHash });
            })
            .catch(() => finish(null));
        });
      } catch {
        finish(null);
      }
    });
  }

  static destroyWebTorrent(): void {
    if (activeWebTorrent) {
      try { webTorrentClient?.remove(activeWebTorrent); } catch { /* noop */ }
      activeWebTorrent = null;
    }
  }

  /**
   * Checks if TorrServer or local torrent streaming proxy is reachable.
   */
  static async checkEngineAvailable(): Promise<boolean> {
    try {
      const res = await nativeFetchText(`${this.getHost()}/echo`, { timeoutMs: 2500 });
      return res.ok || res.status === 200 || res.data.includes('MatriX') || res.data.includes('TorrServer');
    } catch {
      return false;
    }
  }

  /**
   * Resolves a magnet link into a sequential HTTP stream URL.
   */
  static async streamTorrent(
    magnetOrHash: string,
    options: { title?: string; season?: number; episode?: number; fileIdx?: number } = {},
  ): Promise<{ streamUrl: string; infoHash: string }> {
    const host = this.getHost();
    const hashMatch = magnetOrHash.match(/urn:btih:([a-zA-Z0-9]+)/i) || magnetOrHash.match(/^[a-fA-F0-9]{40}$/);
    const infoHash = hashMatch ? hashMatch[1].toLowerCase() : magnetOrHash;

    const magnetLink = magnetOrHash.startsWith('magnet:')
      ? magnetOrHash
      : `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(options.title || 'PRAHA-Torrent')}`;

    // Add torrent to TorrServer engine
    try {
      await nativeFetchText(`${host}/torrents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          link: magnetLink,
          title: options.title || 'PRAHA Torrent Stream',
          save_to_db: true,
        }),
        timeoutMs: 4000,
      });
    } catch {
      // Proceed even if add call times out, as GET stream will auto-initialize
    }

    this.activeHash = infoHash;
    const fileIndexParam = options.fileIdx !== undefined ? `&index=${options.fileIdx}` : '';
    const streamUrl = `${host}/stream?link=${encodeURIComponent(magnetLink)}${fileIndexParam}&play=true`;

    return { streamUrl, infoHash };
  }

  /**
   * Fetches real-time telemetry from the torrent engine.
   */
  static async getTorrentStats(infoHash: string): Promise<TorrentStreamStats | null> {
    const host = this.getHost();
    try {
      const res = await nativeFetchText(`${host}/torrents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', hash: infoHash }),
        timeoutMs: 3000,
      });

      if (res.ok && res.data) {
        const data = JSON.parse(res.data);
        const stat = data.stat || data;
        const speedBps = Number(stat.download_speed || stat.speed || 0);
        const speedMbps = speedBps / (1024 * 1024);
        const speedKbps = speedBps / 1024;
        const activePeers = Number(stat.active_peers || stat.connected_peers || 0);
        const totalPeers = Number(stat.total_peers || stat.peers || 0);
        const loadedBytes = Number(stat.loaded_bytes || stat.bytes_read || 0);
        const totalBytes = Number(stat.torrent_size || stat.size || 1);
        const cachePercent = Math.min(100, Math.max(0, (loadedBytes / totalBytes) * 100));

        return {
          speedMbps,
          activePeers,
          totalPeers,
          cachePercent,
          loadedBytes,
          totalBytes,
          hash: infoHash,
          isConnected: activePeers > 0,
          speedLabel: speedMbps >= 1.0 ? `${speedMbps.toFixed(2)} MB/s` : `${speedKbps.toFixed(0)} KB/s`,
          peersLabel: `${activePeers} / ${totalPeers}`,
        };
      }
    } catch {
      // Offline or not available
    }
    return null;
  }

  /**
   * Subscribes to periodic telemetry updates.
   */
  static subscribeStats(infoHash: string, callback: (stats: TorrentStreamStats) => void): () => void {
    this.listeners.push(callback);
    if (!this.pollingTimer) {
      this.pollingTimer = window.setInterval(async () => {
        if (!this.activeHash) return;
        const stats = await this.getTorrentStats(this.activeHash);
        if (stats) {
          this.listeners.forEach((l) => l(stats));
        }
      }, 1500);
    }

    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
      if (this.listeners.length === 0 && this.pollingTimer) {
        clearInterval(this.pollingTimer);
        this.pollingTimer = null;
      }
    };
  }

  /**
   * Automatically prepares a StreamResult: if it is a torrent/magnet stream,
   * converts it via TorrentStreamingEngine if available.
   */
  static async resolveIfTorrent(stream: StreamResult, title: string): Promise<StreamResult> {
    if (!stream.url?.startsWith('magnet:') && !stream.infoHash) {
      return stream;
    }
    const magnetOrHash = stream.url?.startsWith('magnet:') ? stream.url : `magnet:?xt=urn:btih:${stream.infoHash}`;
    const isAvail = await this.checkEngineAvailable();
    if (isAvail) {
      const { streamUrl } = await this.streamTorrent(magnetOrHash, {
        title: stream.title || title,
        fileIdx: stream.fileIdx,
      });
      return {
        ...stream,
        url: streamUrl,
        format: 'torrent-http',
        provider: `${stream.provider || 'Torrent'} (Torrent Engine)`,
      };
    }
    return stream;
  }
}

