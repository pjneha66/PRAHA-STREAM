// Favorite live channels, kept on this device.
//
// Ported line for line from VyseTV `lib/data/live_tv/live_favorites.dart`
// (GPL-3.0-or-later). A portal's channel is a favourite by its portal and its
// id (the same channel on two portals is two favourites); a playlist's is a
// favourite by its address. The list is stored complete — name, picture and
// address — so Live TV > Favorites can play a channel without opening its
// portal or its playlist first.

import type { IptvStream, VerifiedPortal } from './models';
import { portalLabel, portalKeyOf } from './portalNames';

const IDS_KEY = 'live_tv_favorite_channels';
const SAVED_KEY = 'live_tv_favorite_list';

export interface FavoriteChannel {
  /** `keyOf` for a portal's channel, `keyOfM3u` for a playlist's. */
  key: string;
  title: string;
  url: string;
  logo?: string;
  /** Where it is from, as the list says under its name. */
  from?: string;
}

type Listener = () => void;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // kept in memory; saved with the next change
  }
}

function parseFavorite(raw: unknown): FavoriteChannel | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const key = row.k ?? row.key;
  const title = row.t ?? row.title;
  const url = row.u ?? row.url;
  if (typeof key !== 'string' || typeof title !== 'string' || typeof url !== 'string' || !url) return null;
  return {
    key,
    title,
    url,
    logo: typeof (row.l ?? row.logo) === 'string' ? ((row.l ?? row.logo) as string) : undefined,
    from: typeof (row.f ?? row.from) === 'string' ? ((row.f ?? row.from) as string) : undefined,
  };
}

export class LiveFavorites {
  /** The keys of every favourite. Replaced (never changed in place) on every toggle. */
  static ids: ReadonlySet<string> = new Set();

  /** The favourites themselves, newest first, for the one place that lists them all. */
  static saved: readonly FavoriteChannel[] = [];

  private static loaded = false;
  private static listeners = new Set<Listener>();

  static subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private static emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  static keyOf(portal: VerifiedPortal, stream: IptvStream): string {
    return `${portalKeyOf(portal)}|${stream.streamId}`;
  }

  static keyOfM3u(url: string): string {
    return `m3u|${url}`;
  }

  static has(portal: VerifiedPortal, stream: IptvStream): boolean {
    return this.ids.has(this.keyOf(portal, stream));
  }

  static hasKey(key: string): boolean {
    return this.ids.has(key);
  }

  static load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      // Anything starred before the load finished stays.
      const storedIds = readJson<string[]>(IDS_KEY, []);
      const ids = new Set<string>(this.ids);
      for (const key of storedIds) if (typeof key === 'string') ids.add(key);

      const raw = readJson<unknown[]>(SAVED_KEY, []);
      const have = new Set(this.saved.map((entry) => entry.key));
      const merged = [...this.saved];
      for (const row of Array.isArray(raw) ? raw : []) {
        const entry = parseFavorite(row);
        if (entry && !have.has(entry.key)) {
          have.add(entry.key);
          merged.push(entry);
        }
      }
      this.ids = ids;
      this.saved = merged;
    } catch {
      // unreadable: what was starred this run is kept
    }
    this.emit();
  }

  /** Stars `channel`, or takes its star away. */
  static toggleChannel(channel: FavoriteChannel): void {
    const keys = new Set(this.ids);
    const list = this.saved.filter((entry) => entry.key !== channel.key);
    if (keys.delete(channel.key)) {
      // was a favourite → removed
    } else {
      keys.add(channel.key);
      list.unshift(channel);
    }
    this.ids = keys;
    this.saved = list;
    this.save();
    this.emit();
  }

  /** A portal's channel: `url` is its stream's address. */
  static toggle(portal: VerifiedPortal, stream: IptvStream, url: string): void {
    this.toggleChannel({
      key: this.keyOf(portal, stream),
      title: stream.name,
      url,
      logo: stream.icon || undefined,
      from: portalLabel(portal),
    });
  }

  /** Favourites starred before the list existed are only a key; given the portal's channels, they get their name, picture and address. */
  static adopt(portal: VerifiedPortal, streams: readonly IptvStream[], urlOf: (stream: IptvStream) => string): void {
    const prefix = `${portalKeyOf(portal)}|`;
    const have = new Set(this.saved.map((entry) => entry.key));
    const bare = new Set([...this.ids].filter((key) => key.startsWith(prefix) && !have.has(key)));
    if (!bare.size) return;
    const found: FavoriteChannel[] = [];
    for (const stream of streams) {
      const key = this.keyOf(portal, stream);
      if (!bare.has(key)) continue;
      found.push({ key, title: stream.name, url: urlOf(stream), logo: stream.icon || undefined, from: portalLabel(portal) });
    }
    if (!found.length) return;
    this.saved = [...this.saved, ...found];
    this.save();
    this.emit();
  }

  private static save(): void {
    writeJson(IDS_KEY, [...this.ids]);
    writeJson(SAVED_KEY, this.saved.map((entry) => ({
      k: entry.key,
      t: entry.title,
      u: entry.url,
      ...(entry.logo ? { l: entry.logo } : {}),
      ...(entry.from ? { f: entry.from } : {}),
    })));
  }

  /** Tests: as on a device where nothing was ever starred. */
  static debugReset(): void {
    this.loaded = false;
    this.ids = new Set();
    this.saved = [];
  }
}
