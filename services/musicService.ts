import { nativeFetchText } from './androidBridge';
import { flowDetail, flowMusicSearch, flowSearch } from './flowService';
import { fetchMirrorDetail, searchMirrorMusic } from './youtubeMirror';

/**
 * Music data layer (v3, hybrid). v2 went all-in on the YouTube mirror tier
 * for metadata and starved the Music tab on devices where mirrors are slow or
 * blocked — metadata is now back on the fast key-free public APIs (iTunes +
 * Deezer, as in v2.9) merged with best-effort YouTube results, while playback
 * streams FULL-LENGTH audio through the YouTube pipeline (Flow InnerTube tier
 * → Piped/Invidious mirrors). 30-second previews are the last-resort fallback,
 * not the feature. Synced lyrics stay in lyricsService (lrclib LRC).
 */

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  duration: number; // in seconds
  coverUrl: string;
  /** 30-second fallback when the YouTube full stream cannot be resolved. */
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

/** Offline-safe emergency sections so the home view is never blank. */
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
      previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/57/a5/85/57a585aa-f5bc-881b-f8a4-5591d5f90b9f/mzaf_6906185601163199035.plus.aac.p.m4a',
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
      previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/37/65/ac/3765ac6b-efce-a438-4482-5592a23f0f9e/mzaf_1706106932918369360.plus.aac.p.m4a',
    },
  ],
};

