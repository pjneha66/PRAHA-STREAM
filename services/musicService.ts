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

export const FALLBACK_FEATURED_SECTIONS: Record<string, MusicTrack[]> = {
  'Top Hits & Chart Toppers': [
    {
      id: '908604612',
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      album: 'After Hours',
      duration: 200,
      coverUrl: 'https://cdn-images.dzcdn.net/images/cover/fd00ebd6d30d7253f813dba3bb1c66a9/500x500-000000-80-0-0.jpg',
      previewUrl: 'https://cdnt-preview.dzcdn.net/api/1/1/1/b/2/0/1b27825bf63c36edcdc7fac9f920214e.mp3',
    },
    {
      id: '1109930712',
      title: 'Save Your Tears',
      artist: 'The Weeknd',
      album: 'After Hours',
      duration: 215,
      coverUrl: 'https://cdn-images.dzcdn.net/images/cover/fd00ebd6d30d7253f813dba3bb1c66a9/500x500-000000-80-0-0.jpg',
      previewUrl: 'https://cdnt-preview.dzcdn.net/api/1/1/1/b/2/0/1b27825bf63c36edcdc7fac9f920214e.mp3',
    },
    {
      id: '1282442482',
      title: 'Levitating',
      artist: 'Dua Lipa',
      album: 'Future Nostalgia',
      duration: 203,
      coverUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=500&q=80',
      previewUrl: 'https://actions.google.com/sounds/v1/water/waves_crashing_on_rocks_1.ogg',
    },
  ],
  'Electronic & Synthwave': [
    {
      id: '3135556',
      title: 'Get Lucky',
      artist: 'Daft Punk feat. Pharrell Williams',
      album: 'Random Access Memories',
      duration: 248,
      coverUrl: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=500&q=80',
      previewUrl: 'https://actions.google.com/sounds/v1/science_fiction/teleport_arrival.ogg',
    },
    {
      id: '3135557',
      title: 'Instant Crush',
      artist: 'Daft Punk feat. Julian Casablancas',
      album: 'Random Access Memories',
      duration: 337,
      coverUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=500&q=80',
      previewUrl: 'https://actions.google.com/sounds/v1/science_fiction/teleport_arrival.ogg',
    },
  ],
  'Anime & Film Soundtracks': [
    {
      id: '542618',
      title: 'Time (Inception)',
      artist: 'Hans Zimmer',
      album: 'Inception (Original Soundtrack)',
      duration: 275,
      coverUrl: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=500&q=80',
      previewUrl: 'https://actions.google.com/sounds/v1/ambiences/rain_heavy.ogg',
    },
    {
      id: '542619',
      title: 'Cornfield Chase (Interstellar)',
      artist: 'Hans Zimmer',
      album: 'Interstellar (Original Soundtrack)',
      duration: 126,
      coverUrl: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=500&q=80',
      previewUrl: 'https://actions.google.com/sounds/v1/ambiences/rain_heavy.ogg',
    },
  ],
};

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
              coverUrl: String(t.album?.cover_medium || t.album?.cover_big || t.cover || t.coverUrl || ''),
              previewUrl: String(t.previewUrl || t.preview || t.streamUrl || ''),
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

    try {
      await Promise.all(
        Object.entries(categories).map(async ([section, searchKeyword]) => {
          try {
            const search = await this.searchFull(searchKeyword);
            if (search.tracks.length > 0) {
              results[section] = search.tracks.slice(0, 10);
            }
          } catch {
            // Ignored
          }
        })
      );
    } catch {}

    // Fallback: Ensure featured sections are never empty even if offline or upstream API rate-limited
    if (Object.keys(results).length === 0) {
      return FALLBACK_FEATURED_SECTIONS;
    }

    for (const [key, fallbackTracks] of Object.entries(FALLBACK_FEATURED_SECTIONS)) {
      if (!results[key] || results[key].length === 0) {
        results[key] = fallbackTracks;
      }
    }

    return results;
  }
}

