import { nativeFetchText } from './androidBridge';

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  duration: number; // in seconds
  coverUrl: string;
  previewUrl?: string;
}

export interface MusicArtist {
  id: string;
  name: string;
  pictureUrl: string;
  followers?: number;
}

export interface MusicAlbum {
  id: string;
  title: string;
  artist: string;
  coverUrl: string;
  year?: string;
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

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class OctaveMusicService {
  private static cachedToken: string | null = null;
  private static tokenExpiry: number | null = null;

  /**
   * Fetches a valid playback token from Octave Streaming API.
   */
  static async getPlaybackToken(): Promise<string | null> {
    if (this.cachedToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.cachedToken;
    }

    try {
      const res = await nativeFetchText('https://api.octavestreaming.com/api/playback-token', {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        timeoutMs: 8000,
      });

      if (res.ok && res.data) {
        const data = JSON.parse(res.data);
        const token = data.token ? String(data.token) : null;
        const expiresIn = Number(data.expiresIn || 43200);
        if (token) {
          this.cachedToken = token;
          this.tokenExpiry = Date.now() + (expiresIn - 60) * 1000;
          return token;
        }
      }
    } catch {
      // Ignored
    }
    return null;
  }

  /**
   * Searches tracks, artists, and albums from Octave.
   */
  static async searchFull(query: string): Promise<OctaveSearchData> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { tracks: [], artists: [], albums: [] };
    }

    try {
      const url = `https://music.octavestreaming.com/api/search?q=${encodeURIComponent(trimmed)}`;
      const res = await nativeFetchText(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        timeoutMs: 10000,
      });

      if (res.ok && res.data) {
        const data = JSON.parse(res.data);

        const tracks: MusicTrack[] = Array.isArray(data.tracks)
          ? data.tracks.map((t: any) => ({
              id: String(t.id || ''),
              title: String(t.title || t.name || ''),
              artist: String(t.artist?.name || t.artist || ''),
              artistId: t.artist?.id ? String(t.artist.id) : undefined,
              album: String(t.album?.title || t.album || ''),
              albumId: t.album?.id ? String(t.album.id) : undefined,
              duration: Number(t.duration || 0),
              coverUrl: String(t.album?.cover_medium || t.album?.cover_big || t.cover || ''),
              previewUrl: t.preview,
            })).filter((t: MusicTrack) => Boolean(t.id && t.title))
          : [];

        const artists: MusicArtist[] = Array.isArray(data.artists)
          ? data.artists.map((a: any) => ({
              id: String(a.id || ''),
              name: String(a.name || ''),
              pictureUrl: String(a.picture_medium || a.picture_big || a.picture || ''),
              followers: a.nb_fan,
            })).filter((a: MusicArtist) => Boolean(a.id && a.name))
          : [];

        const albums: MusicAlbum[] = Array.isArray(data.albums)
          ? data.albums.map((al: any) => ({
              id: String(al.id || ''),
              title: String(al.title || ''),
              artist: String(al.artist?.name || al.artist || ''),
              coverUrl: String(al.cover_medium || al.cover_big || al.cover || ''),
              trackCount: al.nb_tracks,
            })).filter((al: MusicAlbum) => Boolean(al.id && al.title))
          : [];

        return { tracks, artists, albums };
      }
    } catch {
      // Ignored
    }
    return { tracks: [], artists: [], albums: [] };
  }

  /**
   * Resolves direct high-fidelity audio stream URL for a track.
   */
  static async getAudioStreamUrl(trackId: string, quality: 'lossless' | 'high' | 'standard' = 'lossless'): Promise<string | null> {
    const token = await this.getPlaybackToken();
    if (!token) return null;
    return `https://api.octavestreaming.com/audio/${quality}?track=${trackId}&token=${token}`;
  }

  /**
   * Fetches artist biography, top tracks, and albums.
   */
  static async fetchArtistDetails(artistId: string): Promise<OctaveArtistDetails | null> {
    try {
      const res = await nativeFetchText(`https://music.octavestreaming.com/api/artist/${artistId}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        timeoutMs: 10000,
      });

      if (res.ok && res.data) {
        const data = JSON.parse(res.data);
        if (!data.artist) return null;

        const artist: MusicArtist = {
          id: String(data.artist.id),
          name: String(data.artist.name),
          pictureUrl: String(data.artist.picture_big || data.artist.picture_medium || ''),
          followers: data.artist.nb_fan,
        };

        const topTracks: MusicTrack[] = Array.isArray(data.top)
          ? data.top.map((t: any) => ({
              id: String(t.id),
              title: String(t.title),
              artist: artist.name,
              duration: Number(t.duration || 0),
              coverUrl: String(t.album?.cover_medium || artist.pictureUrl),
            }))
          : [];

        const albums: MusicAlbum[] = Array.isArray(data.albums)
          ? data.albums.map((al: any) => ({
              id: String(al.id),
              title: String(al.title),
              artist: artist.name,
              coverUrl: String(al.cover_medium || al.cover_big || ''),
              year: al.release_date?.substring(0, 4),
            }))
          : [];

        const relatedArtists: MusicArtist[] = Array.isArray(data.related)
          ? data.related.map((r: any) => ({
              id: String(r.id),
              name: String(r.name),
              pictureUrl: String(r.picture_medium || r.picture_big || ''),
            }))
          : [];

        return { artist, topTracks, albums, relatedArtists };
      }
    } catch {
      // Ignored
    }
    return null;
  }

  /**
   * Fetches curated trending tracks and genres for home views.
   */
  static async fetchFeaturedSections(): Promise<Record<string, MusicTrack[]>> {
    const results: Record<string, MusicTrack[]> = {};
    const categories: Record<string, string> = {
      'Top Hits & Chart Toppers': 'The Weeknd',
      'Electronic & Synthwave': 'Daft Punk',
      'Pop & Vocal Essentials': 'Dua Lipa',
      'Anime & Film Soundtracks': 'Hans Zimmer',
      'Hip-Hop & R&B': 'Kendrick Lamar',
    };

    for (const [section, searchKeyword] of Object.entries(categories)) {
      try {
        const search = await this.searchFull(searchKeyword);
        if (search.tracks.length > 0) {
          results[section] = search.tracks.slice(0, 10);
        }
      } catch {
        // Ignored
      }
    }
    return results;
  }
}

