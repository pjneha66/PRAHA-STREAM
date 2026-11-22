// Music catalog models, as Deezer returns them.
//
// Ported from VyseTV `lib/models/music/music_track.dart` (GPL-3.0-or-later).
// The `fromJson` fallback chains are kept verbatim — Deezer's payloads are
// inconsistent across endpoints (search rows nest `artist`/`album`, chart rows
// often flatten them), and the cascade of `??` alternatives is what makes a
// single parser work for all of them.
//
// The one deliberate difference is the duration field name: the Dart model
// calls it `durationSeconds`, and the port keeps that so nothing is ambiguous
// at the call site. `services/musicService.ts` maps it onto the app's existing
// `duration` shape for the UI.

function httpsOnly(url: string): string {
  return url.startsWith('http://') ? url.replace('http://', 'https://') : url;
}

function text(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function integer(value: unknown): number | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(record);
  return [];
}

/** Deezer's `tracks` field is either `{data: [...]}` or a bare array. */
function nestedTracks(value: unknown): Record<string, unknown>[] {
  const holder = record(value);
  if (Array.isArray(holder.data)) return holder.data.map(record);
  return list(value);
}

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  album: string;
  albumId: string;
  coverUrl: string;
  durationSeconds: number;
  explicit: boolean;
  previewUrl?: string;
  trackNumber?: number;
}

export function musicTrackFromJson(json: Record<string, unknown>): MusicTrack {
  const albumData = record(json.album);
  const artistData = record(json.artist);

  const cover = httpsOnly(
    text(albumData.cover_xl)
      ?? text(albumData.cover_big)
      ?? text(albumData.cover_medium)
      ?? text(albumData.cover_small)
      ?? text(json.cover_xl)
      ?? text(json.cover_big)
      ?? text(json.cover_medium)
      ?? text(json.cover_small)
      ?? text(json.cover)
      ?? text(json.coverUrl)
      ?? '',
  );

  // Deezer reports explicit content as `explicit_lyrics: true` on tracks and
  // as `explicit: 1` inside album payloads.
  const explicitValue = json.explicit_lyrics ?? json.explicit;

  return {
    id: text(json.id) ?? '',
    title: text(json.title) ?? text(json.title_short) ?? 'Unknown Track',
    artist: text(artistData.name) ?? text(json.artist) ?? 'Unknown Artist',
    artistId: text(artistData.id) ?? text(json.artistId) ?? '',
    album: text(albumData.title) ?? text(json.album) ?? 'Single',
    albumId: text(albumData.id) ?? text(json.albumId) ?? '',
    coverUrl: cover,
    durationSeconds: integer(json.duration) ?? integer(json.durationSeconds) ?? 0,
    explicit: explicitValue === true || explicitValue === 1,
    previewUrl: text(json.preview) ?? text(json.previewUrl),
    trackNumber: integer(json.track_position) ?? integer(json.trackNumber),
  };
}

export function musicTrackToJson(track: MusicTrack): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    artistId: track.artistId,
    album: track.album,
    albumId: track.albumId,
    coverUrl: track.coverUrl,
    durationSeconds: track.durationSeconds,
    explicit: track.explicit,
  };
  if (track.previewUrl !== undefined) out.previewUrl = track.previewUrl;
  if (track.trackNumber !== undefined) out.trackNumber = track.trackNumber;
  return out;
}

