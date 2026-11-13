import { nativeFetchText } from './androidBridge';
import { flowDetail, flowMusicSearch, flowSearch } from './flowService';

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
      id: 'itunes-blinding-lights',
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      album: 'After Hours',
      duration: 200,
      coverUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/03/2d/c1/032dc13a-dce4-672a-b501-d16d3b31be07/23UMGIM20988.rgb.jpg/600x600bb.jpg',
      previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/97/37/18/97371865-a05c-3e72-3085-6ec952214c6b/mzaf_6605689750628043254.plus.aac.p.m4a',
    },
    {
      id: 'itunes-levitating',
      title: 'Levitating',
      artist: 'Dua Lipa',
      album: 'Future Nostalgia',
      duration: 203,
      coverUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/6c/11/d6/6c11d681-aa3a-d59e-4c2e-f77e181026ab/190295092665.jpg/600x600bb.jpg',
      previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/59/dc/4d/59dc4dda-93ff-8f1c-c536-f005f6ea6af5/mzaf_3066686759813252385.plus.aac.p.m4a',
    },
    {
      id: 'itunes-humble',
      title: 'HUMBLE.',
      artist: 'Kendrick Lamar',
      album: 'DAMN.',
      duration: 177,
      coverUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/ab/16/ef/ab16efe9-e7f1-66ec-021c-5592a23f0f9e/17UMGIM88793.rgb.jpg/600x600bb.jpg',
      previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/1f/2e/37/1f2e37be-bdd0-d770-6ea4-091011a6aade/mzaf_2360827885900940865.plus.aac.p.m4a',
    },
  ],
  'Electronic & Synthwave': [
    {
      id: 'itunes-get-lucky',
      title: 'Get Lucky',
      artist: 'Daft Punk feat. Pharrell Williams',
      album: 'Random Access Memories',
      duration: 248,
      coverUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/e8/43/5f/e8435ffa-b6b9-b171-40ab-4ff3959ab661/886443919266.jpg/600x600bb.jpg',
      previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/57/a5/85/57a585aa-f1bc-7619-881b-f8a04a5541d5/mzaf_6906185026678279401.plus.aac.p.m4a',
    },
    {
      id: 'itunes-synthwave-durant',
      title: 'Synthwave',
      artist: 'A. Durant',
      album: 'Synthwave Classics',
      duration: 180,
      coverUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music128/v4/0e/4e/60/0e4e604b-d28f-bf71-03e8-2ed4a096047b/artwork.jpg/600x600bb.jpg',
      previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview125/v4/ec/fe/75/ecfe75ec-af44-d6d9-3fa4-2be2543d1dbf/mzaf_7566416601163199035.plus.aac.p.m4a',
    },
  ],
  'Anime & Film Soundtracks': [
    {
      id: 'itunes-interstellar',
      title: 'Interstellar (Main Theme)',
      artist: 'Hans Zimmer',
      album: 'Interstellar (Original Soundtrack)',
      duration: 240,
      coverUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/7e/c5/5e/7ec55ee2-ebf8-d988-8f9a-431af1047747/artwork.jpg/600x600bb.jpg',
      previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/37/65/ac/3765ac6b-efce-a438-4482-287ea711ee01/mzaf_17061069329183693603.plus.aac.p.m4a',
    },
    {
      id: 'itunes-interstellar-score',
      title: 'Interstellar (Original Score)',
      artist: 'Imperial Orchestra',
      album: 'Cinematic Soundtracks',
      duration: 275,
      coverUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music122/v4/6e/e6/5a/6ee65a66-8501-50d0-9cf9-b0f8387266f8/859764605361_cover.jpg/600x600bb.jpg',
      previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/dc/f4/b4/dcf4b474-5d9c-76fb-c361-36664f641011/mzaf_5472354911620501954.plus.aac.p.m4a',
    },
  ],
};

