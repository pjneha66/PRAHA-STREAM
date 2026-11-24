// IPTV playback intake for the player modal and zap bar.
//
// The player contract is PRAHA-specific (`MediaItem` / `StreamResult`), but the
// format heuristics mirror the stream-type handling in VyseTV's
// `lib/screens/player/iptv_player.dart` (GPL-3.0-or-later).

import type { MediaItem, StreamResult } from '../../types';
import type { LiveItem } from './liveItems';

export interface IptvZapChannel {
  name: string;
  url: string;
  group?: string;
  logo?: string;
}

/**
 * What the live player needs that a `MediaItem`/`StreamResult` cannot carry.
 *
 * VyseTV keeps two players apart: `LiveTvPlayerPage` for a live channel and
 * `PlayerPage` for a portal's films and episodes (`lib/data/live_tv/iptv_playback.dart`
 * hands the latter to the film player). `live` is what chooses between them here,
 * so it is required rather than inferred from the URL — a portal's VOD address and
 * a channel's address look the same to `detectIptvFormat`.
 */
export interface LivePlaybackMeta {
  /** A live channel: zapping, guide and volume. `false` sends it to the film player. */
  live: boolean;
  /** Loads this channel's guide; absent when it has none (an M3U entry has no EPG). */
  epg?: () => Promise<{ title: string; description?: string; start: number | string; stop: number | string }[]>;
  /** The favourites key, so the player can show and toggle its star. */
  favoriteKey?: string;
}

/**
 * One entry in the live player's channel list.
 *
 * VyseTV hands the player `List<LiveItem>`, and each item carries its own guide
 * loader and favourites key — `_open()` re-reads `_item.epg` after every zap, so
 * channel 12 shows channel 12's guide and its own star. The persisted zap list
 * cannot carry those (a function does not survive `JSON.stringify`), so the
 * live player is handed this instead and the store stays what it is: the last
 * list, for the bar's arrows after the player closes.
 */
export interface LivePlaybackItem extends IptvZapChannel, Partial<LivePlaybackMeta> {}

/** Everything opening a channel needs — VyseTV's `openLivePlayer(items, index)`. */
export interface IptvPlayback {
  media: MediaItem;
  stream: StreamResult;
  live: LivePlaybackMeta;
  /** The list the channel was opened from, in that order — the panel and ↑/↓ walk it. */
  items: LivePlaybackItem[];
  /** Where in `items` the channel that is playing sits. */
  index: number;
}

const ZAP_KEY = 'praha.iptv.zap.v1';
const ZAP_MAX_CHANNELS = 400;

/** Bounded zap list, persisted so the player can step through the last list. */
export class IptvZapStore {
  static set(channels: readonly IptvZapChannel[], currentUrl: string): void {
    try {
      const seen = new Set<string>();
      const list: IptvZapChannel[] = [];
      const push = (channel: IptvZapChannel) => {
        if (list.length >= ZAP_MAX_CHANNELS || !channel?.url || seen.has(channel.url)) return;
        seen.add(channel.url);
        list.push({ name: channel.name, url: channel.url, group: channel.group, logo: channel.logo });
      };
      // Two bounded passes keep a 10k-channel playlist from being mapped twice.
      for (const channel of channels) {
        if (channel.url === currentUrl) { push(channel); break; }
      }
      for (const channel of channels) {
        if (list.length >= ZAP_MAX_CHANNELS) break;
        push(channel);
      }
      localStorage.setItem(ZAP_KEY, JSON.stringify({ channels: list, currentUrl }));
    } catch {
      // Quota or storage unavailable — zapping is best effort.
    }
  }

  static setCurrent(url: string): void {
    try {
      const raw = localStorage.getItem(ZAP_KEY);
      const parsed = raw ? (JSON.parse(raw) as { channels?: IptvZapChannel[]; currentUrl?: string }) : {};
      localStorage.setItem(ZAP_KEY, JSON.stringify({ channels: parsed.channels || [], currentUrl: url }));
    } catch {
      // Ignore quota / privacy mode.
    }
  }

  static get(): { channels: IptvZapChannel[]; currentUrl: string } | null {
    try {
      const raw = localStorage.getItem(ZAP_KEY);
      const parsed = raw ? (JSON.parse(raw) as { channels?: IptvZapChannel[]; currentUrl?: string }) : {};
      if (!parsed.channels?.length) return null;
      return { channels: parsed.channels, currentUrl: parsed.currentUrl || '' };
    } catch {
      return null;
    }
  }

  /** Next/previous channel relative to the current one (wraps around). */
  static neighbor(direction: 1 | -1): IptvZapChannel | null {
    const zap = IptvZapStore.get();
    if (!zap) return null;
    const index = zap.channels.findIndex((channel) => channel.url === zap.currentUrl);
    const nextIndex = index < 0 ? 0 : (index + direction + zap.channels.length) % zap.channels.length;
    const channel = zap.channels[nextIndex];
    if (!channel) return null;
    IptvZapStore.setCurrent(channel.url);
    return channel;
  }