/** "3:45" style duration, or `--:--` when unknown. */
export function formattedDuration(track: Pick<MusicTrack, 'durationSeconds'>): string {
  if (track.durationSeconds <= 0) return '--:--';
  const minutes = Math.floor(track.durationSeconds / 60).toString().padStart(2, '0');
  const seconds = (track.durationSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export interface MusicArtist {
  id: string;
  name: string;
  pictureUrl: string;
  fanCount: number;
  albumCount: number;
}

export function musicArtistFromJson(json: Record<string, unknown>): MusicArtist {
  const pictureUrl = httpsOnly(
    text(json.picture_xl)
      ?? text(json.picture_big)
      ?? text(json.picture_medium)
      ?? text(json.picture_small)
      ?? text(json.picture)
      ?? text(json.pictureUrl)
      ?? '',
  );
  return {
    id: text(json.id) ?? '',
    name: text(json.name) ?? 'Artist',
    pictureUrl,
    fanCount: integer(json.nb_fan) ?? integer(json.nbFan) ?? integer(json.fanCount) ?? 0,
    albumCount: integer(json.nb_album) ?? integer(json.nbAlbum) ?? integer(json.albumCount) ?? 0,
  };
}

export interface MusicAlbum {
  id: string;
  title: string;
  artistName: string;
  artistId: string;
  coverUrl: string;
  releaseDate: string;
  trackCount: number;
  tracks: MusicTrack[];
}

export function musicAlbumFromJson(json: Record<string, unknown>): MusicAlbum {
  const artistData = record(json.artist);
  const coverUrl = httpsOnly(
    text(json.cover_xl)
      ?? text(json.cover_big)
      ?? text(json.cover_medium)
      ?? text(json.cover_small)
      ?? text(json.cover)
      ?? text(json.coverUrl)
      ?? '',
  );
  const tracks = nestedTracks(json.tracks).map(musicTrackFromJson);
  return {
    id: text(json.id) ?? '',
    title: text(json.title) ?? 'Album',
    artistName: text(artistData.name) ?? text(json.artistName) ?? 'Unknown Artist',
    artistId: text(artistData.id) ?? text(json.artistId) ?? '',
    coverUrl,
    releaseDate: text(json.release_date) ?? text(json.releaseDate) ?? '',
    trackCount: integer(json.nb_tracks) ?? integer(json.nbTracks) ?? integer(json.trackCount) ?? tracks.length,
    tracks,
  };
}

export interface MusicPlaylist {
  id: string;
  title: string;
  description: string;
  coverUrl: string;
  trackCount: number;
  creatorName: string;
  tracks: MusicTrack[];
}

export function musicPlaylistFromJson(json: Record<string, unknown>): MusicPlaylist {
  // Playlists name their owner `creator`; the chart endpoints use `user`.
  const creatorData = json.creator && typeof json.creator === 'object' && !Array.isArray(json.creator)
    ? record(json.creator)
    : record(json.user);

  const coverUrl = httpsOnly(
    text(json.picture_xl)
      ?? text(json.picture_big)
      ?? text(json.picture_medium)
      ?? text(json.picture_small)
      ?? text(json.picture)
      ?? text(json.coverUrl)
      ?? '',
  );
  const tracks = nestedTracks(json.tracks).map(musicTrackFromJson);
  return {
    id: text(json.id) ?? '',
    title: text(json.title) ?? 'Playlist',
    description: text(json.description) ?? '',
    coverUrl,
    trackCount: integer(json.nb_tracks) ?? integer(json.nbTracks) ?? integer(json.trackCount) ?? tracks.length,
    creatorName: text(creatorData.name) ?? text(json.creatorName) ?? 'Deezer',
    tracks,
  };
}

export interface MusicGenre {
  id: string;
  name: string;
  pictureUrl: string;
}

export function musicGenreFromJson(json: Record<string, unknown>): MusicGenre {
  return {
    id: text(json.id) ?? '',
    name: text(json.name) ?? 'Genre',
    pictureUrl: httpsOnly(
      text(json.picture_xl)
        ?? text(json.picture_big)
        ?? text(json.picture_medium)
        ?? text(json.picture_small)
        ?? text(json.picture)
        ?? '',
    ),
  };
}

export interface MusicSearchData {
  tracks: MusicTrack[];
  artists: MusicArtist[];
  albums: MusicAlbum[];
  playlists: MusicPlaylist[];
}

export const EMPTY_SEARCH_DATA: MusicSearchData = { tracks: [], artists: [], albums: [], playlists: [] };

export interface MusicArtistDetails {
  artist: MusicArtist;
  topTracks: MusicTrack[];
  albums: MusicAlbum[];
  relatedArtists: MusicArtist[];
}

export interface MusicAlbumDetails {
  album: MusicAlbum;
  tracks: MusicTrack[];
}

export interface MusicPlaylistDetails {
  playlist: MusicPlaylist;
  tracks: MusicTrack[];
}
