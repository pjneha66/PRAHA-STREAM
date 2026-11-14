import { flowDetail, flowMusicHome, flowMusicSearch, flowSearch } from './flowService';
import { fetchMirrorDetail, fetchMirrorMusic, searchMirrorMusic } from './youtubeMirror';
import type { YtVideo } from './youtubeService';

/**
 * SimpMusic-style music data layer (v2, replaces the iTunes/Deezer 30s-preview
 * service). Everything streams full-length from YouTube using the existing
 * extraction pipeline: metadata via the Piped/Invidious mirror tier (with the
 * direct InnerTube tier underneath), audio via `flowDetail().audioTracks`
 * (audio-only stream URLs, best bitrate first). Synced lyrics stay in
 * lyricsService (lrclib LRC).
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
  /** Kept for interface compatibility; YT tracks stream full-length. */
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

/** Human duration ("3:45", "1:02:10") → seconds. */
function durationToSeconds(value?: string): number {
  if (!value) return 0;
  const parts = value.split(':').map((part) => Number(part) || 0);
  if (!parts.length) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

const trackFromVideo = (video: YtVideo, artistId?: string): MusicTrack => ({
  id: video.id,
  title: video.title,
  artist: video.channel || 'Unknown Artist',
  artistId: video.channelId || artistId,
  duration: durationToSeconds(video.duration),
  coverUrl: video.thumbnail || '',
});

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
   * YouTube search (music-filtered): tracks + artists. Direct InnerTube tier
   * with the Piped/Invidious mirror tier as fallback, same as the Flow tab.
   */
  static async searchFull(query: string): Promise<OctaveSearchData> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { tracks: [], artists: [], albums: [] };
    }

    let videos: YtVideo[] = [];
    try {
      const viaMirror = await searchMirrorMusic(trimmed);
      videos = viaMirror.videos;
    } catch {
      videos = [];
    }
    if (!videos.length) {
      try {
        const direct = await flowMusicSearch(trimmed);
        videos = direct.data.videos;
      } catch {
        videos = [];
      }
    }
    if (!videos.length) {
      try {
        const generic = await flowSearch(trimmed);
        videos = generic.data.videos;
      } catch {
        videos = [];
      }
    }

    const tracks = videos
      .filter((video) => !video.live)
      .slice(0, 40)
      .map((video) => trackFromVideo(video));

    // Artists: dedupe by channel name (YT has no album facet in search).
    const seenArtists = new Map<string, MusicArtist>();
    for (const track of tracks) {
      const key = track.artist.toLowerCase();
      if (!seenArtists.has(key)) {
        seenArtists.set(key, {
          id: track.artistId || key,
          name: track.artist,
          pictureUrl: track.coverUrl,
        });
      }
    }

    // Albums: YouTube doesn't expose a real album facet — keep the section empty
    // so the UI can hide it entirely.
    return { tracks, artists: [...seenArtists.values()].slice(0, 16), albums: [] };
  }

  /** Resolves the stream URL for a track by its YouTube id (full-length). */
  static async getAudioStreamUrl(trackId: string, _quality: 'lossless' | 'high' | 'standard' = 'lossless'): Promise<string | null> {
    if (!trackId) return null;
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
   * Full-length playback for a track: resolves audio by id first, then by a
   * metadata search when the track came from a non-YT surface (queue imports).
   */
  static async resolveFullTrackAudio(title: string, artist: string, trackId?: string): Promise<string | null> {
    if (trackId) {
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

  /** Artist "page": top tracks from a channel-name search (SimpMusic-style). */
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
   * Curated home shelves (SimpMusic-style rails) from the YouTube music
   * surface: trending + genre rows via the mirror tier, InnerTube fallback.
   */
  static async fetchFeaturedSections(): Promise<Record<string, MusicTrack[]>> {
    const results: Record<string, MusicTrack[]> = {};
    let home;
    try {
      home = await fetchMirrorMusic();
    } catch {
      try {
        home = (await flowMusicHome()).data;
      } catch {
        home = null;
      }
    }
    if (home?.shelves?.length) {
      for (const shelf of home.shelves.slice(0, 6)) {
        const tracks = shelf.videos.filter((video) => !video.live).slice(0, 12).map((video) => trackFromVideo(video));
        if (tracks.length) results[shelf.title] = tracks;
      }
    }
    if (Object.keys(results).length === 0) {
      // Last resort: genre searches so the home view is never empty.
      const genres: Array<[string, string]> = [
        ['Trending Music', 'trending songs 2026'],
        ['Electronic & Synthwave', 'synthwave essentials'],
        ['Hip-Hop & R&B', 'hip hop hits'],
        ['Anime & Film Soundtracks', 'anime soundtrack'],
        ['Lofi & Chill', 'lofi chill beats'],
      ];
      await Promise.all(genres.map(async ([section, query]) => {
        try {
          const search = await this.searchFull(query);
          if (search.tracks.length) results[section] = search.tracks.slice(0, 10);
        } catch {}
      }));
    }
    return results;
  }
}
