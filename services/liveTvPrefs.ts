import type { M3uChannel } from './iptvService';
import type { StreamHealthResult } from './streamHealth';

/**
 * Local-only Live TV preferences. Keeps the heavy LiveTvView component focused
 * on rendering by moving the small, persisted bits (channel health cache,
 * recently played, per-source playback mode) into one guarded store.
 */

const HEALTH_KEY = 'praha.iptv.health.v1';
const LAST_PLAYED_KEY = 'praha.iptv.lastplayed.v1';
const MODE_KEY = 'praha.iptv.mode.v1';

const HEALTH_TTL_MS = 10 * 60 * 1000;
const HEALTH_MAX = 400;
const LAST_PLAYED_MAX = 24;
const MODE_MAX = 400;

export interface CachedHealth extends StreamHealthResult {
  at: number;
}

export interface LastPlayedChannel extends M3uChannel {
  at: number;
}

export type PlaybackMode = 'internal' | 'external';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return (parsed && typeof parsed === 'object') ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / privacy mode — persistence is best effort.
  }
}

/** Words worth comparing when looking for the same channel on another source. */
function channelTokens(name: string): string[] {
  return (name || '')
    .toLowerCase()
    .replace(/\b(us|uk|ca|au|de|fr|es|it|nl|br|in)\s*:/g, ' ')
    .replace(/\b(hd|fhd|uhd|sd|4k|8k|1080p|720p|480p|live)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

export const LiveTvPrefs = {
  // ── Health cache ────────────────────────────────────────────────────────
  getHealth(url: string): CachedHealth | null {
    if (!url) return null;
    const all = readJson<Record<string, CachedHealth>>(HEALTH_KEY, {});
    const entry = all[url];
    if (!entry || !Number.isFinite(entry.at) || Date.now() - entry.at > HEALTH_TTL_MS) return null;
    return entry;
  },

  /** All still-valid probes, used to hydrate card badges in one read. */
  getAllHealth(): Record<string, CachedHealth> {
    const all = readJson<Record<string, CachedHealth>>(HEALTH_KEY, {});
    const now = Date.now();
    return Object.entries(all).reduce<Record<string, CachedHealth>>((acc, [url, entry]) => {
      if (entry && now - entry.at <= HEALTH_TTL_MS) acc[url] = entry;
      return acc;
    }, {});
  },

  setHealth(url: string, result: StreamHealthResult): CachedHealth {
    const entry: CachedHealth = { ...result, at: Date.now() };
    const all = readJson<Record<string, CachedHealth>>(HEALTH_KEY, {});
    all[url] = entry;
    // Drop expired entries first, then bound the map.
    const now = Date.now();
    const fresh = Object.entries(all).filter(([, value]) => value && now - value.at <= HEALTH_TTL_MS);
    const bounded = fresh.length > HEALTH_MAX
      ? fresh.sort((a, b) => b[1].at - a[1].at).slice(0, HEALTH_MAX)
      : fresh;
    writeJson(HEALTH_KEY, Object.fromEntries(bounded));
    return entry;
  },

  // ── Recently played ─────────────────────────────────────────────────────
  getLastPlayed(): LastPlayedChannel[] {
    const list = readJson<LastPlayedChannel[]>(LAST_PLAYED_KEY, []);
    return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.url === 'string') : [];
  },

  markPlayed(channel: Pick<M3uChannel, 'name' | 'url' | 'group' | 'logo'>): LastPlayedChannel[] {
    if (!channel?.url) return this.getLastPlayed();
    const next: LastPlayedChannel[] = [
      { ...channel, at: Date.now() },
      ...this.getLastPlayed().filter((entry) => entry.url !== channel.url),
    ].slice(0, LAST_PLAYED_MAX);
    writeJson(LAST_PLAYED_KEY, next);
    return next;
  },

  // ── Per-source playback mode ────────────────────────────────────────────
  getMode(url: string): PlaybackMode | null {
    if (!url) return null;
    const all = readJson<Record<string, PlaybackMode>>(MODE_KEY, {});
    return all[url] === 'external' || all[url] === 'internal' ? all[url] : null;
  },

  getAllModes(): Record<string, PlaybackMode> {
    return readJson<Record<string, PlaybackMode>>(MODE_KEY, {});
  },

  setMode(url: string, mode: PlaybackMode): void {
    if (!url) return;
    const all = readJson<Record<string, PlaybackMode>>(MODE_KEY, {});
    const keys = Object.keys(all);
    if (keys.length >= MODE_MAX && !(url in all)) delete all[keys[0]];
    all[url] = mode;
    writeJson(MODE_KEY, all);
  },

  /**
   * Same channel, different source: name-token similarity after stripping
   * country prefixes and quality labels ("US: Sky Sports F1 HD" → "sky sports
   * f1"). Bounded, synchronous and cheap enough to call from a card menu.
   */
  findAlternates(channels: M3uChannel[], target: Pick<M3uChannel, 'name' | 'url'>): M3uChannel[] {
    const targetTokens = channelTokens(target.name);
    if (!targetTokens.length) return [];
    const scored = channels
      .filter((ch) => ch?.url && ch.url !== target.url)
      .map((ch) => {
        const tokens = channelTokens(ch.name);
        const overlap = targetTokens.filter((token) => tokens.includes(token)).length;
        const score = tokens.length ? overlap / Math.min(targetTokens.length, tokens.length) : 0;
        return { ch, score, overlap };
      })
      .filter((entry) => entry.score >= 0.7 && entry.overlap >= 2)
      .sort((a, b) => b.score - a.score);

    const seen = new Set<string>([target.url]);
    const result: M3uChannel[] = [];
    for (const entry of scored) {
      if (seen.has(entry.ch.url)) continue;
      seen.add(entry.ch.url);
      result.push(entry.ch);
      if (result.length >= 8) break;
    }
    return result;
  },
};