  /**
   * The whole zap list and which channel is on.
   *
   * The dedicated live player's channel panel is the same list zapping steps
   * through — VyseTV's player is handed `List<LiveItem> items` plus the index
   * (`LiveTvPlayerPage`), so the panel and the ↑/↓ keys can never disagree about
   * what the next channel is. Returns `null` when nothing is stored.
   */
  static list(): { channels: IptvZapChannel[]; currentUrl: string; index: number } | null {
    const zap = IptvZapStore.get();
    if (!zap) return null;
    return {
      channels: zap.channels,
      currentUrl: zap.currentUrl,
      index: zap.channels.findIndex((channel) => channel.url === zap.currentUrl),
    };
  }
}

/** Classify an IPTV URL into the engine hint the player expects. */
export function detectIptvFormat(url: string): 'hls' | 'dash' | 'mpegts' | 'direct' {
  const value = url || '';
  if (/\.m3u8($|\?)/i.test(value) || /[?&]format=m3u8\b/i.test(value)) return 'hls';
  if (/\.mpd($|\?)/i.test(value) || /[?&]format=mpd\b/i.test(value)) return 'dash';
  if (/\.(ts|flv)($|\?)/i.test(value)) return 'mpegts';
  if (/\/live\//i.test(value) || /:8080|:8000|:25461|:9981/i.test(value)) {
    return /playlist|index|master/i.test(value) ? 'hls' : 'mpegts';
  }
  return 'direct';
}

/** Short user-facing label for a detected format, used on source badges. */
export function formatIptvBadge(format: string): string {
  switch (format) {
    case 'hls': return 'HLS';
    case 'dash': return 'DASH';
    case 'mpegts': return 'MPEG-TS';
    case 'direct': return 'DIRECT';
    default: return format.toUpperCase() || 'LIVE';
  }
}

/**
 * Shared media/stream builder for channel taps, the player's zapping and the
 * zap bar.
 *
 * `items` is the list the channel came from and `index` its place in it, the
 * way `openLivePlayer(context, items, i)` takes them. A caller that has no list
 * (a favourite opened on its own, the bar's arrows) passes none and gets a
 * one-channel list, so the player still has a valid `items`/`index` pair.
 */
export function buildIptvPlayback(
  channel: LivePlaybackItem,
  options: { items?: readonly LivePlaybackItem[]; index?: number } = {},
): IptvPlayback {
  return buildFromItem(channel, options.items, options.index);
}

/**
 * A `LiveItem` as a list entry the player can walk.
 *
 * `LiveItem` is VyseTV's own shape and already carries the guide loader and the
 * favourites key, so the mapping is a field rename: `title` is the row's name
 * (`IptvZapChannel.name`), `subtitle` its group line.
 */
export function playbackItemOf(item: LiveItem): LivePlaybackItem {
  return {
    name: item.title,
    url: item.url,
    group: item.subtitle,
    logo: item.logo,
    live: item.live,
    epg: item.epg,
    favoriteKey: item.favoriteKey,
  };
}

/** The same for a whole list — VyseTV's `[for (final x in list) LiveItem…]`. */
export function playbackItemsOf(items: readonly LiveItem[]): LivePlaybackItem[] {
  return items.map(playbackItemOf);
}

/** `items[index]` in one call, for a list the view already holds. */
export function buildIptvPlaybackAt(
  items: readonly LivePlaybackItem[],
  index: number,
): IptvPlayback {
  const at = items.length ? Math.min(Math.max(index, 0), items.length - 1) : 0;
  const item = items[at] ?? { name: 'Live TV', url: '' };
  return buildFromItem(item, items, at);
}

function buildFromItem(
  channel: LivePlaybackItem,
  items: readonly LivePlaybackItem[] | undefined,
  index: number | undefined,
): IptvPlayback {
  const url = channel.url || '';
  const format = detectIptvFormat(url);
  const stamp = Date.now();
  const media: MediaItem = {
    id: `livetv-${stamp}`,
    title: channel.name,
    type: 'movie',
    source: 'iptv',
    poster: channel.logo || 'https://images.unsplash.com/photo-1594909122845-11baa439b7bf?auto=format&fit=crop&w=600&q=80',
    overview: `Live TV Stream · Broadcast via ${channel.group || 'Live TV'}`,
    genres: ['Live TV', channel.group || 'Live TV'],
  };
  const stream: StreamResult = {
    id: `livetv-stream-${stamp}`,
    title: channel.name,
    url,
    sourceName: channel.group || 'Live TV',
    sourceType: 'iptv',
    quality: '1080p',
    format,
  };
  // A caller that knows the item is live says so; anything else keeps the old
  // behaviour (a channel tap is live), so existing call sites stay correct.
  const live: LivePlaybackMeta = {
    live: channel.live ?? true,
    epg: channel.epg,
    favoriteKey: channel.favoriteKey,
  };
  // The list, with this channel's entry replaced by the caller's version of it:
  // a page may know the guide and the favourites key that the row it handed
  // over did not carry.
  const list = items?.length ? [...items] : [channel];
  const at = items?.length ? Math.min(Math.max(index ?? 0, 0), list.length - 1) : 0;
  list[at] = { ...list[at], ...channel };
  return { media, stream, live, items: list, index: at };
}
