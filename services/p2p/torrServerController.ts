import { isAndroidApp } from '../androidBridge';
import { PrahaTorrServer, torrServerNativeAvailable } from './torrServerBridge';
import { TorrServerClient } from './torrServerClient';
import {
  applyTunedSettings,
  FALLBACK_TRACKERS,
  trackersUrl,
} from './torrServerSettings';
import { nativeFetchText } from '../androidBridge';

/**
 * Owns the bundled TorrServer process and exposes a ready-to-use REST client.
 *
 * On Android this is the default torrent engine; WebTorrent is only used by
 * the web/PWA build. The native executable is shipped in jniLibs and runs
 * straight from nativeLibraryDir — nothing is downloaded at runtime.
 */
class TorrServerController {
  private starting: Promise<boolean> | null = null;
  private baseUrl = '';
  private tuned = false;
  private trackers: string[] = [...FALLBACK_TRACKERS];
  private trackersPromise: Promise<string[]> | null = null;

  isSupported(): boolean {
    return isAndroidApp() && torrServerNativeAvailable();
  }

  get host(): string {
    return this.baseUrl;
  }

  get running(): boolean {
    return Boolean(this.baseUrl);
  }

  client(): TorrServerClient | null {
    return this.baseUrl ? new TorrServerClient(this.baseUrl) : null;
  }

  /** Starts the engine if needed and waits until /echo answers, then tunes it. */
  async ensureStarted(): Promise<boolean> {
    if (!this.isSupported()) return false;
    if (this.baseUrl) {
      try {
        await new TorrServerClient(this.baseUrl).echo(1500);
        return true;
      } catch {
        this.baseUrl = '';
        this.tuned = false;
      }
    }
    if (this.starting) return this.starting;

    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<boolean> {
    try {
      const result = await PrahaTorrServer.start();
      const port = result.port > 0 ? result.port : 8090;
      const host = `http://127.0.0.1:${port}`;
      const client = new TorrServerClient(host);

      let ready = false;
      for (let attempt = 0; attempt < 48; attempt += 1) {
        try {
          await client.echo(1000);
          ready = true;
          break;
        } catch {
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!ready) {
        await this.stop();
        return false;
      }

      this.baseUrl = host;
      if (!this.tuned) {
        try {
          const current = await client.getSettings();
          await client.setSettings(applyTunedSettings(current));
        } catch {
          // Tuning is an optimisation: a running default engine is better than
          // no engine because a settings call failed.
        }
        this.tuned = true;
      }
      void this.refreshTrackers();
      return true;
    } catch {
      this.baseUrl = '';
      return false;
    }
  }

  async stop(): Promise<void> {
    this.baseUrl = '';
    this.tuned = false;
    this.trackersPromise = null;
    this.trackers = [...FALLBACK_TRACKERS];
    try {
      if (this.isSupported()) await PrahaTorrServer.stop();
    } catch {
      // Already stopped.
    }
  }

  async status() {
    if (!this.isSupported()) return null;
    try {
      return await PrahaTorrServer.status();
    } catch {
      return null;
    }
  }

  /** ngosang's best trackers, refreshed once per session with a fixed fallback. */
  async getTrackers(): Promise<string[]> {
    if (!this.trackersPromise) this.trackersPromise = this.fetchTrackers();
    return this.trackersPromise;
  }

  private refreshTrackers(): Promise<string[]> {
    this.trackersPromise = this.fetchTrackers();
    return this.trackersPromise;
  }

  private async fetchTrackers(): Promise<string[]> {
    try {
      const res = await nativeFetchText(trackersUrl(), { timeoutMs: 6000 });
      const list = (res.data || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^(udp|http|wss?):\/\//i.test(line));
      if (list.length >= 5) this.trackers = list;
    } catch {
      // Keep the fallback list.
    }
    return this.trackers;
  }

  /** Appends our trackers to a magnet (RetrackersMode 1 also adds them server-side). */
  async augmentMagnet(
    magnetOrHash: string,
    options: { title?: string; extraTrackers?: string[] } = {},
  ): Promise<string> {
    let magnet = magnetOrHash.trim();
    if (!magnet.startsWith('magnet:')) {
      const hash = magnet.replace(/^urn:btih:/i, '');
      magnet = `magnet:?xt=urn:btih:${hash}`;
    }
    if (options.title && !/[?&]dn=/.test(magnet)) {
      magnet += `&dn=${encodeURIComponent(options.title)}`;
    }
    const trackers = [...(options.extraTrackers || []), ...(await this.getTrackers())];
    const seen = new Set<string>();
    for (const tracker of trackers) {
      const clean = tracker.trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      magnet += `&tr=${encodeURIComponent(clean)}`;
    }
    return magnet;
  }
}

export const torrServerController = new TorrServerController();