export class OctaveMusicService {
  /**
   * Searches tracks, artists, and albums from iTunes API.
   */
  static async searchFull(query: string): Promise<OctaveSearchData> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { tracks: [], artists: [], albums: [] };
    }

    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(trimmed)}&entity=song&limit=40`;
      const res = await nativeFetchText(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        timeoutMs: 9000,
      });

      if (res.ok && res.data) {
        const data = JSON.parse(res.data);
        const results = Array.isArray(data.results) ? data.results : [];

        const tracks: MusicTrack[] = results
          .filter((t: any) => t.trackId && t.trackName)
          .map((t: any) => ({
            id: String(t.trackId),
            title: String(t.trackName),
            artist: String(t.artistName || 'Unknown Artist'),
            artistId: t.artistId ? String(t.artistId) : undefined,
            album: String(t.collectionName || ''),
            albumId: t.collectionId ? String(t.collectionId) : undefined,
            duration: Math.round((Number(t.trackTimeMillis) || 0) / 1000),
            coverUrl: String(t.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
            previewUrl: String(t.previewUrl || ''),
          }));

        const seenArtists = new Set<string>();
        const artists: MusicArtist[] = [];
        for (const t of results) {
          if (t.artistId && t.artistName && !seenArtists.has(String(t.artistId))) {
            seenArtists.add(String(t.artistId));
            artists.push({
              id: String(t.artistId),
              name: String(t.artistName),
              pictureUrl: String(t.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
            });
          }
        }

        const seenAlbums = new Set<string>();
        const albums: MusicAlbum[] = [];
        for (const t of results) {
          if (t.collectionId && t.collectionName && !seenAlbums.has(String(t.collectionId))) {
            seenAlbums.add(String(t.collectionId));
            albums.push({
              id: String(t.collectionId),
              title: String(t.collectionName),
              artist: String(t.artistName || ''),
              coverUrl: String(t.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
            });
          }
        }

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
    try {
      const res = await nativeFetchText(`https://itunes.apple.com/lookup?id=${encodeURIComponent(trackId)}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        timeoutMs: 6000,
      });
      if (res.ok && res.data) {
        const data = JSON.parse(res.data);
        const item = data.results?.[0];
        if (item?.previewUrl) return item.previewUrl;
      }
    } catch {}
    return null;
  }

  /**
   * Full-length playback: resolves the track through the YouTube pipeline
   * (YouTube Music search → streamable audio-only URL via Piped/Invidious
   * mirrors). iTunes previews are 30 seconds — this is what makes songs play
   * end-to-end. Returns null when no mirror answers, so the caller can fall
   * back to the 30-second preview.
   */
  static async resolveFullTrackAudio(title: string, artist: string): Promise<string | null> {
    const pickAudio = (detail: { audioTracks?: Array<{ url: string; hasAudio?: boolean }>; playbackUrl?: string } | null | undefined): string | null => {
      if (!detail?.audioTracks && !detail?.playbackUrl) return null;
      const audio = detail.audioTracks?.find((track) => track.hasAudio !== false && track.url);
      return audio?.url || detail.playbackUrl || null;
    };
    try {
      const query = `${title} ${artist}`.trim();
      // 1. YouTube Music-flavoured search, then detail from any tier.
      const music = await flowMusicSearch(query).catch(() => null);
      const song = music?.data.videos.find((video) => !video.live) || music?.data.videos[0];
      if (song) {
        const detail = await flowDetail(song.id).catch(() => null);
        const audio = detail ? pickAudio(detail.data) : null;
        if (audio) return audio;
      }
      // 2. Mirror-tier search fallback (survives YouTube InnerTube blocks).
      if (!song) {
        const search = await flowSearch(query).catch(() => null);
        const video = search?.data.videos.find((video) => !video.live) || search?.data.videos[0];
        if (video) {
          const detail = await flowDetail(video.id).catch(() => null);
          const audio = detail ? pickAudio(detail.data) : null;
          if (audio) return audio;
        }
      }
      // 3. Search succeeded but no audio tracks anywhere — nothing more to try.
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetches artist details, top tracks, and albums.
   */
  static async fetchArtistDetails(artistId: string): Promise<OctaveArtistDetails | null> {
    try {
      const res = await nativeFetchText(`https://itunes.apple.com/lookup?id=${encodeURIComponent(artistId)}&entity=song&limit=25`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        timeoutMs: 9000,
      });

      if (res.ok && res.data) {
        const data = JSON.parse(res.data);
        const results = Array.isArray(data.results) ? data.results : [];
        if (results.length === 0) return null;

        const artistInfo = results[0];
        const artist: MusicArtist = {
          id: String(artistInfo.artistId || artistId),
          name: String(artistInfo.artistName || 'Artist'),
          pictureUrl: String(results[1]?.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
        };

        const topTracks: MusicTrack[] = results
          .filter((item: any) => item.wrapperType === 'track' && item.trackId)
          .map((t: any) => ({
            id: String(t.trackId),
            title: String(t.trackName),
            artist: artist.name,
            duration: Math.round((Number(t.trackTimeMillis) || 0) / 1000),
            coverUrl: String(t.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
            previewUrl: String(t.previewUrl || ''),
          }));

        return { artist, topTracks, albums: [], relatedArtists: [] };
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
      'Top Hits & Chart Toppers': 'Top Hits',
      'Electronic & Synthwave': 'Synthwave',
      'Pop & Vocal Essentials': 'Pop Hits',
      'Anime & Film Soundtracks': 'Anime Soundtrack',
      'Hip-Hop & R&B': 'Hip-Hop Hits',
    };

    try {
      await Promise.all(
        Object.entries(categories).map(async ([section, query]) => {
          try {
            const search = await this.searchFull(query);
            if (search.tracks.length > 0) {
              results[section] = search.tracks.slice(0, 10);
            }
          } catch {}
        })
      );
    } catch {}

    // Fallback: Ensure featured sections are never empty even if offline
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

