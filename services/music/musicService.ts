// The music service surface: catalog browsing plus stream resolution.
//
// Ported from VyseTV `lib/services/music/music_service.dart`
// (GPL-3.0-or-later). Deezer is the only metadata source, and playback goes
// through the YouTube stream resolver chain.
//
// The home shelves are the Dart's, verbatim — same chart rail, same six
// editorial queries, same ordering — so the Music tab browses what VyseTV
// browses.

import * as deezer from './deezerApiClient';
import {
  EMPTY_SEARCH_DATA,
  type MusicAlbum,
  type MusicAlbumDetails,
  type MusicArtist,
  type MusicArtistDetails,
  type MusicGenre,
  type MusicPlaylist,
  type MusicPlaylistDetails,
  type MusicSearchData,
  type MusicTrack,
} from './musicTrack';
import { resolveUrl, streamResolverMessage } from './youtubeStreamResolver';
import { fetchLyrics, type LyricsData } from './lyricsService';

export interface MusicStreamResult {
  url: string;
  userAgent?: string;
  format: string;
  quality: string;
}

/** Port of `MusicService.searchFull`: tracks, artists, albums, playlists. */
export async function searchFull(query: string): Promise<MusicSearchData> {
  const trimmed = query.trim();
  if (!trimmed) return EMPTY_SEARCH_DATA;

  try {
    const [tracks, artists, albums, playlists] = await Promise.all([
      deezer.searchTracks(trimmed, 30),
      deezer.searchArtists(trimmed, 15),
      deezer.searchAlbums(trimmed, 15),
      deezer.searchPlaylists(trimmed, 15),
    ]);
    return { tracks, artists, albums, playlists };
  } catch {
    return EMPTY_SEARCH_DATA;
  }
}

export function searchTracks(query: string): Promise<MusicTrack[]> {
  return deezer.searchTracks(query);
}

export async function fetchTrendingArtists(): Promise<MusicArtist[]> {
  return deezer.getChartArtists(20);
}

/** New releases, falling back to the album chart. Port of `fetchNewReleases`. */
export async function fetchNewReleases(): Promise<MusicAlbum[]> {
  const releases = await deezer.getNewReleases(20);
  if (releases.length) return releases;
  return deezer.getChartAlbums(20);
}

/** Chart playlists, falling back to the editorial selection. */
export async function fetchCuratedPlaylists(): Promise<MusicPlaylist[]> {
  const playlists = await deezer.getChartPlaylists(20);
  if (playlists.length) return playlists;
  return deezer.getEditorialSelection(20);
}

/**
 * The six editorial shelves, in the Dart's order. The labels are what the
 * home view shows; the values are the Deezer search queries behind them.
 */
const FEATURED_QUERIES: ReadonlyArray<readonly [string, string]> = [
  ['Pop Essentials', 'Top Pop Hits'],
  ['Hip-Hop & Rap Heavyweights', 'Hip Hop Hits'],
  ['Electronic, Dance & EDM', 'Electronic Dance'],
  ['Rock Classics & Alternative', 'Rock Essentials'],
  ['Film & Anime Soundtracks', 'Hans Zimmer Soundtracks'],
  ['Chill, Lofi & Ambient Beats', 'Lofi Beats Chill'],
];

/** Port of `fetchFeaturedSections`: chart rail first, then each shelf. */
export async function fetchFeaturedSections(): Promise<Record<string, MusicTrack[]>> {
  const results: Record<string, MusicTrack[]> = {};

  try {
    const chartTracks = await deezer.getChartTracks(25);
    if (chartTracks.length) results['Top Global & Trending Hits'] = chartTracks;

    for (const [section, query] of FEATURED_QUERIES) {
      const tracks = await deezer.searchTracks(query, 15);
      if (tracks.length) results[section] = tracks;
    }
  } catch {
    /* a failed shelf is simply absent; the view renders what arrived */
  }

  return results;
}

export function fetchArtistDetails(artistId: string): Promise<MusicArtistDetails | null> {
  return deezer.getArtistDetails(artistId);
}

export function fetchAlbumDetails(albumId: string): Promise<MusicAlbumDetails | null> {
  return deezer.getAlbumDetails(albumId);
}

export function fetchPlaylistDetails(playlistId: string): Promise<MusicPlaylistDetails | null> {
  return deezer.getPlaylistDetails(playlistId);
}

export function fetchGenres(): Promise<MusicGenre[]> {
  return deezer.getGenres();
}

/** Genre rows are a plain search, exactly as the Dart does it. */
export function fetchGenreTracks(genreName: string): Promise<MusicTrack[]> {
  return deezer.searchTracks(`${genreName} Top Hits`, 25);
}

/**
 * Full-length playback for a track. Port of `MusicService.getAudioStream`:
 * the resolver either produces a URL or the track is unplayable.
 */
export async function getAudioStream(track: MusicTrack): Promise<MusicStreamResult | null> {
  const resolved = await resolveUrl(track);
  if (!resolved?.url) return null;
  return {
    url: resolved.url,
    userAgent: resolved.userAgent,
    format: 'm4a',
    quality: 'YouTube HQ',
  };
}

/** Port of `MusicService.fetchLyrics`: delegates to the lyrics service. */
export async function fetchTrackLyrics(track: MusicTrack): Promise<LyricsData> {
  return fetchLyrics({
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.durationSeconds,
  });
}

/** Non-null while YouTube is cooling down; the player shows it as-is. */
export { streamResolverMessage };

export type { LyricsData };

export type {
  MusicAlbum,
  MusicAlbumDetails,
  MusicArtist,
  MusicArtistDetails,
  MusicGenre,
  MusicPlaylist,
  MusicPlaylistDetails,
  MusicSearchData,
  MusicTrack,
};
