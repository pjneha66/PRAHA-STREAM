// Persistent stores for the Live TV port.
//
// Ported from VyseTV `lib/services/iptv/iptv_storage.dart`
// (GPL-3.0-or-later). SharedPreferences becomes localStorage; record shapes,
// keys and fallbacks are otherwise unchanged.

import type { IptvPortal, VerifiedPortal, M3uPlaylist, M3uChannel, QuickChannel } from './models';

const PORTALS_KEY = 'pt_iptv_verified_portals';
const FAVORITE_PORTALS_KEY = 'pt_iptv_favorite_portal_keys';
const PLAYLISTS_KEY = 'pt_iptv_m3u_playlists_v1';
const ALIVE_KEY = 'pt_iptv_alive_';
const LIVE_ONLY_KEY = 'pt_iptv_liveonly_';
const CHANNEL_HITS_KEY = 'pt_iptv_ch_';
const CHANNEL_FAVS_KEY = 'pt_iptv_chfav_';
const PORTAL_FAVS_KEY = 'pt_iptv_portalfav_';
const QUICK_KEY = 'pt_iptv_quick_channels';

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
    // Storage full / unavailable: keep working from memory.
  }
}

function readStringList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeStringList(key: string, values: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify([...values]));
  } catch {
    // ignore quota
  }
}

export function portalStoreKey(portal: IptvPortal): string {
  return `${portal.url}|${portal.username}|${portal.password}`.toLowerCase();
}

/** Verified portal store. */
export const IptvStore = {
  loadPortals(): VerifiedPortal[] {
    const arr = readJson<any[]>(PORTALS_KEY, []);
    if (!Array.isArray(arr)) return [];
    return arr.map((o) => ({
      portal: {
        url: String(o.portal?.url ?? o.url ?? ''),
        username: String(o.portal?.username ?? o.username ?? ''),
        password: String(o.portal?.password ?? o.password ?? ''),
        source: String(o.portal?.source ?? o.source ?? ''),
      },
      name: String(o.name ?? ''),
      expiry: String(o.expiry ?? ''),
      maxConnections: String(o.maxConnections ?? o.max ?? '1'),
      activeConnections: String(o.activeConnections ?? o.active ?? '0'),
    }));
  },
  savePortals(list: readonly VerifiedPortal[]): void {
    writeJson(PORTALS_KEY, list.map((v) => ({
      portal: v.portal,
      name: v.name,
      expiry: v.expiry,
      maxConnections: v.maxConnections,
      activeConnections: v.activeConnections,
    })));
  },
  loadFavoritePortalKeys(): Set<string> {
    return new Set(readStringList(FAVORITE_PORTALS_KEY));
  },
  saveFavoritePortalKeys(keys: ReadonlySet<string>): void {
    writeStringList(FAVORITE_PORTALS_KEY, [...keys]);
  },
  loadPlaylists(): M3uPlaylist[] {
    const arr = readJson<any[]>(PLAYLISTS_KEY, []);
    if (!Array.isArray(arr)) return [];
    return arr.map((o) => ({
      id: String(o.id ?? ''),
      name: String(o.name ?? 'Playlist'),
      sourceUrl: String(o.sourceUrl ?? ''),
      addedAt: Number(o.addedAt ?? 0),
      channels: Array.isArray(o.channels) ? o.channels : [],
      updatedAt: Number(o.updatedAt ?? 0),
    }));
  },
  savePlaylists(list: readonly M3uPlaylist[]): void {
    writeJson(PLAYLISTS_KEY, [...list]);
  },
};

/** Per-portal "alive" channel snapshot + live-only preference. */
export const IptvAliveStore = {
  load(key: string): { checkedAt: number; aliveIds: Set<string> } | null {
    const o = readJson<{ at?: number; ids?: string[] } | null>(`${ALIVE_KEY}${key}`, null);
    if (!o || !Array.isArray(o.ids)) return null;
    return { checkedAt: Number(o.at ?? 0), aliveIds: new Set(o.ids) };
  },
  save(key: string, snap: { checkedAt: number; aliveIds: ReadonlySet<string> }): void {
    writeJson(`${ALIVE_KEY}${key}`, { at: snap.checkedAt, ids: [...snap.aliveIds] });
  },
  loadLiveOnly(key: string): boolean {
    try {
      return localStorage.getItem(`${LIVE_ONLY_KEY}${key}`) === 'true';
    } catch {
      return false;
    }
  },
  saveLiveOnly(key: string, enabled: boolean): void {
    try {
      localStorage.setItem(`${LIVE_ONLY_KEY}${key}`, enabled ? 'true' : 'false');
    } catch {
      // ignore
    }
  },
};