/** Human duration ("3:45", "1:02:10") → seconds. */
function durationToSeconds(value?: string): number {
  if (!value) return 0;
  const parts = value.split(':').map((part) => Number(part) || 0);
  if (!parts.length) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** YT videoId-shaped ids resolve directly; catalog ids go through search. */
function isVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

const pickAudioUrl = (detail: { audioTracks?: Array<{ url: string; bitrate?: number; hasAudio?: boolean }>; playbackUrl?: string } | null | undefined): string | null => {
  if (!detail?.audioTracks && !detail?.playbackUrl) return null;
  const usable = (detail.audioTracks || []).filter((track) => track.hasAudio !== false && track.url);
  if (!usable.length) return detail.playbackUrl || null;
  // Prefer the highest-bitrate audio-only stream (SimpMusic streams at best quality).
  const best = usable.reduce((acc, track) => ((track.bitrate || 0) > (acc.bitrate || 0) ? track : acc), usable[0]);
  return best.url || detail.playbackUrl || null;
};

export class OctaveMusicService {
  /**
   * Track search: iTunes + Deezer (fast, reliable metadata) merged with
   * best-effort YouTube music results deduped by artist+title. The YT tier
   * adds a slow mirror sweep, so `opts.yt: false` skips it for callers that
   * need results fast (home genre rows) or already have YT coverage.
   */
  static async searchFull(query: string, opts?: { yt?: boolean }): Promise<OctaveSearchData> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { tracks: [], artists: [], albums: [] };
    }

    const tracks: MusicTrack[] = [];
    const artists: MusicArtist[] = [];
    const albums: MusicAlbum[] = [];
    const seenArtists = new Set<string>();
    const seenAlbums = new Set<string>();
    const seenTracks = new Set<string>();
    const pushTrack = (track: MusicTrack) => {
      const key = `${track.artist.toLowerCase()}|${track.title.toLowerCase()}`;
      if (seenTracks.has(key)) return;
      seenTracks.add(key);
      tracks.push(track);
      if (!seenArtists.has(track.artist.toLowerCase())) {
        seenArtists.add(track.artist.toLowerCase());
        artists.push({ id: track.artistId || track.artist.toLowerCase(), name: track.artist, pictureUrl: track.coverUrl });
      }
      if (track.album && !seenAlbums.has(track.album.toLowerCase())) {
        seenAlbums.add(track.album.toLowerCase());
        albums.push({ id: track.albumId || track.album.toLowerCase(), title: track.album, artist: track.artist, coverUrl: track.coverUrl });
      }
    };

    // 1. iTunes (primary metadata source — fast, key-free).
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(trimmed)}&entity=song&limit=40`;
      const res = await nativeFetchText(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        timeoutMs: 9000,
      });
      if (res.ok && res.data) {
        const data = JSON.parse(res.data) as Record<string, unknown>;
        const results = Array.isArray(data.results) ? (data.results as Array<Record<string, any>>) : [];
        for (const t of results) {
          if (!t.trackId || !t.trackName) continue;
          pushTrack({
            id: String(t.trackId),
            title: String(t.trackName),
            artist: String(t.artistName || 'Unknown Artist'),
            artistId: t.artistId ? String(t.artistId) : undefined,
            album: String(t.collectionName || ''),
            albumId: t.collectionId ? String(t.collectionId) : undefined,
            duration: Math.round((Number(t.trackTimeMillis) || 0) / 1000),
            coverUrl: String(t.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
            previewUrl: String(t.previewUrl || ''),
          });
        }
      }
    } catch { /* fall through to other sources */ }

    // 2. Deezer second source — wider catalog coverage.
    try {
      const res = await nativeFetchText(`https://api.deezer.com/search?q=${encodeURIComponent(trimmed)}&limit=25`, {
        headers: { Accept: 'application/json' },
        timeoutMs: 8000,
      });
      if (res.ok && res.data) {
        const data = JSON.parse(res.data) as {
          data?: Array<{
            id?: number | string;
            title?: string;
            artist?: { name?: string; picture_medium?: string };
            album?: { title?: string; cover_medium?: string; cover_big?: string; id?: number | string };
            preview?: string;
            duration?: number;
          }>;
        };
        for (const entry of data.data || []) {
          if (!entry.title || !entry.artist?.name) continue;
          pushTrack({
            id: `deezer-${entry.id ?? `${entry.artist.name}-${entry.title}`}`,
            title: String(entry.title),
            artist: String(entry.artist.name),
            album: entry.album?.title ? String(entry.album.title) : undefined,
            duration: Number(entry.duration || 30),
            coverUrl: String(entry.album?.cover_medium || entry.artist.picture_medium || ''),
            previewUrl: String(entry.preview || ''),
          });
        }
      }
    } catch { /* fall through */ }

    // 3. YouTube music search — best-effort merge (real durations/channels).
    if (opts?.yt === false) {
      return { tracks: tracks.slice(0, 40), artists: artists.slice(0, 16), albums: albums.slice(0, 16) };
    }
    try {
      const viaMirror = await searchMirrorMusic(trimmed);
      for (const video of viaMirror.videos.filter((video) => !video.live).slice(0, 25)) {
        pushTrack({
          id: video.id,
          title: video.title,
          artist: video.channel || 'Unknown Artist',
          artistId: video.channelId,
          duration: durationToSeconds(video.duration),
          coverUrl: video.thumbnail || '',
        });
      }
    } catch {
      try {
        const direct = await flowMusicSearch(trimmed);
        for (const video of direct.data.videos.filter((video) => !video.live).slice(0, 25)) {
          const key = `${(video.channel || '').toLowerCase()}|${video.title.toLowerCase()}`;
          if (seenTracks.has(key)) continue;
          seenTracks.add(key);
          tracks.push({
            id: video.id,
            title: video.title,
            artist: video.channel || 'Unknown Artist',
            artistId: video.channelId,
            duration: durationToSeconds(video.duration),
            coverUrl: video.thumbnail || '',
          });
        }
      } catch { /* metadata sources exhausted */ }
    }

    return { tracks: tracks.slice(0, 40), artists: artists.slice(0, 16), albums: albums.slice(0, 16) };
  }

  /** Resolves the stream URL for a track by its id (full-length). */
  static async getAudioStreamUrl(trackId: string, _quality: 'lossless' | 'high' | 'standard' = 'lossless'): Promise<string | null> {
    if (!trackId) return null;
    // Catalog ids (iTunes/Deezer) have no YouTube detail endpoint.
    if (!isVideoId(trackId)) return null;
    try {
      const detail = await flowDetail(trackId);
      const audio = pickAudioUrl(detail.data);
      if (audio) return audio;
    } catch {}
    try {
      const mirror = await fetchMirrorDetail(trackId);
      const audio = pickAudioUrl(mirror);
      if (audio) return audio;
    } catch {}
    return null;
  }

  /**
   * Full-length playback for a track: resolve by video id when the track came
   * from YouTube, otherwise resolve via a YouTube search of title+artist.
   */
  static async resolveFullTrackAudio(title: string, artist: string, trackId?: string): Promise<string | null> {
    if (trackId && isVideoId(trackId)) {
      const byId = await this.getAudioStreamUrl(trackId);
      if (byId) return byId;
    }
    const query = `${title} ${artist}`.trim();
    if (!query) return null;
    try {
      const music = await flowMusicSearch(query).catch(() => null);
      const song = music?.data.videos.find((video) => !video.live) || music?.data.videos[0];
      if (song) {
        const detail = await flowDetail(song.id).catch(() => null);
        const audio = detail ? pickAudioUrl(detail.data) : null;
        if (audio) return audio;
      }
      if (!song) {
        const search = await flowSearch(query).catch(() => null);
        const video = search?.data.videos.find((video) => !video.live) || search?.data.videos[0];
        if (video) {
          const detail = await flowDetail(video.id).catch(() => null);
          const audio = detail ? pickAudioUrl(detail.data) : null;
          if (audio) return audio;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Artist "page": top tracks from a name search. */
  static async fetchArtistDetails(artist: { name: string; id?: string }): Promise<OctaveArtistDetails | null> {
    if (!artist.name) return null;
    const search = await this.searchFull(artist.name);
    const topTracks = search.tracks
      .filter((track) => track.artist.toLowerCase() === artist.name.toLowerCase())
      .concat(search.tracks.filter((track) => track.artist.toLowerCase() !== artist.name.toLowerCase()))
      .slice(0, 20);
    const picture = search.artists.find((entry) => entry.name === artist.name)?.pictureUrl || '';
    return {
      artist: { id: artist.id || artist.name.toLowerCase(), name: artist.name, pictureUrl: picture },
      topTracks: topTracks.length ? topTracks : search.tracks.slice(0, 20),
      albums: [],
      relatedArtists: search.artists.filter((entry) => entry.name !== artist.name).slice(0, 8),
    };
  }

  /**
   * Curated home shelves: YouTube music surface first (real music rails),
   * iTunes genre searches as the reliable fallback, static rows offline.
   */
  static async fetchFeaturedSections(): Promise<Record<string, MusicTrack[]>> {
    const results: Record<string, MusicTrack[]> = {};

    // YouTube trending rail and the iTunes genre rows run CONCURRENTLY —
    // the mirror sweep takes 10s+ on flaky networks and must not block the
    // fast key-free metadata rows behind it.
    const genres: Record<string, string> = {
      'Top Hits & Chart Toppers': 'Top Hits',
      'Electronic & Synthwave': 'Synthwave',
      'Pop & Vocal Essentials': 'Pop Hits',
      'Anime & Film Soundtracks': 'Anime Soundtrack',
      'Hip-Hop & R&B': 'Hip-Hop Hits',
    };

    const trendingPromise = searchMirrorMusic('trending songs 2026')
      .then((mirror) => {
        const trending = mirror.videos.filter((video) => !video.live).slice(0, 12);
        if (trending.length >= 6) {
          results['Trending Music'] = trending.map((video) => ({
            id: video.id,
            title: video.title,
            artist: video.channel || 'Unknown Artist',
            artistId: video.channelId,
            duration: durationToSeconds(video.duration),
            coverUrl: video.thumbnail || '',
          }));
        }
      })
      .catch(() => undefined);

    const genrePromises = Object.entries(genres).map(async ([section, query]) => {
      try {
        // iTunes+Deezer only — no mirror sweep on the home rails.
        const search = await this.searchFull(query, { yt: false });
        const rows = search.tracks.filter((track) => track.previewUrl || isVideoId(track.id)).slice(0, 10);
        if (rows.length) results[section] = rows;
      } catch { /* genre row skipped */ }
    });

    await Promise.all([trendingPromise.catch(() => undefined), ...genrePromises]);

    // Static offline rows — the home view is never blank.
    for (const [key, fallbackTracks] of Object.entries(FALLBACK_FEATURED_SECTIONS)) {
      if (!results[key]?.length) results[key] = fallbackTracks;
    }

    return results;
  }
}
