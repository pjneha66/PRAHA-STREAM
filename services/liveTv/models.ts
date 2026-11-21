// Domain models for the Live TV port.
//
// Ported from VyseTV `lib/models/iptv/iptv_models.dart` and
// `lib/models/iptv/m3u_models.dart` (GPL-3.0-or-later). A plain TypeScript
// transcription: no Flutter types, just the data the controller and UI need.

/** An Xtream-Codes account as the user entered it. */
export interface IptvPortal {
  url: string;
  username: string;
  password: string;
  source?: string;
}

/** A portal whose credentials were checked with `player_api.php`. */
export interface VerifiedPortal {
  portal: IptvPortal;
  name: string;
  expiry: string;
  maxConnections: string;
  activeConnections: string;
}

export interface IptvCategory {
  id: string;
  name: string;
}

export type IptvSection = 'live' | 'vod' | 'series';

export interface IptvStream {
  streamId: string;
  name: string;
  icon: string;
  categoryId: string;
  containerExt: string;
  kind: IptvSection;
  epgChannelId?: string;
}

/**
 * One EPG row. Timestamps keep the provider's original shape.
 *
 * The index signature is what lets a provider row be handed straight to the
 * guide helpers, whose `EpgProgram` carries one so callers can keep whatever
 * extra columns the provider sent.
 */
export interface EpgEntry {
  title: string;
  description: string;
  start: number | string;
  stop: number | string;
  [key: string]: unknown;
}

export interface IptvEpisode {
  id: string;
  title: string;
  containerExt: string;
  season: number;
  episode: number;
  plot: string;
  image: string;
}

/** A built-in channel from the curated catalogue. */
export interface HardcodedChannel {
  id: string;
  name: string;
  shortName: string;
  category: string;
  keywords: string[];
  exclude?: string[];
  gradient: [string, string];
  logo?: string;
  backdropUrl?: string;
  /** Legacy alias used by some UI code; the Dart field is `iconUrl`. */
  iconUrl?: string;
}

/** A user-added quick channel. */
export interface QuickChannel {
  id: string;
  name: string;
  shortName: string;
  category: string;
  keywords: string[];
  gradient: [string, string];
  logo?: string;
}

/** A working stream for a built-in channel on a verified portal. */
export interface ChannelHit {
  channel?: HardcodedChannel;
  portal: VerifiedPortal;
  stream: IptvStream;
  streamUrl: string;
}

export interface M3uChannel {
  name: string;
  url: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  tvgName?: string;
}

export interface M3uPlaylist {
  id: string;
  name: string;
  sourceUrl: string;
  addedAt?: number;
  channels: M3uChannel[];
  updatedAt: number;
}

/** A fixture as delivered by Nuvio / Dami / PPV scrapers. */
export interface LiveMatchEvent {
  id: string;
  title: string;
  league: string;
  category: string;
  startsAt?: number;
  endsAt?: number;
  timeLabel: string;
  isLive: boolean;
  homeTeam?: { name: string; badge?: string };
  awayTeam?: { name: string; badge?: string };
  viewers?: number;
  streamUrl: string;
  poster?: string;
  nuvio?: boolean;
}

/** Result of adding many playlists at once. */
export interface ImportSummary {
  added: number;
  skipped: number;
  failed: number;
  playlists: M3uPlaylist[];
  errors: string[];
}

export function credentialKey(portal: Pick<IptvPortal, 'username' | 'password'>): string {
  return `${portal.username}|${portal.password}`.toLowerCase();
}
