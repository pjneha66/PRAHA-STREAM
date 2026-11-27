import type { MusicTrack as DeezerTrack } from './music/musicTrack';
import * as vyseMusic from './music/musicService';
import { getAudioUrl as extractorAudioUrl, searchVideoId } from './music/youtubeAudioExtractor';
import { forgetStreamUrl, resetStreamResolverCache, resolveUrl } from './music/youtubeStreamResolver';
import { youtubeRateLimitGuard } from './music/youtubeRateLimitGuard';
import { nativeFetchText, proxyStreamUrlWithHeaders } from './androidBridge';

/**
 * Music data + playback layer.
 *
 * Deezer provides the main catalog. The iTunes Search API supplies song
 * results when Deezer's regional track list is empty. Both use the same
 * full-stream resolver and retain their catalog previews.
 *
 * The exported surface is unchanged so the four call sites — MusicView,
 * MusicPlayerProvider, DiscoverView (type only) and App's universal search —
 * keep working. Internally, the Deezer model's `durationSeconds` is mapped
 * onto the app's `duration`.
 */

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  /** Length in seconds. */
  duration: number;
  coverUrl: string;
  /** Catalog preview, used when a full stream is unavailable. */
  previewUrl?: string;
  storeUrl?: string;
  explicit?: boolean;
  trackNumber?: number;
}

export interface MusicArtist {
  id: string;
  name: string;
  pictureUrl: string;
  fanCount?: number;
  albumCount?: number;
}

export interface MusicAlbum {
  id: string;
  title: string;
  artist: string;
  coverUrl: string;
  releaseDate?: string;
  trackCount?: number;
}

export interface OctaveSearchData {
  tracks: MusicTrack[];
  artists: MusicArtist[];
  albums: MusicAlbum[];
}

export interface OctaveArtistDetails {
  artist: MusicArtist;
  topTracks: MusicTrack[];
  albums: MusicAlbum[];
  relatedArtists: MusicArtist[];
}

export interface OctavePlaylistDetails {
  id: string;
  title: string;
  description: string;
  coverUrl: string;
  tracks: MusicTrack[];
}

/** A resolved stream plus the User-Agent its CDN URL was signed for. */
export interface MusicPlayback {
  /** Ready for an `<audio>` element: proxied through native when it must be. */
  url: string;
  /** The URL as resolved, before any local proxy rewrite. */
  sourceUrl: string;
  userAgent?: string;
}

/**
 * Offline-safe emergency sections so the home view is never blank. These are
 * the app's own rows, not part of the VyseTV port: VyseTV simply renders fewer
 * shelves when Deezer is unreachable, but a blank Music tab reads as broken.
 */
export const FALLBACK_FEATURED_SECTIONS: Record<string, MusicTrack[]> = {
  'Top Global & Trending Hits': [
    {
      id: 'deezer-908604612',
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      album: 'After Hours',
      duration: 200,
      coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/2f4b6bb0a5b7a0c1a1c9f9e3b4b4a1f1/500x500-000000-80-0-0.jpg',
    },
  ],
};

/** Deezer track → app track. */
function toAppTrack(track: DeezerTrack): MusicTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    artistId: track.artistId || undefined,
    album: track.album || undefined,
    albumId: track.albumId || undefined,
    duration: track.durationSeconds,
    coverUrl: track.coverUrl,
    previewUrl: track.previewUrl,
    explicit: track.explicit,
    trackNumber: track.trackNumber,
  };
}

/** App track → the shape the ported resolver expects. */
function toResolverTrack(track: MusicTrack): DeezerTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    artistId: track.artistId ?? '',
    album: track.album ?? '',
    albumId: track.albumId ?? '',
    coverUrl: track.coverUrl,
    durationSeconds: track.duration,
    explicit: Boolean(track.explicit),
    previewUrl: track.previewUrl,
    trackNumber: track.trackNumber,
  };
}

/** YT videoId-shaped ids can skip the search entirely. */
function isVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

function appleUrl(value: unknown, domain: string): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password
        && (url.hostname === domain || url.hostname.endsWith('.' + domain))) return url.href;
  } catch { /* Ignore malformed catalog URLs. */ }
}

