import { isAndroidApp, nativeFetchText } from './androidBridge';
import type { StreamResult } from '../types';
import { parseTorrentTitle, torrentFileMatches } from './torrentTitle';
import { torrServerController } from './p2p/torrServerController';
import { TorrServerClient } from './p2p/torrServerClient';

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

/**
 * True for a URL that points back at this device. TorrServer is configured by
 * URL, and both the bundled engine and a loopback-hosted server use one, so the
 * host — not the caller's intent — decides whether the bundled process should
 * be started. Anything unparseable is treated as not loopback, leaving the
 * normal probe as the only path.
 */
export function isLoopbackHost(url: string): boolean {
  // The authority runs to the first `/`, `?` or `#`. Bracketed IPv6 addresses
  // contain `:` of their own, so they are matched as their own shape instead of
  // splitting on the port separator — `http://[::1]:8090` has to be recognised
  // or the bundled engine is skipped on an IPv6 loopback.
  const authority = url.trim().match(/^[a-z]+:\/\/([^/?#]+)/i)?.[1];
  if (!authority) return false;
  const bracketed = authority.match(/^\[([0-9a-f:]+)\]/i);
  const name = (bracketed ? bracketed[1] : authority.split(':')[0]).toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

let webTorrentClient: WebTorrentClient | null = null;
let activeWebTorrent: WebTorrentInstance | null = null;
/**
 * Bumped by every `destroyWebTorrent()`. A resolve that started before the bump
 * is abandoned: it drops whatever torrent it attached and settles null instead
 * of leaving a download running behind a player the user already closed.
 */
let webTorrentEpoch = 0;

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
    // The bundled engine owns the host once it is live — the saved host is a
    // fallback for people pointing PRAHA at their own LAN TorrServer.
    if (torrServerController.running) return torrServerController.host;
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
    // Android uses the bundled TorrServer executable instead: WebTorrent's
    // WebRTC trackers are unreliable in the WebView and drain the battery.
    if (isAndroidApp()) return null;
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
    const epoch = webTorrentEpoch;
    return new Promise((resolve) => {
      let settled = false;
      /**
       * Settles the promise, and tears the torrent down again when it settled
       * without a playable URL.
       *
       * A timeout used to leave the torrent attached to the client with nothing
       * consuming it: it kept announcing to trackers, kept downloading, and kept
       * the previous `activeWebTorrent` slot occupied until the next magnet
       * replaced it. On a phone that is bandwidth and battery spent on a stream
       * the user has already given up on.
       */
      const finish = (result: { url: string; fileName: string; infoHash: string } | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // An abandoned epoch means the player closed: drop the torrent whether
        // or not it produced a URL, and report failure so no caller starts
        // playback from a URL that is about to be revoked.
        const abandoned = epoch !== webTorrentEpoch;
        if (!result || abandoned) {
          if (activeWebTorrent) {
            try { client.remove(activeWebTorrent); } catch { /* already gone */ }
            activeWebTorrent = null;
          }
        }
        resolve(abandoned ? null : result);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);

      try {
        client.add(magnetLink, { strategy: 'sequential' }, (torrent: WebTorrentInstance) => {
          // The callback can still run after a timeout settled the promise.
          // Attaching it then would silently re-download a stream nobody wants,
          // so drop it on the floor instead of assigning it.
          if (settled) {
            try { client.remove(torrent); } catch { /* already gone */ }
            return;
          }
          activeWebTorrent = torrent;
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
    // Invalidate any resolve still in flight before tearing down, so it cannot
    // re-attach the torrent after this returns.
    webTorrentEpoch += 1;
    if (activeWebTorrent) {
      try { webTorrentClient?.remove(activeWebTorrent); } catch { /* noop */ }
      activeWebTorrent = null;
    }
  }

  /**
   * Checks if TorrServer or local torrent streaming proxy is reachable.
   */
  static async checkEngineAvailable(host?: string): Promise<boolean> {
    const base = (host || this.getHost()).replace(/\/$/, '');
    // The bundled engine is addressed through the same loopback URL the user
    // types in Settings, so an explicit host is not evidence that they mean an
    // external server. "Save & test" always passes a host, and that used to
    // skip `ensureStarted()` entirely: the badge said "Stopped", nothing
    // started the process, and the probe hit a closed port.
    const bundledHost = isLoopbackHost(base);
    if (bundledHost || !host) {
      // Returns false on web/PWA, where there is no native engine to start; the
      // probe below then covers a self-hosted server on the same URL.
      if (torrServerController.isSupported() && (await torrServerController.ensureStarted())) {
        // A loopback host means "the bundled engine", whatever port the native
        // side actually bound to.
        try {
          await new TorrServerClient(torrServerController.host || base).echo(2500);
          return true;
        } catch {
          return false;
        }
      }
    }
    const probes = [`${base}/echo`, `${base}/`];
    for (const url of probes) {
      try {
        const res = await nativeFetchText(url, { timeoutMs: 3500 });
        const body = (res.data || '').toLowerCase();
        if (res.ok || res.status === 200 || body.includes('matrix') || body.includes('torrserver') || body.includes('torr')) {
          return true;
        }
      } catch {
        // try next probe
      }
    }
    return false;
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

    let magnetLink = magnetOrHash.startsWith('magnet:')
      ? magnetOrHash
      : `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(options.title || 'PRAHA-Torrent')}`;

    // The bundled engine gets our refreshed public tracker list appended.
    if (torrServerController.running) {
      try {
        magnetLink = await torrServerController.augmentMagnet(magnetLink, { title: options.title });
      } catch {
        // The original magnet is still playable.
      }
    }

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

