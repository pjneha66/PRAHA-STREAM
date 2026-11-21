// Anything the Live TV player can play.
//
// Ported from VyseTV `lib/data/live_tv/live_tv.dart` (`LiveItem`, `xtreamUrl`,
// `fetchSeriesEpisodes`, GPL-3.0-or-later). One shape for a portal channel, a
// movie, an episode, an M3U entry and a saved favourite, so the player does not
// care which list it came from.

import type { ChannelHit, IptvEpisode, IptvSection, IptvStream, M3uChannel, VerifiedPortal } from './models';
import { normalizePortalUrl } from './portal';
import { portalLabel } from './portalNames';
import { LiveFavorites, type FavoriteChannel } from './liveFavorites';
import { IptvClient } from './network';
import { getJson } from './http';

/** EPG lookup for a live item; `null` when the item has no guide. */
export type EpgLoader = () => Promise<{ title: string; description?: string; start: number | string; stop: number | string }[]>;

export interface LiveItem {
  title: string;
  url: string;
  subtitle?: string;
  logo?: string;
  /** Live streams get a LIVE badge and EPG; VOD gets a seek bar. */
  live: boolean;
  epg?: EpgLoader;
  /** What makes it a favourite, for what can be one. */
  favoriteKey?: string;
}

function base(portal: VerifiedPortal): string {
  return normalizePortalUrl(portal.portal.url);
}

/** Standard Xtream Codes stream paths. */
export function xtreamUrl(portal: VerifiedPortal, stream: IptvStream, section: IptvSection): string {
  const root = base(portal);
  const user = encodeURIComponent(portal.portal.username);
  const pass = encodeURIComponent(portal.portal.password);
  const id = encodeURIComponent(stream.streamId);
  const ext = (stream.containerExt || '').trim();
  if (section === 'live') return `${root}/live/${user}/${pass}/${id}.${ext || 'ts'}`;
  if (section === 'vod') return `${root}/movie/${user}/${pass}/${id}.${ext || 'mp4'}`;
  return `${root}/series/${user}/${pass}/${id}.${ext || 'mp4'}`;
}

/** A working stream for a built-in channel, as a playable item. */
export function liveItemFromHit(hit: ChannelHit, channelName?: string): LiveItem {
  return {
    title: channelName ?? hit.stream.name,
    subtitle: [portalLabel(hit.portal), channelName ? hit.stream.name : ''].filter(Boolean).join('  ·  '),
    logo: hit.stream.icon || undefined,
    url: hit.streamUrl,
    live: true,
    epg: () => IptvClient.shortEpg(hit.portal.portal, hit.stream.streamId, 2),
    favoriteKey: LiveFavorites.keyOf(hit.portal, hit.stream),
  };
}

export function liveItemFromM3u(channel: M3uChannel, playlist?: string): LiveItem {
  return {
    title: channel.name,
    subtitle: [playlist || '', channel.group || ''].filter(Boolean).join('  ·  ') || undefined,
    logo: channel.logo,
    url: channel.url,
    live: true,
    favoriteKey: LiveFavorites.keyOfM3u(channel.url),
  };
}

/** A favourite, from Live TV > Favorites: played by its saved address. */
export function liveItemFromFavorite(channel: FavoriteChannel): LiveItem {
  return {
    title: channel.title,
    subtitle: channel.from,
    logo: channel.logo,
    url: channel.url,
    live: true,
    favoriteKey: channel.key,
  };
}

export function liveItemFromStream(portal: VerifiedPortal, stream: IptvStream, section: IptvSection): LiveItem {
  return {
    title: stream.name,
    subtitle: portalLabel(portal),
    logo: stream.icon || undefined,
    url: xtreamUrl(portal, stream, section),
    live: section === 'live',
    epg: section === 'live' ? () => IptvClient.shortEpg(portal.portal, stream.streamId, 2) : undefined,
    favoriteKey: section === 'live' ? LiveFavorites.keyOf(portal, stream) : undefined,
  };
}

export function liveItemFromEpisode(portal: VerifiedPortal, series: IptvStream, episode: IptvEpisode): LiveItem {
  const ext = episode.containerExt || 'mp4';
  return {
    title: episode.title || `Episode ${episode.episode}`,
    subtitle: `${series.name}  ·  S${episode.season} E${episode.episode}`,
    logo: episode.image || series.icon || undefined,
    url: `${base(portal)}/series/${encodeURIComponent(portal.portal.username)}/${encodeURIComponent(portal.portal.password)}/${encodeURIComponent(episode.id)}.${ext}`,
    live: false,
  };
}

function parseEpisode(raw: unknown, fallbackSeason: number): IptvEpisode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const info = row.info && typeof row.info === 'object' && !Array.isArray(row.info) ? (row.info as Record<string, unknown>) : {};
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    containerExt: String(row.container_extension ?? 'mp4'),
    season: Number.parseInt(String(row.season ?? ''), 10) || fallbackSeason,
    episode: Number.parseInt(String(row.episode_num ?? ''), 10) || 0,
    plot: String(info.plot ?? ''),
    image: String(info.movie_image ?? ''),
  };
}

/** Episodes for a series stream, straight from the portal's player API. */
export async function fetchSeriesEpisodes(portal: VerifiedPortal, series: IptvStream, timeoutMs = 20000): Promise<IptvEpisode[]> {
  const root = base(portal);
  const query = new URLSearchParams({
    username: portal.portal.username,
    password: portal.portal.password,
    action: 'get_series_info',
    series_id: series.streamId,
  });
  const body = await getJson<Record<string, unknown>>(`${root}/player_api.php?${query.toString()}`, timeoutMs);
  if (!body) throw new Error('Could not load series episodes.');

  const seasons = body.episodes;
  const out: IptvEpisode[] = [];
  if (seasons && typeof seasons === 'object' && !Array.isArray(seasons)) {
    for (const [seasonKey, list] of Object.entries(seasons as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const fallback = Number.parseInt(seasonKey, 10) || 1;
      for (const raw of list) {
        const episode = parseEpisode(raw, fallback);
        if (episode) out.push(episode);
      }
    }
  } else if (Array.isArray(seasons)) {
    for (const list of seasons) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const episode = parseEpisode(raw, 1);
        if (episode) out.push(episode);
      }
    }
  }
  out.sort((a, b) => (a.season !== b.season ? a.season - b.season : a.episode - b.episode));
  return out;
}