async function searchStoreSongs(query: string): Promise<MusicTrack[]> {
  try {
    const url = new URL('https://itunes.apple.com/search');
    url.search = new URLSearchParams({ term: query, media: 'music', entity: 'song', limit: '30' }).toString();
    const response = await nativeFetchText(url.href, { timeoutMs: 5500 });
    if (!response.ok) return [];
    const { results } = JSON.parse(response.data);
    if (!Array.isArray(results)) return [];
    const songs = new Map<string, MusicTrack>();
    for (const row of results) {
      if (row?.kind !== 'song' || !Number.isSafeInteger(row.trackId)
          || typeof row.trackName !== 'string' || typeof row.artistName !== 'string') continue;
      const title = row.trackName.trim();
      const artist = row.artistName.trim();
      const storeUrl = appleUrl(row.trackViewUrl, 'music.apple.com') || appleUrl(row.trackViewUrl, 'itunes.apple.com');
      if (!title || !artist || !storeUrl) continue;
      const key = JSON.stringify([title.toLowerCase(), artist.toLowerCase()]);
      const track = {
        id: 'itunes:' + row.trackId, title, artist, storeUrl,
        album: typeof row.collectionName === 'string' ? row.collectionName : undefined,
        coverUrl: appleUrl(row.artworkUrl100, 'mzstatic.com')?.replace(/100x100bb(?=\.)/, '400x400bb') || '',
        duration: typeof row.trackTimeMillis === 'number' ? Math.round(row.trackTimeMillis / 1000) : 0,
        previewUrl: appleUrl(row.previewUrl, 'itunes.apple.com') || appleUrl(row.previewUrl, 'mzstatic.com'),
        explicit: row.trackExplicitness === 'explicit',
      };
      if (!songs.has(key) || (!songs.get(key)?.previewUrl && track.previewUrl)) songs.set(key, track);
    }
    return [...songs.values()];
  } catch {
    return [];
  }
}

export class OctaveMusicService {
  static async searchFull(query: string): Promise<OctaveSearchData> {
    const trimmed = query.trim();
    if (!trimmed) return { tracks: [], artists: [], albums: [] };

    const data = await vyseMusic.searchFull(trimmed);
    const tracks = data.tracks.length ? data.tracks.map(toAppTrack) : await searchStoreSongs(trimmed);

    return {
      tracks,
      artists: data.artists.map((artist) => ({
        id: artist.id,
        name: artist.name,
        pictureUrl: artist.pictureUrl,
        fanCount: artist.fanCount,
        albumCount: artist.albumCount,
      })),
      albums: data.albums.map((album) => ({
        id: album.id,
        title: album.title,
        artist: album.artistName,
        coverUrl: album.coverUrl,
        releaseDate: album.releaseDate,
        trackCount: album.trackCount,
      })),
    };
  }

  /**
   * Resolves a track id that is already a YouTube video id. Catalog ids have
   * no detail endpoint of their own, so they resolve to `null` here — use
   * {@link resolveTrack} for those.
   */
  static async getAudioStreamUrl(trackId: string): Promise<string | null> {
    if (!trackId || !isVideoId(trackId)) return null;
    const audio = await extractorAudioUrl(trackId);
    return audio?.url ?? null;
  }

  /**
   * Full playback resolution for a track, including the User-Agent the stream
   * needs. This is the entry point the player should use.
   */
  static async resolveTrack(track: MusicTrack): Promise<MusicPlayback | null> {
    const resolved = await resolveUrl(toResolverTrack(track));
    if (track.previewUrl && track.storeUrl && (!resolved || resolved.url === track.previewUrl)) {
      return { url: track.previewUrl, sourceUrl: track.previewUrl };
    }
    if (!resolved?.url) return null;

    // An `<audio>` element cannot set a User-Agent, and googlevideo rejects a
    // URL fetched with the wrong one. The native proxy forwards headers, so
    // UA-bound streams are rewritten through it when it is available.
    const url = resolved.userAgent
      ? proxyStreamUrlWithHeaders(resolved.url, { 'User-Agent': resolved.userAgent })
      : resolved.url;

    return { url, sourceUrl: resolved.url, userAgent: resolved.userAgent };
  }

  /**
   * URL-only playback resolution, kept for callers that just need a string.
   * Prefer {@link resolveTrack} — this drops the User-Agent, so UA-bound
   * streams will only play through the native proxy.
   */
  static async resolveFullTrackAudio(title: string, artist: string, trackId?: string): Promise<string | null> {
    if (trackId && isVideoId(trackId)) {
      const byId = await this.getAudioStreamUrl(trackId);
      if (byId) return byId;
    }
    if (!title) return null;

    // No duration or preview here: the caller only gave us a title and artist.
    const resolved = await resolveUrl({
      id: trackId || `${artist}|${title}`,
      title,
      artist: artist || '',
      artistId: '',
      album: '',
      albumId: '',
      coverUrl: '',
      durationSeconds: 0,
      explicit: false,
    });
    if (!resolved?.url) return null;
    return resolved.userAgent
      ? proxyStreamUrlWithHeaders(resolved.url, { 'User-Agent': resolved.userAgent })
      : resolved.url;
  }

  /** Finds the YouTube video id for a title/artist pair, without resolving it. */
  static async findVideoId(title: string, artist: string, duration?: number): Promise<string | null> {
    return searchVideoId(title, artist, { targetDuration: duration && duration > 0 ? duration : null });
  }