/** Stored channel hit (a working stream for a built-in channel). */
export interface StoredHit {
  portalUrl: string;
  portalUser: string;
  portalPass: string;
  portalName: string;
  streamId: string;
  streamName: string;
  streamIcon: string;
  streamCategoryId: string;
  streamContainerExt: string;
  streamKind: string;
  streamUrl: string;
}

export const IptvChannelResultsStore = {
  load(channelId: string): StoredHit[] {
    const arr = readJson<any[]>(`${CHANNEL_HITS_KEY}${channelId}`, []);
    if (!Array.isArray(arr)) return [];
    return arr.map((o) => ({
      portalUrl: String(o.pu ?? ''),
      portalUser: String(o.uu ?? ''),
      portalPass: String(o.pp ?? ''),
      portalName: String(o.pn ?? ''),
      streamId: String(o.sid ?? ''),
      streamName: String(o.sn ?? ''),
      streamIcon: String(o.si ?? ''),
      streamCategoryId: String(o.scid ?? ''),
      streamContainerExt: String(o.sce ?? ''),
      streamKind: String(o.sk ?? 'live'),
      streamUrl: String(o.url ?? ''),
    }));
  },
  save(channelId: string, hits: readonly StoredHit[]): void {
    writeJson(`${CHANNEL_HITS_KEY}${channelId}`, hits.map((h) => ({
      pu: h.portalUrl, uu: h.portalUser, pp: h.portalPass, pn: h.portalName,
      sid: h.streamId, sn: h.streamName, si: h.streamIcon, scid: h.streamCategoryId,
      sce: h.streamContainerExt, sk: h.streamKind, url: h.streamUrl,
    })));
  },
  clear(channelId: string): void {
    try { localStorage.removeItem(`${CHANNEL_HITS_KEY}${channelId}`); } catch { /* ignore */ }
  },
};

export const IptvChannelFavoritesStore = {
  load(channelId: string): Set<string> { return new Set(readStringList(`${CHANNEL_FAVS_KEY}${channelId}`)); },
  save(channelId: string, urls: ReadonlySet<string>): void { writeStringList(`${CHANNEL_FAVS_KEY}${channelId}`, [...urls]); },
};

export const IptvPortalFavoritesStore = {
  load(key: string): Set<string> { return new Set(readStringList(`${PORTAL_FAVS_KEY}${key}`)); },
  save(key: string, ids: ReadonlySet<string>): void { writeStringList(`${PORTAL_FAVS_KEY}${key}`, [...ids]); },
};

export const IptvQuickChannelStore = {
  load(): QuickChannel[] {
    const arr = readJson<any[]>(QUICK_KEY, []);
    if (!Array.isArray(arr)) return [];
    return arr.map((o) => ({
      id: String(o.id ?? ''),
      name: String(o.name ?? ''),
      shortName: String(o.short ?? o.shortName ?? ''),
      category: String(o.category ?? 'Quick'),
      keywords: Array.isArray(o.keywords) ? o.keywords : [],
      gradient: Array.isArray(o.gradient) && o.gradient.length >= 2 ? [o.gradient[0], o.gradient[1]] : ['#171A2E', '#0D0F18'],
      logo: o.iconUrl ?? o.logo,
    }));
  },
  save(list: readonly QuickChannel[]): void { writeJson(QUICK_KEY, [...list]); },
};

/** M3U playlist store facade (shared with the parser module). */
export const M3uStore = {
  loadAll(): M3uPlaylist[] { return IptvStore.loadPlaylists(); },
  saveAll(list: readonly M3uPlaylist[]): void { IptvStore.savePlaylists(list); },
};
