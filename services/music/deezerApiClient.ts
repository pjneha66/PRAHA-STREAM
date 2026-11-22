// Deezer public API: the metadata source for every music surface.
//
// Ported from VyseTV `lib/services/music/deezer_api_client.dart`
// (GPL-3.0-or-later). Deezer is key-free and fast, and — unlike the mixed
// iTunes/mirror metadata the old PRAHA path used — it is the *only* catalog
// source, which is what makes ids, cover art and durations agree with what the
// stream resolver later searches for.

import { nativeFetchText } from '../androidBridge';
import {
  musicAlbumFromJson,
  musicArtistFromJson,
  musicGenreFromJson,
  musicPlaylistFromJson,
  musicTrackFromJson,
  type MusicAlbum,
  type MusicAlbumDetails,
  type MusicArtist,
  type MusicArtistDetails,
  type MusicGenre,
  type MusicPlaylist,
  type MusicPlaylistDetails,
  type MusicTrack,
} from './musicTrack';

const BASE_URL = 'https://api.deezer.com';
const REQUEST_TIMEOUT_MS = 10000;

const HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** GETs a Deezer path, appending query params. `null` on any failure. */
async function get(path: string, query?: Record<string, string | number>): Promise<unknown> {
  let fullUrl = `${BASE_URL}${path}`;
  if (query && Object.keys(query).length) {
    const queryString = Object.entries(query)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    fullUrl += `${fullUrl.includes('?') ? '&' : '?'}${queryString}`;
  }

  try {
    const response = await nativeFetchText(fullUrl, { method: 'GET', headers: HEADERS, timeoutMs: REQUEST_TIMEOUT_MS });
    if (response.status !== 200 || !response.data) return null;
    return JSON.parse(response.data) as unknown;
  } catch {
    return null;
  }
}

/** Reads `data: [...]` rows out of a Deezer list payload. */
function rows(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data.filter(isRecord);
}

export async function getChartTracks(limit = 50): Promise<MusicTrack[]> {
  return rows(await get('/chart/0/tracks', { limit })).map(musicTrackFromJson);
}

export async function getChartAlbums(limit = 50): Promise<MusicAlbum[]> {
  return rows(await get('/chart/0/albums', { limit })).map(musicAlbumFromJson);
}

export async function getChartArtists(limit = 50): Promise<MusicArtist[]> {
  return rows(await get('/chart/0/artists', { limit })).map(musicArtistFromJson);
}

export async function getChartPlaylists(limit = 50): Promise<MusicPlaylist[]> {
  return rows(await get('/chart/0/playlists', { limit })).map(musicPlaylistFromJson);
}

export async function getNewReleases(limit = 50): Promise<MusicAlbum[]> {
  return rows(await get('/editorial/0/releases', { limit })).map(musicAlbumFromJson);
}

export async function getEditorialSelection(limit = 50): Promise<MusicPlaylist[]> {
  return rows(await get('/editorial/0/selection', { limit })).map(musicPlaylistFromJson);
}

export async function searchTracks(query: string, limit = 30): Promise<MusicTrack[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return rows(await get('/search', { q: trimmed, limit })).map(musicTrackFromJson);
}

export async function searchArtists(query: string, limit = 20): Promise<MusicArtist[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return rows(await get('/search/artist', { q: trimmed, limit })).map(musicArtistFromJson);
}

export async function searchAlbums(query: string, limit = 20): Promise<MusicAlbum[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return rows(await get('/search/album', { q: trimmed, limit })).map(musicAlbumFromJson);
}

export async function searchPlaylists(query: string, limit = 20): Promise<MusicPlaylist[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return rows(await get('/search/playlist', { q: trimmed, limit })).map(musicPlaylistFromJson);
}

/** Artist page: profile, top tracks, albums and related artists in parallel. */
export async function getArtistDetails(artistId: string): Promise<MusicArtistDetails | null> {
  try {
    const artistPayload = await get(`/artist/${artistId}`);
    if (!isRecord(artistPayload) || artistPayload.id === null || artistPayload.id === undefined) return null;

    const [topPayload, albumsPayload, relatedPayload] = await Promise.all([
      get(`/artist/${artistId}/top`, { limit: 50 }),
      get(`/artist/${artistId}/albums`, { limit: 50 }),
      get(`/artist/${artistId}/related`, { limit: 20 }),
    ]);

    return {
      artist: musicArtistFromJson(artistPayload),
      topTracks: rows(topPayload).map(musicTrackFromJson),
      albums: rows(albumsPayload).map(musicAlbumFromJson),
      relatedArtists: rows(relatedPayload).map(musicArtistFromJson),
    };
  } catch {
    return null;
  }
}

export async function getAlbumDetails(albumId: string): Promise<MusicAlbumDetails | null> {
  try {
    const payload = await get(`/album/${albumId}`);
    if (!isRecord(payload) || payload.id === null || payload.id === undefined) return null;

    const album = musicAlbumFromJson(payload);

    // Album payloads usually embed `tracks`, but a bare `/album/:id/tracks`
    // call is the documented fallback when they do not.
    const embedded = isRecord(payload.tracks) && Array.isArray(payload.tracks.data)
      ? payload.tracks.data.filter(isRecord)
      : null;
    const trackRows = embedded ?? rows(await get(`/album/${albumId}/tracks`, { limit: 100 }));

    const tracks = trackRows.map((row) => {
      // Track rows omit their album; backfill it so cover art survives.
      if (row.album === null || row.album === undefined) {
        return musicTrackFromJson({
          ...row,
          album: { id: album.id, title: album.title, cover_big: album.coverUrl },
        });
      }
      return musicTrackFromJson(row);
    });

    return { album, tracks };
  } catch {
    return null;
  }
}

export async function getPlaylistDetails(playlistId: string): Promise<MusicPlaylistDetails | null> {
  try {
    const payload = await get(`/playlist/${playlistId}`);
    if (!isRecord(payload) || payload.id === null || payload.id === undefined) return null;

    const playlist = musicPlaylistFromJson(payload);
    const embedded = isRecord(payload.tracks) && Array.isArray(payload.tracks.data)
      ? payload.tracks.data.filter(isRecord)
      : null;
    const trackRows = embedded ?? rows(await get(`/playlist/${playlistId}/tracks`, { limit: 100 }));

    return { playlist, tracks: trackRows.map(musicTrackFromJson) };
  } catch {
    return null;
  }
}

/** Genres, minus Deezer's pseudo-genre with id `0` ("All"). */
export async function getGenres(): Promise<MusicGenre[]> {
  return rows(await get('/genre'))
    .map(musicGenreFromJson)
    .filter((genre) => genre.id !== '0');
}

export async function getGenreArtists(genreId: string): Promise<MusicArtist[]> {
  return rows(await get(`/genre/${genreId}/artists`, { limit: 30 })).map(musicArtistFromJson);
}
