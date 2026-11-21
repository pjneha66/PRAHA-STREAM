// IPTV playback intake for the player modal and zap bar.
//
// The player contract is PRAHA-specific (`MediaItem` / `StreamResult`), but the
// format heuristics mirror the stream-type handling in VyseTV's
// `lib/screens/player/iptv_player.dart` (GPL-3.0-or-later).

import type { MediaItem, StreamResult } from '../../types';

export interface IptvZapChannel {
  name: string;
  url: string;
  group?: string;
  logo?: string;
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

/** Shared media/stream builder for channel taps and the player zap bar. */
export function buildIptvPlayback(channel: IptvZapChannel): { media: MediaItem; stream: StreamResult } {
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
  return { media, stream };
}