  /**
   * Artist "page". Port of `fetchArtistDetails`: Deezer's artist endpoint when
   * we have an id, otherwise the artist is derived from a track search.
   */
  static async fetchArtistDetails(artist: { name: string; id?: string }): Promise<OctaveArtistDetails | null> {
    if (!artist.name) return null;

    if (artist.id) {
      const details = await vyseMusic.fetchArtistDetails(artist.id);
      if (details) {
        return {
          artist: {
            id: details.artist.id,
            name: details.artist.name,
            pictureUrl: details.artist.pictureUrl,
            fanCount: details.artist.fanCount,
            albumCount: details.artist.albumCount,
          },
          topTracks: details.topTracks.map(toAppTrack),
          albums: details.albums.map((album) => ({
            id: album.id,
            title: album.title,
            artist: album.artistName,
            coverUrl: album.coverUrl,
            releaseDate: album.releaseDate,
            trackCount: album.trackCount,
          })),
          relatedArtists: details.relatedArtists.map((entry) => ({
            id: entry.id,
            name: entry.name,
            pictureUrl: entry.pictureUrl,
            fanCount: entry.fanCount,
            albumCount: entry.albumCount,
          })),
        };
      }
    }

    // No id: fall back to a name search, which is what the app did before.
    const search = await this.searchFull(artist.name);
    const lower = artist.name.toLowerCase();
    const matching = search.tracks.filter((track) => track.artist.toLowerCase() === lower);
    const rest = search.tracks.filter((track) => track.artist.toLowerCase() !== lower);
    const picture = search.artists.find((entry) => entry.name === artist.name)?.pictureUrl ?? '';
    return {
      artist: { id: artist.id || lower, name: artist.name, pictureUrl: picture },
      topTracks: [...matching, ...rest].slice(0, 20),
      albums: [],
      relatedArtists: search.artists.filter((entry) => entry.name !== artist.name).slice(0, 8),
    };
  }

  static async fetchAlbumDetails(albumId: string): Promise<{ album: MusicAlbum; tracks: MusicTrack[] } | null> {
    const details = await vyseMusic.fetchAlbumDetails(albumId);
    if (!details) return null;
    return {
      album: {
        id: details.album.id,
        title: details.album.title,
        artist: details.album.artistName,
        coverUrl: details.album.coverUrl,
        releaseDate: details.album.releaseDate,
        trackCount: details.album.trackCount,
      },
      tracks: details.tracks.map(toAppTrack),
    };
  }

  static async fetchPlaylistDetails(playlistId: string): Promise<OctavePlaylistDetails | null> {
    const details = await vyseMusic.fetchPlaylistDetails(playlistId);
    if (!details) return null;
    return {
      id: details.playlist.id,
      title: details.playlist.title,
      description: details.playlist.description,
      coverUrl: details.playlist.coverUrl,
      tracks: details.tracks.map(toAppTrack),
    };
  }

  static async fetchGenres(): Promise<Array<{ id: string; name: string; pictureUrl: string }>> {
    return vyseMusic.fetchGenres();
  }

  static async fetchGenreTracks(genreName: string): Promise<MusicTrack[]> {
    const tracks = await vyseMusic.fetchGenreTracks(genreName);
    return tracks.map(toAppTrack);
  }

  /**
   * Home shelves. Port of `fetchFeaturedSections`: the Deezer chart rail plus
   * six editorial queries. The static rows are only used when Deezer returns
   * nothing at all, so the tab is never empty.
   */
  static async fetchFeaturedSections(): Promise<Record<string, MusicTrack[]>> {
    const sections = await vyseMusic.fetchFeaturedSections();
    const results: Record<string, MusicTrack[]> = {};
    for (const [title, tracks] of Object.entries(sections)) {
      if (tracks.length) results[title] = tracks.map(toAppTrack);
    }

    if (!Object.keys(results).length) {
      for (const [title, tracks] of Object.entries(FALLBACK_FEATURED_SECTIONS)) {
        results[title] = tracks;
      }
    }
    return results;
  }

  /** Non-null while YouTube is cooling down; safe to show to the user. */
  static get rateLimitMessage(): string | null {
    return youtubeRateLimitGuard.isLimited ? youtubeRateLimitGuard.userMessage : null;
  }

  /**
   * Marks a track's current stream URL as dead so the next resolve mints a
   * fresh one from the cached video id. Called when the audio element errors
   * mid-play — the URL was refused before its own expiry.
   */
  static forgetStreamUrl(trackId: string): void {
    forgetStreamUrl(trackId);
  }

  /** Drops every cached video id, stream and extractor config. */
  static resetCaches(): void {
    resetStreamResolverCache();
  }
}
